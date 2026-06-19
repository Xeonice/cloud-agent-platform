## Why

The platform's REST surface is shaped for the web console (console-coupled paths, no versioning, no pagination, no idempotency, no machine-facing observation). The external-API/remote-MCP epic (`docs/external-api-mcp-epic.md`) needs a **stable, versioned, documented public API** that external callers (scripts/CI via the T1 API keys) and the in-console API playground (epic B) — and later the MCP tools (T4) — all target. This change builds **Track T0**: an additive, version-prefixed `/v1` surface that delegates to the existing services, so endpoints can evolve (a future `/v2` controller added alongside, `/v1` consumers untouched) without ever touching the console contract. It depends on T1 (the api-key principal + scope funnel), which is already applied.

## What Changes

- **Additive `/v1` controllers** delegating to the SAME existing services (no second admission path): `POST /v1/tasks` (repoId in the BODY + an optional `Idempotency-Key`), `GET /v1/tasks` (keyset-paginated), `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/repos` (paginated), `GET /v1/repos/:id`, `GET /v1/tasks/:id/transcript` (= the durable session-history read). Mounted as plain path-prefixed `@Controller('v1/...')` — NO `app.enableVersioning()` — so the console's unversioned endpoints and the `apps/web` contract stay byte-identical.
- **New `/v1`-only contract schemas** in `@cap/contracts` (create-with-`repoId`, `{items,nextCursor}` paginated envelopes, the idempotency shape) — ADDED alongside, NEVER mutating the console's `CreateTaskRequestSchema`/`ListTasks`/`ListRepos` that `apps/web` imports.
- **OpenAPI 3.1 spec generated from the zod contracts** (`@asteasolutions/zod-to-openapi` v7, the zod-3 line) served at `GET /v1/openapi.json`, with an interactive `GET /v1/docs` (Swagger UI). The controllers validate against the same schemas the spec is built from, so the doc cannot drift from the wire.
- **Keyset (cursor) pagination** on the list endpoints (`?limit=&cursor=`; ordered by `(createdAt,id)`).
- **Idempotency**: an `Idempotency-Key` header on `POST /v1/tasks` deduped via a new `IdempotencyKey` row (per-principal scoped, 24h window, inserted in the SAME transaction as the task so a raced retry cannot double-admit a sandbox).
- **Per-principal request rate limiting** (`@nestjs/throttler` as a SECOND global guard ordered AFTER the auth guard, keyed off the resolved principal — per-api-key / per-owner) PLUS a per-principal **task-creation rate cap** (the concurrency semaphore bounds RUNNING tasks, not CREATED ones, so an unbounded queued backlog is the real abuse surface).
- **SSE async observation**: `GET /v1/tasks/:id/events` streams lifecycle events (`text/event-stream`) sourced from the append-only `AuditEvent` tail (NOT the WS/PTY stream), with a `<90s` keep-alive heartbeat and `Last-Event-ID` resume. **Polling `GET /v1/tasks/:id` remains the GUARANTEED floor**; SSE is the streaming nicety. ⚠️ The live Cloudflare-tunnel SSE path is UNVERIFIED (epic G7: cloudflared buffers GET-SSE; ~100–120s idle timeout) — a one-time `curl -N` 2-minute probe through `cap-api.douglasdong.com` MUST pass before the SSE path is relied upon; the polling floor ships regardless.
- **Auth**: every `/v1` route is auto-guarded by the existing global guard (admitting session AND `api-key` principals via T1's `resolveOperatorPrincipal`); scope gates (T1's `hasScope`) apply (`tasks:read`/`tasks:write`/`repos:read`; a scopeless session principal = allow-all). `GET /v1/openapi.json` + `GET /v1/docs` are EXEMPT (read-only public metadata, like `/version`).
- Out of scope: webhooks (deferred — the SSE/transition seam is the future dispatcher's subscription point); the MCP surface (T3/T4); per-user task ownership (D2 shared pool stays).

## Capabilities

### New Capabilities
- `public-v1-api`: the versioned `/v1` external REST surface — additive controllers delegating to existing services, `/v1`-only contract schemas, OpenAPI-from-zod (`/v1/openapi.json` + `/v1/docs`), keyset pagination, `Idempotency-Key` create dedup, and SSE lifecycle observation (`GET /v1/tasks/:id/events`) over a guaranteed polling floor.
- `request-rate-limiting`: per-principal request rate limiting (a throttler guard ordered after the auth guard) and a per-principal task-creation rate cap, as the public surface's abuse backstop (distinct from the running-task concurrency semaphore).

### Modified Capabilities
- `multi-user-oauth`: the global auth guard exempts `GET /v1/openapi.json` and `GET /v1/docs` as read-only public metadata (the rest of `/v1` stays guarded); the resolved principal + `hasScope` (added in T1) are read by the `/v1` controllers to gate scoped operations.

## Impact

- **Code**: new `apps/api/src/v1/` module (controllers + an OpenAPI registry built from `@cap/contracts`), a rate-limiting module/guard, an SSE controller tailing `AuditEvent`, `auth.guard.ts` (two exempt paths), and the per-principal create-rate cap wired at the create path. `packages/contracts/src/` gains the `/v1`-only DTOs (paginated envelopes, create-with-repoId, idempotency) — additive only.
- **Data**: new `IdempotencyKey` Prisma model + migration; no change to existing tables.
- **Dependencies**: `@nestjs/throttler`, `@asteasolutions/zod-to-openapi` (pin **v7**, the zod-3 line — installed zod is 3.25.76; zod 4 is also in the tree so v8 is wrong), and a Swagger-UI asset for `/v1/docs`.
- **Deploy**: nginx is already SSE-friendly (`proxy_buffering off`, 3600s timeouts); the Cloudflare-tunnel SSE path needs the G7 live probe; the in-memory rate-limit store is fine for the single-node resident deployment. The CI boot-smoke (added in T1) guards the new modules.
- **Auth surface**: `/v1` is reachable by session (console / the playground) and `api-key` (external) principals; the console's unversioned endpoints are unchanged.
