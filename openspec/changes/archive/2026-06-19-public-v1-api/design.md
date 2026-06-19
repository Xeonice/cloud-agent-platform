## Context

The REST surface is console-shaped (e.g. `POST /repos/:repoId/tasks`, unpaginated `GET /tasks`, no idempotency, WS-only observation). Track T0 of the external-API/remote-MCP epic (`docs/external-api-mcp-epic.md` §12/§14/§16) builds a stable, versioned, documented `/v1` surface that the T1 api-keys, the in-console playground (epic B), and later MCP (T4) all target. It depends on T1 (`api-key-machine-identity`) — the `api-key` principal kind, the credential funnel, `hasScope`, and the CI boot-smoke — all already applied in the tree. Codebase facts the design rests on were verified in the epic's T0/T2 lanes (additive-controller feasibility, the `transition()` chokepoint + append-only `AuditEvent` as the SSE seam, the durable container-independent transcript read, zero existing throttler/openapi deps, nginx already SSE-friendly).

## Goals / Non-Goals

**Goals:**
- An additive `/v1` surface that delegates to the existing services so endpoints can evolve (`/v2` added alongside later) without ever touching the console contract.
- A zod-derived OpenAPI doc that cannot drift from the wire.
- Machine-facing observation: a guaranteed polling floor PLUS an SSE lifecycle stream.
- Pagination + idempotency + per-principal rate limiting as the public-surface hardening.

