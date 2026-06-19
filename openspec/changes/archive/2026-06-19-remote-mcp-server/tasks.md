<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a track run serially. -->
<!--
  G2 RESOLVED (pre-apply): `@modelcontextprotocol/sdk` (v1.x) is INSTALLED and the
  EXACT v1.x single-package import subpaths are VERIFIED (require() succeeds) — use
  THESE verbatim, NOT the v2-alpha `@modelcontextprotocol/express`/`node` split:
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
    import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
    import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
-->


## 1. Track: data-model (depends: none)
<!-- files: apps/api/prisma/schema.prisma, apps/api/prisma/migrations/** (exclusive) -->

- [x] 1.1 Add the `McpToken` Prisma model mirroring `ApiKey` (hash-only): `userId` FK cascade, `tokenHash` unique-indexed, `prefix`, `last4`, `name`, `scopes String[]`, `lastUsedAt?`, `expiresAt?`, `revokedAt?`; add a `mcpServerEnabled Boolean @default(false)` column to `SystemSettings`.
- [x] 1.2 Generate the migration; verify it applies cleanly, FKs into `users.id`, and leaves existing tables/rows unchanged (the new column defaults false).

## 2. Track: contracts (depends: none)
<!-- files: packages/contracts/src/mcp-token.ts (new), packages/contracts/src/index.ts (export line), packages/contracts/src/settings.ts (mcpServerEnabled shape) (exclusive) -->

- [x] 2.1 Add MCP-token DTOs to `@cap/contracts` (reusing the shared `ScopeSchema`): mint request (name, scopes, optional expiry), mint response (show-once raw `mcp_` token + metadata), list-item (id, name, scopes, prefix, last4, lastUsedAt, expiresAt, revokedAt — NO raw/hash), revoke; plus the `mcpServerEnabled` settings shape.

## 3. Track: mcp-auth-core (depends: contracts, data-model)
<!--
  REBALANCE: the ENTIRE mcp-tokens/ credential module (service + CRUD controller + module
  file) is consolidated here — api-keys/ precedent bundles service+controller in ONE module,
  so splitting the service (was 3.1) from the CRUD controller (was 5.1) would make
  mcp-tokens.module.ts a cross-track shared file. Original 5.1 → 3.6, and the CRUD-escalation
  half of original 5.3 → 3.7. Track 5 keeps only the SETTINGS toggle (disjoint files).
  files: apps/api/src/mcp-tokens/mcp-tokens.service.ts + mcp-tokens.controller.ts +
  mcp-tokens.module.ts + *.spec.ts (NEW dir, mirrors api-keys/ — sole owner),
  apps/api/src/auth/auth-session.service.ts (add resolveMcpToken next to resolveApiKey),
  apps/api/src/auth/auth.guard.ts (bind mcp_ slot via resolveMcp + exact-match /mcp
  session-exemption), apps/api/src/auth/auth.module.ts (export wiring),
  apps/api/src/auth/*.spec.ts (new). Exclusive to this track; auth.guard.ts is NOT touched by
  any other track (7.2 registers requireBearerAuth in main.ts/app.module.ts, not the guard).
-->

- [x] 3.1 Add the `McpToken` service: mint (`randomBytes(32).base64url` body with the `mcp_` prefix, returns raw ONCE), list (prefix + last4 only), revoke (idempotent `revokedAt`); store only the SHA-256 hash; `lastUsedAt` bump best-effort/async.
- [x] 3.2 Add `resolveMcpToken(rawToken)` = hash → `findUnique({tokenHash})` → reject revoked/expired → `isAllowlistedRaw(owner.githubId)` re-check → return a FULL `AuthInfo` `{ token, clientId: 'settings', scopes, expiresAt, resource: canonical /mcp URI }` (G1: a missing `expiresAt` makes `requireBearerAuth` 401 every valid token).
- [x] 3.3 Bind `resolveMcpToken` into the reserved `mcp_` slot of `resolveOperatorPrincipal` (replace the deny-until-bound default) so a `mcp_` credential resolves to an `mcp` principal carrying owner + scopes (still prefix-routed to exactly that domain).
- [x] 3.4 Exempt `/mcp` (EXACT-MATCH) from the session guard in `auth.guard.ts`, keeping it gated downstream by `requireBearerAuth`.
- [x] 3.5 Tests: a valid non-expired token resolves to a full `AuthInfo` (expiresAt + scopes) and is admitted by `requireBearerAuth`; a de-allowlisted owner is rejected on next call; a `mcp_` token resolves to an `mcp` principal (never tried as session/legacy/api-key); `/mcp` is 401 without a bearer while a `/v1` data route also stays 401.
- [x] 3.6 (was 5.1) Add the MCP-token CRUD endpoints in `mcp-tokens.controller.ts` (session-authenticated ONLY — a machine credential cannot mint/list/revoke): mint (raw `mcp_` once), list (prefix + last4), revoke. Registered in `mcp-tokens.module.ts` alongside the 3.1 service (one module owns both, like `ApiKeysModule`).
- [x] 3.7 (was 5.3, CRUD half) Tests: an `mcp`/`api-key` principal is 403 on the MCP-token CRUD (no escalation); list never leaks the raw token/hash.

## 4. Track: mcp-endpoint-tools (depends: mcp-auth-core)
<!--
  files: apps/api/src/mcp/mcp.controller.ts, mcp.server.ts (tool registration), mcp-tools.ts,
  mcp.module.ts, mcp.*.spec.ts (NEW dir, distinct from mcp-tokens/ — sole owner). Delegates to
  existing TasksService/ReposService/SessionTranscriptService (read-only imports — NOT edited
  here, reached via their exported modules imported into mcp.module.ts). Reads
  SystemSettings.mcpServerEnabled DIRECTLY via PrismaService inside this module (4.3) — does
  NOT import settings.service.ts (keeps Track 5 disjoint). Does NOT edit app.module.ts/main.ts
  (Track 7 / 7.2 owns the AppModule import + the requireBearerAuth middleware + CORS in
  main.ts). Exclusive to this track.
-->

- [x] 4.1 Mount the official `@modelcontextprotocol/sdk` (v1.x) `StreamableHTTPServerTransport` (stateless, `sessionIdGenerator: undefined`, `enableJsonResponse`) on a `/mcp` Nest/Express route (POST/GET/DELETE), passing pre-parsed `req.body`; one `McpServer` (tools registered once), transport per request; coexists with `WsAdapter` + the global JSON parser. Pin v1.x import subpaths (verified in Track 7 / G2).
- [x] 4.2 Implement the 6 tools delegating to the existing services with per-tool scope gates: `create_task` (tasks:write, returns a handle immediately — never blocks), `get_task` (tasks:read), `list_tasks` (tasks:read), `stop_task` (tasks:write), `get_transcript` (tasks:read, durable session-history read), `list_repos` (repos:read); missing scope → MCP error with 403-semantics; no standalone provisioning path; never expose the raw PTY/WS stream.
- [x] 4.3 Gate the whole `/mcp` surface on `SystemSettings.mcpServerEnabled` (default false), read directly via `PrismaService` within this module: when off, `/mcp` does not serve MCP traffic and no `mcp_` token resolves a usable session there.
- [x] 4.4 Tests: a `tasks:read`-only mcp principal is denied `create_task`/`stop_task`; tools dispatch to the same services as the console; `create_task` returns a handle without blocking; with `mcpServerEnabled=false` the endpoint is inert.

## 5. Track: settings-backend (depends: data-model, contracts)
<!--
  REBALANCE: original 5.1 (MCP-token CRUD) + the CRUD half of 5.3 moved to Track 3 (they
  share mcp-tokens.module.ts with the 3.1 service). This track now owns ONLY the
  mcpServerEnabled toggle on the settings surface — disjoint files from every other track.
  depends dropped mcp-auth-core (the toggle uses existing isAdminPrincipal + the data-model
  column only; it does NOT touch resolveMcpToken/the credential module).
  files: apps/api/src/settings/settings.controller.ts (add admin-gated mcpServerEnabled
  read/write), apps/api/src/settings/settings.service.ts (SystemSettings.mcpServerEnabled
  read/upsert beside maxConcurrentTasks), apps/api/src/settings/settings.module.ts (if needed),
  apps/api/src/settings/*.spec.ts (new). Reuses apps/api/src/auth/admin.ts (isAdminPrincipal —
  read-only import, NOT edited). Exclusive across tracks.
-->

- [x] 5.2 Add the `mcpServerEnabled` toggle endpoint (admin-gated read/write on `SystemSettings` via the existing `isAdminPrincipal`), mirroring the existing admin-gated settings pattern.
- [x] 5.3 (admin half) Tests: only an admin may flip `mcpServerEnabled` (a non-admin session and a machine principal are 403); the read surfaces the current flag.

## 6. Track: web-settings (depends: contracts)
<!--
  files (all apps/web, disjoint from every backend track): apps/web/src/components/settings/
  mcp-server-card.tsx (new — mirrors api-keys-card.tsx: mint show-once dialog / list / revoke +
  toggle + endpoint URL/instructions), apps/web/src/routes/_app/settings.tsx (mount the new
  section beside <ApiKeysCard/>), apps/web/src/lib/api/capabilities.ts (add an `mcpServer` flag),
  apps/web/src/lib/api/mock.ts (mockMint/List/RevokeMcpToken + mcpServerEnabled, mirrors the
  api-key mocks), apps/web/src/lib/api/real.ts (real /mcp-tokens + settings toggle calls),
  apps/web/src/lib/api/queries.ts + mutations.ts (query/mutation hooks), *.test.ts (new).
  Consumes @cap/contracts types only (depends: contracts). Exclusive across tracks.
-->

- [x] 6.1 Add a "MCP Server" section to the `apps/web` settings page: the `mcpServerEnabled` toggle (admin-gated), the `/mcp` endpoint URL + connect instructions (paste the `mcp_` token into the client `Authorization` header), and an MCP-token card (mint show-once dialog / list prefix+last4 / revoke) — wired through the real/mock api seam, with the show-once raw token coming from the server response (never client-fabricated).

## 7. Track: integration (depends: data-model, contracts, mcp-auth-core, mcp-endpoint-tools, settings-backend)
<!--
  files (the cross-track SHARED edits, serialized here after all parallel tracks):
  apps/api/src/app.module.ts (register McpTokensModule from Track 3 + McpModule from Track 4 —
  this single AppModule edit is the one file both backend feature tracks would otherwise both
  touch, so it is isolated here), apps/api/src/main.ts (mount requireBearerAuth on /mcp +
  route-scoped non-credentialed CORS), docs (connect config + canonical /mcp URI). 7.1 already
  DONE. SettingsModule is already registered in AppModule (Track 5 only edits its internals),
  so no AppModule edit is needed for Track 5.
-->

- [x] 7.1 DONE (pre-apply): `@modelcontextprotocol/sdk` (v1.x) installed into `apps/api`; the v1.x single-package import subpaths VERIFIED via `node -e require(...)` — `server/mcp.js`→`McpServer`, `server/streamableHttp.js`→`StreamableHTTPServerTransport`, `server/auth/middleware/bearerAuth.js`→`requireBearerAuth`, `server/auth/types.js`→`AuthInfo` (type). Use these verbatim (see the header note); NOT the v2-alpha `@modelcontextprotocol/express`.
- [x] 7.2 Wire both new feature modules into `AppModule` (the `McpTokensModule` from Track 3 + the `McpModule` from Track 4 — this single `app.module.ts` edit is isolated here because it is the one file both backend feature tracks would otherwise both touch); register `requireBearerAuth({ verifier: { verifyAccessToken: resolveMcpToken } })` as Express middleware on `/mcp` (its 401 ends the request — no OAuth discovery header needed in the settings-minted model); add route-scoped bearer-only / non-credentialed CORS for `/mcp` in `main.ts` (never add an MCP-client origin to the console's credentialed CORS).
- [x] 7.3 Confirm the CI boot-smoke passes with the new module loaded; document the canonical `/mcp` resource URI + the per-client connect config (Cursor mcp.json header / VS Code / mcp-remote).
- [ ] 7.4 **Deploy-time acceptance (requires the live tunnel + `mcpServerEnabled=on`)**: mint a token in settings, paste it into Claude Desktop / Cursor as the `Authorization` bearer, and confirm an end-to-end `tools/list` + `create_task` round-trip through `cap-api.douglasdong.com/mcp`. Record the result; if a client cannot pass a static bearer header, document the limitation. (PENDING: cannot run in-repo — needs the deployed tunnel + an admin enabling `mcpServerEnabled`; all the code + the in-process tests are green.)
