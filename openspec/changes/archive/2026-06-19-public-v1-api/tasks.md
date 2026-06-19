<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a track run serially. -->
<!--
  Partition corrected against the codebase (file-touch scan):
  - Parallel tracks touch DISJOINT files. New /v1 endpoint code lands under new
    dirs (apps/api/src/v1/, apps/api/src/openapi/, apps/api/src/rate-limit/),
    each track owning its own controller/logic/test FILES — never a shared one.
  - Shared-file tasks are ISOLATED into the Integration track (run serially after
    the parallel tracks), because they collide on three seams:
      * apps/api/src/app.module.ts  — V1Module/OpenApi/Rate-limit module wiring
        + the second global APP_GUARD ordered AFTER AuthModule (3.6, 4.1-wire,
        6.1-wire).
      * apps/api/package.json       — @nestjs/throttler (6.1) AND
        @asteasolutions/zod-to-openapi v7 + swagger-ui (4.1) both add deps here.
      * apps/api/src/v1/v1.module.ts — the V1Module that registers BOTH the
        v1-controllers (Track 3) AND the SSE events controller (Track 5); the
        module assembly is the shared seam, the controller files themselves are
        disjoint and stay in their tracks. extendZodWithOpenApi(z) is a
        once-per-process call on the shared z instance, so its single-init also
        lands in Integration.
-->

## 1. Track: contracts (depends: none)
<!-- files: packages/contracts/src/v1.ts (NEW), packages/contracts/src/index.ts,
     packages/contracts/src/v1.test.mjs (NEW). Self-contained in packages/contracts/. -->


- [x] 1.1 Add the `/v1`-only DTOs to `@cap/contracts` (ADDITIVE, never mutating console schemas): create-with-`repoId` body (`CreateTaskRequestSchema.extend({ repoId })`), the `{ items, nextCursor }` paginated envelopes for tasks + repos, the list query (`limit`/`cursor`), and the SSE lifecycle-event shape.
- [x] 1.2 Add a test asserting the console schemas (`CreateTaskRequestSchema`/`ListTasksResponseSchema`/`ListReposResponseSchema`) are byte-unchanged after the `/v1` additions.

## 2. Track: data-model (depends: none)
<!-- files: apps/api/prisma/schema.prisma, apps/api/prisma/migrations/<new>/.
     Self-contained: appends a new model + migration, no existing table touched. -->

- [x] 2.1 Add the `IdempotencyKey` Prisma model (`key`, `scopeUserId`, `requestHash`, `taskId`, `createdAt`, `expiresAt`, `@@unique([scopeUserId, key])`).
- [x] 2.2 Generate the migration; verify it applies cleanly and FKs/links correctly, leaving existing tables unchanged.

