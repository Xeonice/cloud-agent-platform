## Context

The platform authenticates only humans: a GitHub-OAuth session cookie resolved through `AuthSessionService.resolveSession`, plus an off-by-default shared `AUTH_TOKEN`. All auth funnels through one transport-agnostic decision point, `resolveOperatorPrincipal()` (`apps/api/src/auth/operator-principal.ts`), used by both the REST guard (`auth.guard.ts`) and the WS handshake (`terminal.gateway.ts`). It keeps trust domains apart by credential SLOT — `sessionToken` vs `legacyBearerToken`, never cross-tried — but it has only two slots and the bearer slot is hard-wired to the constant-time `AUTH_TOKEN` compare.

This change adds **API keys** (`cap_sk_…`) as the first machine-identity line of the external-API/remote-MCP epic, and builds the **credential-resolution core** the later MCP track reuses. It is Track T1 of the epic; the authoritative design context, including the adversarial-verification findings, lives in `docs/external-api-mcp-epic.md` (§3, §13, §16, §17) and the change-local `research-brief.md`. Out of scope here: the public `/v1` surface (T0), request rate-limiting (T2), and the MCP authorization server / `resolveMcpToken` (T3) — this change only reserves the `mcp_` dispatch slot.

Key codebase facts grounding the design: `resolveSession` (`auth-session.service.ts:120-152`) is the exact template (hash → lookup → expiry → allowlist re-check); `mintSessionToken` (`session-token.ts:41-53`) is `randomBytes(32).base64url` + plain SHA-256; the WS channel passes one token to BOTH slots (`terminal.gateway.ts:696-697`); the task controller does NOT read the attached principal today, so task creation is system-attributed even for sessions (`tasks.controller.ts:38-67`); `AUTH_TOKEN` is operator-chosen free-form (`oauth-config.ts`); CI has no app-boot step.

## Goals / Non-Goals

**Goals:**
- A per-user, revocable, attributable machine credential, stored hash-only, with the same allowlist-re-check discipline as sessions.
- Extend `resolveOperatorPrincipal` with token-prefix dispatch so four credential domains (session, legacy, api-key, reserved-mcp) coexist on `Authorization: Bearer`/the WS channel with no cross-domain mis-try and no constant-time regression.
- A shared scope model enforced at the route boundary as 403, back-compatible (scopeless = allow-all).
- Close the verified gaps G4 (dispatch ordering), G5 (CI boot smoke), G9 (scope undefined = allow), G10 (AUTH_TOKEN prefix assertion), G11 (audit attribution threading).

**Non-Goals:**
- Request rate-limiting / create-backlog caps (T2) — an api-key here authenticates the same operator-guarded surface a session does, so the abuse surface is unchanged until the public `/v1` surface lands.
- The public `/v1` REST surface and pagination/idempotency (T0).
- The MCP OAuth authorization server and `resolveMcpToken` (T3) — only the `mcp_` slot is reserved.
- Per-key task ownership/isolation — the task pool stays shared (epic D2).

## Decisions

### D1 — Token-prefix dispatch is the FIRST step of `resolveOperatorPrincipal`
Route by a public, non-secret token prefix before any resolver runs: `cap_sk_` → `resolveApiKey` only; `mcp_` → the injected MCP resolver only (denies until T3 binds it); anything else → the existing session-then-legacy flow unchanged.

- **Why first**: the WS channel supplies the same presented token to both the session and legacy candidates (`terminal.gateway.ts:696-697`), and resolution is session-first. If dispatch were placed after the session attempt, a `cap_sk_`/`mcp_` token would first hit the `Session` table lookup. Placing dispatch at the very top guarantees each domain is reachable by exactly one prefix on both transports (closes G4).
- **Alternative considered**: a new dedicated `apiKeyToken` credential slot filled by the guard (like `sessionToken`). Rejected: the WS channel has only one credential field, so the guard cannot know which slot to fill without inspecting the prefix anyway — the prefix decision belongs inside `resolveOperatorPrincipal` as the single place both transports funnel through, avoiding REST/WS drift.
- **Constant-time**: each domain still does its own hash-lookup or `constantTimeEqual`; the prefix branch leaks nothing (it is not a secret).

### D2 — `ApiKey` model mirrors `Session`, resolution mirrors `resolveSession`
New `ApiKey` Prisma model: `userId` (FK cascade), `tokenHash` (SHA-256, unique-indexed), `prefix`, `last4`, `name`, `scopes String[]`, `lastUsedAt?`, `expiresAt?`, `revokedAt?`. `resolveApiKey(raw)` = hash → `findFirst({tokenHash})` → reject revoked/expired → `isAllowlistedRaw(owner.githubId)` re-check → `{user, scopes, keyId}`.

