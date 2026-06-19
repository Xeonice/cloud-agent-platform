# Research Brief — api-key-machine-identity (T1)

> Side-car (not a tracked artifact). Distills the epic exploration that grounds this change.
> Authoritative source: `docs/external-api-mcp-epic.md` (mother doc, §3 / §13 / §16 / §17).
> Two adversarial-verification workflows fed it; this change implements **Track T1** only.

## Where this sits

T1 is the first of the external-API/remote-MCP epic's machine-identity lines. It is the
most independent track and builds the **credential-resolution core** that T3 (MCP OAuth)
later reuses. Per mother-doc §17, T1 closes verified gaps **G4, G5, G9, G10, G11**.
Rate-limiting (G6) and the public `/v1` surface (T0) are **out of scope** — separate changes.

## Locked constraints inherited from the epic

- **D2 shared task pool**: an api-key principal can list/stop any task; accepted. Not a per-key boundary.
- All auth funnels through one transport-agnostic `resolveOperatorPrincipal()` — extend it, do not fork it.
- Mirror the existing `Session` discipline: store only SHA-256 hash of the raw credential; re-confirm
  allowlist membership on EVERY request (login == root-on-host).

## Verified codebase facts (file:line) the design rests on

- `auth/operator-principal.ts:40` PrincipalKind = `'session' | 'legacy-token'`; `:99-130` control flow is
  session-FIRST then a gated constant-time `AUTH_TOKEN` compare; the two slots are never cross-tried.
- `auth/auth.guard.ts:128-134` REST guard passes the whole `Authorization: Bearer` value as the
  `legacyBearerToken` candidate; `:144` attaches `request.operatorPrincipal`.
- `terminal/terminal.gateway.ts:696-697` WS has ONE credential channel: the presented token is passed as
  BOTH `sessionToken` AND `legacyBearerToken`.
- `auth/auth-session.service.ts:120-152` `resolveSession` = hash → findFirst(tokenHash) → `isSessionExpired`
  → `isAllowlistedRaw(user.githubId)` re-check. The exact template for `resolveApiKey`.
- `auth/session-token.ts:41-53` `mintSessionToken` = `randomBytes(32).base64url` + plain SHA-256
  (justified by high-entropy input). Session tokens cannot collide with a reserved prefix.
- `auth/oauth-config.ts` `AUTH_TOKEN` is an operator-chosen free-form env value (only trimmed) — it CAN
  start with a reserved prefix → footgun (G10).
- `tasks/tasks.controller.ts:38-67` create()/stop() do NOT read `operatorPrincipal` and pass no githubId,
  so task creation is system-attributed TODAY even for human sessions (G11 is a pre-existing no-op).
- `audit/audit.service.ts` `recordTaskCreated(taskId, githubId?)` already maps a contracts githubId →
  users.id FK; an api-key action attributes to its owner by passing `owner.githubId`.
- `schema.prisma` `Session` model = the storage shape to mirror (tokenHash unique, userId FK cascade, expiresAt).
- CI (`ci.yml`, per memory `repo-ci-no-tsc-gate-and-mcp-browsers`) runs install → build → typecheck → lint;
  there is NO app-boot/health step. The `persist-session-transcripts` 6h prod outage was a cross-provider
  DI/onApplicationBootstrap ordering bug that build + unit tests did NOT catch (G5 rationale).

## The five gaps this change must close (adversarially verified)

- **G4 (major)** — Prefix dispatch (`cap_sk_` → api-key, `mcp_` → reserved/deny-until-T3, else → session/legacy)
  MUST be the FIRST statement in `resolveOperatorPrincipal`, before the session-first lookup; otherwise the
  WS single-channel token is mis-tried as a session first. Test both REST header and WS channel.
- **G5 (major)** — Add a CI boot-smoke step (start the built app, hit `/health`, fail on DI/boot error) BEFORE
  landing the new module; this is the highest-leverage guard given the DI-outage precedent.
- **G9 (minor)** — `scopes === undefined` on session/legacy principals MUST mean ALLOW-ALL (else every console
  call 403s). `hasScope(p, req)` returns true when `p.scopes` is undefined.
- **G10 (minor)** — Boot-time assertion: `AUTH_TOKEN` must not start with any reserved prefix; refuse to boot
  with a clear error otherwise.
- **G11 (minor)** — Thread `principal.user.githubId` from the controller into `TasksService.create/stop` so
  api-key (and session) actions attribute to the owner, not null.

## Design anchors (full detail in mother-doc §13)

- `resolveOperatorPrincipal` extension: prefix dispatch at top; `OperatorCredentials` keeps a single
  `bearerToken` slot; `OperatorPrincipal` gains `scopes?` and `keyId?`.
- `ApiKey` Prisma model mirrors `Session` (hash-only): userId, tokenHash, prefix, last4, name, scopes[],
  lastUsedAt?, expiresAt?, revokedAt?. `resolveApiKey` = `resolveSession` near-clone + owner allowlist re-check.
  `lastUsedAt` bump is best-effort/async (never blocks the hot path).
- Key body = `randomBytes(32).base64url` so the plain-SHA256 hash justification holds; raw key returned ONCE.
- CRUD endpoints session-only minting (a key cannot mint another key — no escalation chain).
- Shared scope enum in `@cap/contracts`: `tasks:read | tasks:write | repos:read` (future `tasks:execute`).
- `mcp_` branch is wired to an injected resolver that defaults to DENY when unbound (T3 supplies it later) —
  the dispatch slot is reserved now without depending on T3.