**Non-Goals:**
- Webhooks (deferred — the transition/SSE seam is the future dispatcher's subscription point).
- The MCP surface (T3/T4) and per-user task ownership (D2 shared pool stays).
- Mutating any console endpoint or `apps/web` contract.

## Decisions

### D1 — Additive `@Controller('v1/...')`, delegate to the same services, no framework versioning
New `v1` controllers inject and call the SAME `TasksService` / `ReposService` / transcript store the console uses; do NOT call `app.enableVersioning()`. The console's unversioned endpoints stay byte-identical and there is exactly one task-admission path.
- **Why**: additive path-prefix is the surgical, non-breaking move (consistent with the existing `/v1/approvals`); `enableVersioning()` would retrofit the whole surface and risk the console contract. `/v2` later is just another controller.

### D2 — `/v1`-only contract schemas, additive
The adapted shapes (create with `repoId` in the body, `{items,nextCursor}` envelopes, idempotency) are NEW `@cap/contracts` schemas, never mutations of the console's `CreateTaskRequestSchema`/list schemas that `apps/web` imports.
- **Why**: the console + web stay untouched; a generation test asserts the console schemas are byte-unchanged.

### D3 — OpenAPI from zod via `@asteasolutions/zod-to-openapi` **v7** (zod-3 line)
One `OpenAPIRegistry` built from the `@cap/contracts` exports; `extendZodWithOpenApi(z)` called once (outside contracts, on the same z instance); served at `GET /v1/openapi.json` + `GET /v1/docs` (Swagger UI), both auth-exempt.
- **Why / pin**: installed zod is 3.25.76 and zod 4.4.3 is also in the tree — pin **v7** (zod-3), NOT v8 (zod-4). The controllers validate against the same registered schemas, so the doc can't drift; a test asserts every `/v1` route's schema is registered.

### D4 — Keyset (cursor) pagination ordered by `(createdAt, id)`
`?limit=&cursor=` with an opaque base64 cursor of `(createdAt,id)`; `WHERE (createdAt,id) > cursor ORDER BY createdAt,id LIMIT n+1`; default 50, max 200.
- **Why**: `createdAt` alone is not unique and would drop/duplicate rows at page boundaries under the mutating shared pool; the unique tuple is stable. Console's unbounded `GET /tasks` is left as-is.

### D5 — Idempotency via a per-principal `IdempotencyKey` row, same-transaction
`Idempotency-Key` header → `IdempotencyKey{ key, scopeUserId, requestHash, taskId, expiresAt(+24h), @@unique([scopeUserId,key]) }`, INSERTED in the same transaction as `task.create`. Same key + same body → same task; same key + different body → 409.
- **Why**: the same-txn unique insert is what makes a raced retry unable to double-admit a sandbox; per-principal scope avoids cross-key collisions while the task POOL stays shared (D2).

### D6 — SSE over the `AuditEvent` tail, with polling as the guaranteed floor
`GET /v1/tasks/:id/events` (`text/event-stream`) tails the append-only `AuditEvent` (`@@index[taskId,timestamp]`) — NOT the WS/PTY stream (which is gateway/lease/container-coupled). Each event carries an id (`Last-Event-ID` resume); a `<90s` heartbeat; headers `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`; closes on a terminal event. Polling `GET /v1/tasks/:id` is the guaranteed floor.
- **Why / G7 risk**: the WS/PTY stream is not what programmatic callers need; the `transition()` chokepoint + AuditEvent is a clean, container-independent seam. ⚠️ The Cloudflare tunnel buffers GET-SSE (cloudflared #1449) and has a ~100–120s idle timeout — so the heartbeat is mandatory AND a one-time `curl -N` 2-minute probe through `cap-api.douglasdong.com` MUST pass before the SSE path is relied upon. The polling floor ships regardless of the probe.

### D7 — Rate limiting: throttler as a SECOND global guard AFTER the auth guard + a create-rate cap
`@nestjs/throttler` registered as a second `APP_GUARD` ordered AFTER the auth guard, keyed off `req.operatorPrincipal` (per-api-key / per-owner), in-memory store. A stricter create-rate cap (`@Throttle`) on `POST /v1/tasks`.
- **Why**: global guard order = provider registration order, so it must come after the auth guard or it falls back to per-IP and per-key limits silently don't apply; the running-task semaphore bounds RUNNING not CREATED tasks, so the create-rate cap is the real backlog/abuse backstop.

### D8 — Build on T1; the CI boot-smoke guards the new modules
Reuse the `api-key` principal, the credential funnel, and `hasScope` from T1; the `/v1` controllers read the attached principal and gate scoped ops. The CI boot-smoke (T1) covers the new V1 / rate-limit modules against the DI-ordering crash class.

## Risks / Trade-offs

- **Cloudflare buffers/kills GET-SSE** (G7) → SSE appears hung. → Mitigation: mandatory `<90s` heartbeat + no-buffer headers + a live `curl -N` probe before relying on it; polling floor is the guarantee.
- **Throttler registered before the auth guard** → keys on IP, per-key limits silently inert. → Mitigation: D7 ordering + a test asserting two keys from one IP get independent buckets.
- **zod-to-openapi v8 pulled (zod-4 line)** → generation breaks. → Mitigation: pin v7; single-z-instance check.
- **New modules trigger the DI crash class** → boot failure missed by build/unit tests. → Mitigation: T1's CI boot-smoke (required).
- **A `/v1` create diverging from the console admission path** → a second, unguarded admission. → Mitigation: D1 delegates to the same `TasksService.create`.
- **Mutating a console schema by reuse** → breaks `apps/web`. → Mitigation: D2 additive-only + byte-unchanged test.
- **Shared pool (D2)**: any principal may list/stop any task via `/v1`. → Accepted; documented in the OpenAPI description.

## Migration Plan

1. Add the new dependencies (`@nestjs/throttler`, `@asteasolutions/zod-to-openapi` v7, Swagger-UI) and the `IdempotencyKey` migration (runs pre-boot).
2. Land contracts (`/v1` DTOs) → the V1 module (controllers + pagination + idempotency + scope gates) → OpenAPI endpoints + guard exemption → SSE controller → rate-limiting guard + create cap.
3. Run the CI boot-smoke against the assembled app; run the live `curl -N` SSE probe through the tunnel before declaring the SSE path live.
4. **Rollback**: the whole `/v1` surface is additive and inert until called; reverting the V1 module restores the prior surface with no console impact; the `IdempotencyKey` table can be left unused or dropped.

## Open Questions

- SSE transport under cloudflared: if the live probe shows GET-SSE is buffered through the tunnel, fall back to documenting polling as the supported path and treat `/v1/tasks/:id/events` as best-effort (or revisit a POST-streamed variant). Decide after the probe.
- Default request-rate and create-rate values (per-key / per-owner) — pick conservative defaults, env-overridable.
- Whether to expose `GET /v1/repos` POST/import in `/v1` now — deferred; only the read surface + task lifecycle ships in T0.