## 3. Track: v1-controllers (depends: contracts, data-model)
<!-- files (NEW, disjoint): apps/api/src/v1/v1-tasks.controller.ts,
     apps/api/src/v1/v1-repos.controller.ts, apps/api/src/v1/v1-transcript.controller.ts,
     apps/api/src/v1/keyset-pagination.ts, apps/api/src/v1/idempotency.service.ts,
     apps/api/src/v1/*.spec.ts. Injects existing TasksService/ReposService/
     TRANSCRIPT_STORE — does NOT modify them. The V1Module ASSEMBLY that registers
     these + the SSE controller (Track 5) and the AppModule wiring are the shared
     seam → Integration (3.6). 3.1 here authors the controller files only. -->

- [x] 3.1 Create thin `@Controller('v1/...')` controllers (in their own files) that inject and delegate to the existing `TasksService`/`ReposService`/transcript store: `POST /v1/tasks` (repoId from body), `GET /v1/tasks`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/stop`, `GET /v1/repos`, `GET /v1/repos/:id`, `GET /v1/tasks/:id/transcript` — one admission path (the same `TasksService.create`). (The `V1Module` that registers them is assembled in Integration 3.6, alongside the Track 5 SSE controller.)
- [x] 3.2 Implement keyset pagination on `GET /v1/tasks` + `GET /v1/repos` (`?limit=&cursor=`, opaque `(createdAt,id)` cursor, default 50 / max 200, `nextCursor` null on last page).
- [x] 3.3 Implement `Idempotency-Key` dedup on `POST /v1/tasks`: insert the `IdempotencyKey` row in the SAME transaction as `task.create`; same key+body → same task; same key+different body → 409; 24h window.
- [x] 3.4 Gate every `/v1` operation with `hasScope` (read→`tasks:read`/`repos:read`, write→`tasks:write`; scopeless session = allow-all; 403 on missing scope), reading the guard-attached principal.
- [x] 3.5 Apply a stricter create-rate `@Throttle` to `POST /v1/tasks` (the per-principal task-creation cap; see Track 6 for the global throttler).
- [x] 3.7 Tests: /v1 create delegates to `TasksService.create` (one admission path); pagination walks the set with no drop/dup; idempotent create returns the same task (and 409 on body mismatch); a `tasks:read`-only api-key is 403 on `POST /v1/tasks`; a session passes.

## 4. Track: openapi (depends: contracts)
<!-- files (NEW + one exclusive edit): apps/api/src/openapi/openapi.registry.ts,
     apps/api/src/openapi/openapi.controller.ts, apps/api/src/openapi/*.spec.ts,
     and apps/api/src/auth/auth.guard.ts (4.3 adds two exact-match exemptions —
     this file is touched ONLY by this track, so it is NOT shared). The dep add
     + the single extendZodWithOpenApi(z) init + OpenApiModule AppModule wiring
     are the shared seam → Integration (4.1). -->

- [x] 4.2 Build one `OpenAPIRegistry` from the `@cap/contracts` `/v1` schemas + generate the OpenAPI 3.1 document; serve it at `GET /v1/openapi.json` and an interactive `GET /v1/docs` (registry + controller files only; the module wiring is assembled in Integration 4.1).
- [x] 4.3 Exempt `GET /v1/openapi.json` + `GET /v1/docs` in `auth.guard.ts` (exact-match, like `/version`); add a test asserting those two are reachable unauthenticated AND that `/v1` data routes (e.g. `GET /v1/tasks`) stay 401 without a credential.
- [x] 4.4 Test: the generated spec includes every `/v1` route and is built from the same schemas used for request validation (route↔schema registration diff test).

## 5. Track: sse-observation (depends: contracts)
<!-- files (NEW, disjoint): apps/api/src/v1/v1-events.controller.ts +
     apps/api/src/v1/v1-events.controller.spec.ts. Tails AuditService (exported by
     the @Global() AuditModule, so no app.module edit to consume it). This
     controller is registered into V1Module by Integration 3.6 alongside Track 3's
     controllers — that registration is the only shared point; the file itself is
     disjoint. 5.2 is a doc/assertion (polling floor), 5.3 is a deploy-time live
     curl probe (no source file). -->

- [x] 5.1 Add `GET /v1/tasks/:id/events` (`text/event-stream`) tailing the append-only `AuditEvent` for the task: one `data:` per lifecycle event, `id:` for `Last-Event-ID` resume, a `<90s` keep-alive heartbeat, headers `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`, auto-close on a terminal event. Do NOT expose the raw PTY/WS stream.
- [x] 5.2 Confirm the polling floor: `GET /v1/tasks/:id` observes every persisted transition (it already does via `findById`); document polling as the guaranteed path.
- [ ] 5.3 **G7 live probe (deploy-time)**: run a `curl -N` 2-minute heartbeat stream against `GET /v1/tasks/:id/events` through `cap-api.douglasdong.com` and confirm the tunnel passes SSE without buffering/524; if it does NOT, document polling as the supported path and mark SSE best-effort. (Requires the live tunnel — PENDING: cannot run in-repo; the SSE endpoint + heartbeat + no-buffer headers are implemented and the polling floor is the guaranteed path until this probe passes.)
- [x] 5.4 Tests: the events stream emits AuditEvent-derived lifecycle events with ids + a heartbeat and closes after a terminal event; the raw terminal stream is not exposed here.

## 6. Track: rate-limiting (depends: none)
<!-- files: the tracker/guard subclass lands in a NEW apps/api/src/rate-limit/
     (e.g. principal.throttler-guard.ts), and 6.2's test (NEW *.spec.ts) is
     disjoint. But 6.1 ALSO adds @nestjs/throttler to apps/api/package.json AND
     registers the ThrottlerModule + the SECOND global APP_GUARD whose ordering is
     defined by provider/import order relative to AuthModule — that registration
     edits apps/api/src/app.module.ts. Both are shared seams → 6.1 to Integration;
     only the test 6.2 stays parallel here. -->

- [x] 6.2 Tests: two distinct api-keys from one IP get independent buckets (per-principal, not per-IP); exceeding the window returns 429; the throttler runs AFTER the auth guard (principal attached when the tracker keys on it).

## 7. Track: Integration (depends: contracts, data-model, v1-controllers, openapi, sse-observation, rate-limiting)
<!-- Serial, AFTER all parallel tracks. Owns the three shared-file seams:
     apps/api/src/app.module.ts (module wiring + global APP_GUARD ordering),
     apps/api/package.json (throttler + zod-to-openapi v7 + swagger-ui deps),
     apps/api/src/v1/v1.module.ts (assembling Track 3 + Track 5 controllers),
     plus the once-per-process extendZodWithOpenApi(z) init. The CI boot-smoke
     runs here against the fully assembled app. -->

- [x] 4.1 Add `@asteasolutions/zod-to-openapi` (pin **v7**, zod-3 line) + a Swagger-UI asset to `apps/api/package.json`; call `extendZodWithOpenApi(z)` ONCE on the shared `@cap/contracts` z instance (outside contracts); wire the OpenAPI module (registry + `GET /v1/openapi.json` + `GET /v1/docs` controller from Track 4) into `AppModule`.
- [x] 3.6 Assemble the `V1Module` registering BOTH the Track 3 `/v1` task/repo/transcript controllers AND the Track 5 SSE events controller; wire `V1Module` into `AppModule`; confirm the CI boot-smoke still passes with it loaded.
- [x] 6.1 Add `@nestjs/throttler` to `apps/api/package.json`; register a `ThrottlerModule` + a throttler guard as a SECOND global `APP_GUARD` ordered AFTER the auth guard (provider/import order relative to `AuthModule` in `app.module.ts`), with a `getTracker` keyed off `req.operatorPrincipal` (per-api-key id / per-owner githubId), in-memory store, env-overridable limits.

## Track: verify-reopened (depends: none)

- [x] V.1 [Idempotent /v1 task creation] DONE — chose restructure (b): split `TasksService.create` into `createTaskRow(repoId, body, client = this.prisma)` (validation + the `task.create` ROW INSERT, run on the caller's transaction-bound `client`) and `admitCreatedTask(taskId, body, githubId)` (audit + guardrails provision, run AFTER the transaction commits — never inside it, so a rollback can't orphan a sandbox). `create` = both, unchanged console behavior. The controller's `admit` now calls `createTaskRow(repoId, body, tx)` so the task ROW + the dedup row commit in ONE transaction; `IdempotencyService.run` returns `{ task, created }` and the controller runs `admitCreatedTask` only when `created` (a dedup hit was already admitted). Tests: idempotency spec now asserts `created` (true on new/keyless/expired, false on dedup-hit/race) + `admits === 1` proves no double-admission; api 113 spec + 252 mjs tests pass; turbo 18/18 green.  ORIGINAL: Make the `POST /v1/tasks` create + dedup-row insert ATOMIC (spec.md:52 "inserted in the SAME transaction as the task"). Currently the idempotency service correctly opens `$transaction(async (tx) => …)` and passes `tx` to `admit` (`idempotency.service.ts:69,108`), but the controller's callback discards it — `admit: () => this.tasksService.create(repoId, createBody, githubId)` (`v1-tasks.controller.ts:119`) — and `TasksService.create` uses its own injected `this.prisma` (`tasks.service.ts:439,478,520,531`), so the `task` INSERT commits on the global connection while the `idempotency_keys` INSERT commits inside `$transaction`: two separate DB transactions. Close the window where the task commits but the dedup row never lands (crash/timeout between them) and a retry double-admits a sandbox. Either (a) thread the transaction-bound client through `TasksService.create` so its `task.create` runs on `tx`, or (b) restructure so the dedup row and the task row share one transaction by construction. Add a test that proves a retry cannot create a second task when the dedup insert is the failing/raced step. (The `P2002` race-recovery path only covers concurrent retries that both reach the dedup INSERT — it does not cover this commit-ordering window.)
- [x] V.2 [/v1 operations are scope-gated] DONE — `GET /v1/tasks/:id/events` now injects `@Req()`, reads the guard-attached `operatorPrincipal`, and rejects with 403 (`hasScope(principal, 'tasks:read')`) BEFORE any response byte is written, so an api-key lacking `tasks:read` cannot stream task lifecycle events (a scopeless session/legacy principal stays allow-all). Tests added to `v1-events.controller.spec.ts`: a `repos:read`-only api-key is 403 with no bytes written; a `tasks:read` api-key AND a scopeless session both pass the gate and stream (200). All pass.  ORIGINAL: Enforce the shared scope vocabulary on `GET /v1/tasks/:id/events` (`v1-events.controller.ts:97-109`). The handler injects only `@Param`, `@Res`, `@Headers('last-event-id')` — no `@Req()`, no `hasScope`/`requireScope` — so it is scope-blind while every sibling `/v1` handler gates (V1Tasks create/list/findById/stop, V1Repos list/findById, V1Transcript). The global `AuthGuard` enforces 401 for anonymous callers but not the scope vocabulary (that is per-handler), so an `api-key` principal carrying only `repos:read` (or no `tasks:read`) can stream task lifecycle events, violating spec.md:79-81 (list/read requires `tasks:read`). Add `@Req()`, read the guard-attached `operatorPrincipal`, and reject with 403 when it lacks `tasks:read` (scopeless session/legacy principal stays allow-all). Add a test that a `tasks:read`-less api-key is 403 on `GET /v1/tasks/:id/events` while a session passes.
