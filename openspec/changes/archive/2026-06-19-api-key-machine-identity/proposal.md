## Why

The platform authenticates only humans today: a GitHub-OAuth session cookie, plus an off-by-default shared `AUTH_TOKEN`. There is no per-user, revocable, attributable machine credential, so scripts, CI, and (later) the remote MCP server have no first-class way to call the API. This change adds **API keys** as the first machine-identity line of the external-API/remote-MCP epic, and — critically — builds the **credential-resolution core** (token-prefix dispatch through the single `resolveOperatorPrincipal` funnel) that the later MCP-OAuth track reuses. It is the most independent track and is done first so its disambiguation core, allowlist re-check discipline, and scope model are settled before anything depends on them.

## What Changes

- Add **API keys**: an allowlisted operator mints a `cap_sk_`-prefixed key (raw value shown **once**), stored as a SHA-256 hash only, owner-scoped, with selectable scopes, optional expiry, and revocation.
- Extend `resolveOperatorPrincipal` with **token-prefix dispatch** as its first step: `cap_sk_` → API-key introspection, `mcp_` → a reserved MCP slot (injected later by the MCP track; denies until bound), any other bearer → the existing session/legacy paths unchanged. This keeps the four credential domains unambiguous and preserves the no-cross-domain-mis-try and constant-time properties on BOTH the REST header and the single WS channel.
- Introduce a shared **scope model** (`tasks:read | tasks:write | repos:read`) on the operator principal, enforced at the route/tool boundary as 403 (distinct from 401). Session/legacy principals carry no scopes and are treated as **allow-all** for backward compatibility.
- **API-key CRUD** (session-authenticated only — a key cannot mint another key): create, list (prefix + last4 only, never the raw key or hash), revoke.
- **Audit attribution**: thread the resolved principal's owner `githubId` from the task controller into the task service so API-key (and, for the first time, session) task actions attribute to a user instead of the system sentinel.
- **Boot-time safety**: refuse to start when `AUTH_TOKEN` begins with a reserved credential prefix (it is operator-chosen and could otherwise be silently mis-routed away from the legacy compare).
- **CI boot-smoke gate**: add a CI step that boots the built application and probes `/health`, failing on a DI/bootstrap error — a guard against the cross-provider dependency-injection failure class that previously caused a multi-hour production outage and which neither the build nor the unit tests caught.
- Out of scope (later changes): the public `/v1` surface (T0), request rate-limiting + create-backlog caps (T2), the MCP OAuth authorization server and `resolveMcpToken` (T3). This change only reserves the `mcp_` dispatch slot.

## Capabilities

### New Capabilities
- `api-key-auth`: API-key machine identity — minting (show-once), hash-only owner-scoped storage, per-request resolution with allowlist re-confirmation, expiry/revocation, session-only CRUD, and the shared scope model with route/tool-boundary enforcement.

### Modified Capabilities
- `multi-user-oauth`: extend operator-principal resolution with token-prefix dispatch (placed before the session lookup), the `api-key` principal kind and a reserved `mcp` slot, scopes on the principal, the `AUTH_TOKEN` reserved-prefix boot assertion, and principal-driven audit attribution from the task controller.
- `monorepo-foundation`: add a CI boot-smoke check that starts the built app and probes `/health`, failing the pipeline on a bootstrap/DI error.

## Impact

- **Code**: `apps/api/src/auth/` (`operator-principal.ts`, `auth.guard.ts`, new `api-key.service`/`api-keys.controller`, `oauth-config.ts` boot assertion), `apps/api/src/terminal/terminal.gateway.ts` (WS credential path), `apps/api/src/tasks/tasks.controller.ts` (thread githubId), `apps/api/src/main.ts` (boot assertion), `packages/contracts/src/` (scope schema + api-key DTOs), `apps/web` settings (an "API Keys" card to mint/list/revoke).
- **Data**: new `ApiKey` Prisma model (+ a migration); FK to `users.id` with cascade. No change to existing tables.
- **CI/CD**: new boot-smoke job/step in `.github/workflows/ci.yml`, set as a required check.
- **Auth surface**: REST `Authorization: Bearer` and the WS handshake channel now recognize `cap_sk_` keys; the existing session-cookie and legacy `AUTH_TOKEN` paths are behaviorally unchanged. The `mcp_` prefix is reserved but inert until the MCP track binds its resolver.
- **Dependencies**: none required by this change (rate-limiting deps land with T2). Scope enforcement and prefix dispatch are net-new but reuse the existing crypto/allowlist primitives.