- **Why**: reuses proven primitives (`hashSessionToken`, `isSessionExpired`, `isAllowlistedRaw`) and inherits the load-bearing per-request allowlist re-confirmation for free (a de-allowlisted owner's key dies on its next call).
- **Key body** = `randomBytes(32).base64url` so plain SHA-256 (no slow KDF) is sound for the high-entropy input, identical to the session-token justification.
- **`lastUsedAt`** bump is best-effort/async and staleness-throttled so it never blocks or fails the hot auth path (mirrors the audit recorder's best-effort discipline).
- **Alternative considered**: reuse the `Session` table with a discriminator. Rejected: conflates browser sessions with machine keys for revocation/audit/listing and muddies the show-once vs cookie lifecycle.

### D3 — Scopes live on the principal; `undefined` means allow-all
Add `scopes?: Scope[]` and `keyId?` to `OperatorPrincipal`. Define `ScopeSchema = z.enum(['tasks:read','tasks:write','repos:read'])` in `@cap/contracts` (shared with the future MCP track). A `hasScope(principal, required)` helper returns `true` when `principal.scopes` is `undefined`.

- **Why undefined = allow-all (G9)**: session and legacy principals carry no scopes; if `undefined` meant deny, every existing console call would 403. The default-allow must be pinned and tested (a session principal passes every gate; an api-key with only `tasks:read` is 403'd on a `tasks:write` route).
- **403 vs 401**: insufficient scope is 403; an absent/invalid credential is 401. Keep them distinct.

### D4 — CRUD is session-only; audit attribution is threaded through the controller
API-key mint/list/revoke are reachable only by a `session` principal (an api-key cannot mint another key — no escalation chain). Separately, the task controller will read `(req).operatorPrincipal?.user?.githubId` and pass it to `TasksService.create/stop`.

- **Why thread attribution now (G11)**: the controller already has the attached principal but ignores it, so task creation is system-attributed today even for humans. The service methods already accept an optional `githubId`; only the controller wiring is missing. Fixing it here benefits sessions too and is required for api-key attribution to mean anything.

### D5 — Boot-time `AUTH_TOKEN` reserved-prefix assertion (G10)
At bootstrap, when `AUTH_TOKEN` is configured, refuse to boot if it begins with a reserved prefix (`cap_sk_`, `mcp_`), with a clear error — placed beside the existing legacy-token boot check in `main.ts`.

- **Why**: unlike random session tokens, `AUTH_TOKEN` is operator-chosen and could start with a reserved prefix, which would silently route it to a machine resolver (hash miss → null) and never reach its constant-time compare, breaking legacy operator auth.

### D6 — CI boot-smoke gate (G5)
Add a CI step that starts the built app against a throwaway Postgres and probes `/health`, failing on a bootstrap/DI error; make it a required check, landed before the new module.

- **Why**: this epic adds a new module (and later more); the cross-provider DI/onApplicationBootstrap ordering class previously caused a ~6h production outage that build + unit tests did not catch. A boot-smoke is the single highest-leverage guard against re-occurrence.
- **Alternative considered**: rely on existing typecheck/lint/unit gates. Rejected — they provably missed the prior outage (the failure only manifests at DI graph instantiation / bootstrap).

## Risks / Trade-offs

- **Dispatch placed after session lookup** → cross-domain mis-try / Session DB hit for machine tokens on WS. → Mitigation: dispatch is the first statement; tests assert `cap_sk_`/`mcp_` on both REST header and WS channel never produce a Session lookup (resolve to api-key/mcp or null).
- **`AUTH_TOKEN` collides with a reserved prefix** → silent legacy-auth breakage. → Mitigation: D5 boot assertion refuses to start.
- **Scope default inverted** (`undefined` = deny) → every console call 403s. → Mitigation: D3 pins allow-all with explicit tests for a scopeless session principal.
- **New module triggers the DI crash-loop class** → boot failure missed by build/unit tests. → Mitigation: D6 CI boot-smoke, required, landed first.
- **`lastUsedAt` write on the hot path** → added latency / failure coupling. → Mitigation: best-effort, async, staleness-throttled.
- **Shared pool (D2 epic)**: an api-key with `tasks:write` can stop any task; audit attributes the stop to the key owner, not the task creator. → Accepted shared-pool semantics; documented, not mitigated.
- **Hash assumption**: plain SHA-256 is sound only for high-entropy keys. → Mitigation: mandate `randomBytes(32).base64url` for the key body.

## Migration Plan

1. Land the **CI boot-smoke** step first (D6), as a required check — it guards everything after.
2. Add the `ApiKey` Prisma model + migration (`prisma migrate` runs pre-boot at container start; the new model FKs cleanly into `users.id`, no change to existing tables).
3. Extend contracts (`ScopeSchema`, api-key DTOs), then `operator-principal.ts` (prefix dispatch + principal shape), then `resolveApiKey`, then the guard/gateway wiring, the boot assertion, the controller attribution, and the CRUD endpoints + web settings card.
4. **Rollback**: the feature is additive and inert until a key is minted. Reverting the code restores two-slot resolution; the `ApiKey` table can be left in place (unused) or dropped by a down-migration. No existing credential path changes, so a rollback cannot lock out human operators.

## Open Questions

- Default scope on key creation: empty (deny-all) vs `tasks:read` only vs explicit selection. Recommendation: explicit selection in the mint dialog, defaulting to `tasks:read`.
- Whether to enforce `tasks:write`/`tasks:read`/`repos:read` on the EXISTING console endpoints now, or only stamp scopes onto the principal and defer route-level enforcement to the T0 `/v1` surface. Recommendation: implement `hasScope` + enforce on the task create/stop/list and repo list routes now (so api-keys are genuinely scope-limited), since those are the operations an api-key can already reach.
- Reserved-prefix list location: a shared constant in `@cap/contracts` (so the boot assertion, dispatch, and minting agree on one source). Recommendation: yes, single source.
