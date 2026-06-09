<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Within a track tasks run serially; independent tracks run in parallel at apply. -->

## 1. Track: contracts (depends: none)

- [x] 1.1 `packages/contracts/src/task.ts`: add `cancelled` to `TaskStatusSchema` and to `TERMINAL_TASK_STATUSES`, documenting it as the operator-stop terminal (distinct from `completed`/`failed`).
- [x] 1.2 `packages/contracts/src/task.ts`: add `idleTimeoutMs: z.number().int().positive().optional()` to `CreateTaskRequestSchema` (mirroring `deadlineMs`), with a doc comment that it is opt-in / off when omitted.
- [x] 1.3 `packages/contracts/src/task.ts`: add persisted `idleTimeoutMs` and `deadlineMs` (nullable+optional positive ints) to `TaskSchema`/`TaskResponseSchema`, echoed on every read path (parity with branch/strategy/skills).
- [x] 1.4 `packages/contracts/src/audit.ts`: audit event `type` is already an open string whose prose lists `task.cancelled`/`task.completed`, and `AuditQuerySchema.status` reuses `TaskStatusSchema` (gains `cancelled` transitively) — no schema change needed; the new terminals map cleanly.
- [x] 1.5 Update/extend contracts unit tests for the new status, create-request field, and response fields (sent value == readable value). — `task-guardrails.test.mjs`, 9/9 pass; skills regression 6/6.

## 2. Track: db-schema (depends: contracts)

- [x] 2.1 `apps/api/prisma/schema.prisma`: add `cancelled` to the `TaskStatus` enum (byte-for-byte in sync with `TaskStatusSchema`).
- [x] 2.2 `apps/api/prisma/schema.prisma`: add nullable `idleTimeoutMs Int? @map("idle_timeout_ms")` and `deadlineMs Int? @map("deadline_ms")` to the `Task` model.
- [x] 2.3 Hand-wrote `apps/api/prisma/migrations/20260609010000_add_task_guardrail_controls/migration.sql`: `ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'cancelled' BEFORE 'agent_failed_to_start';` + `ALTER TABLE "tasks" ADD COLUMN "idle_timeout_ms" INTEGER; ADD COLUMN "deadline_ms" INTEGER;`. Prisma client regenerated.

## 3. Track: guardrails (depends: contracts)

- [x] 3.1 `apps/api/src/guardrails/idle-tracker.ts`: per-task ceiling — `start(taskId, maxIdleMs)` stores `maxIdleMs` in `Tracked`; `recordActivity`/`onIdle`/`armFromNow` use the stored value; removed the constructor `maxIdleMs` field; validation moved to `start()`.
- [x] 3.2 `apps/api/src/guardrails/guardrails.service.ts`: `config.maxIdleMs: number` → `defaultIdleTimeoutMs: number | null` (default `null`); `DEFAULT_GUARDRAILS_CONFIG` off-by-default; new exported `GuardrailParams`.
- [x] 3.3 `apps/api/src/guardrails/guardrails.module.ts`: read `MAX_IDLE_MS` via null-aware `readOptionalPositiveInt` into `defaultIdleTimeoutMs`, defaulting to UNSET/off (no implicit 10-minute ceiling).
- [x] 3.4 `apps/api/src/guardrails/guardrails.service.ts`: `admit(taskId, params: GuardrailParams)`; `pendingDeadlines` → `pendingGuardrails`; `startRunning` arms idle only when `idleTimeoutMs ?? defaultIdleTimeoutMs` is set, else never idle-tracks.
- [x] 3.5 `apps/api/src/guardrails/guardrails.service.ts`: widened `recordExit` — code0→`completed`, non-zero→`failed` (+recordFailure), abnormal→`forceFail('abnormal_exit')`; every path frees the slot via the transition→isTerminal→onTerminal chain (idempotent). Renamed the abnormal cause from the misleading `'idle'` to `'abnormal_exit'`.
- [x] 3.6 `apps/api/src/guardrails/circuit-breaker.ts`: doc clarifies accumulation applies to provision-time `agent_failed_to_start`, not a running task's single terminal exit (handled by `recordExit`).
- [x] 3.7 Guardrails unit tests updated: idle-tracker per-task ceiling + never-armed default (32/32); exit-roundtrip asserts completed/failed/abnormal each transition + RELEASE the slot (14/14); circuit-breaker 27/27, semaphore 44/44 regress green.

## 4. Track: api-lifecycle (depends: contracts, db-schema, guardrails)

- [x] 4.1 `apps/api/src/tasks/task-lifecycle.ts`: added `cancelled` terminal with edges `queued|running|awaiting_input → cancelled`, no edges out; in `TERMINAL_STATUSES`/`isTerminal`.
- [x] 4.2 `apps/api/src/tasks/tasks.service.ts`: `IGuardrailsService.admit` → options object; `create()` passes `{ deadlineMs, idleTimeoutMs }`.
- [x] 4.3 `apps/api/src/tasks/tasks.service.ts`: persist `idleTimeoutMs`/`deadlineMs` (null when omitted) + echo in `toResponse` (param type + return).
- [x] 4.4 `apps/api/src/tasks/tasks.service.ts`: added `stop(id, githubId?)` — active → `cancelled` via `transition` (fires onTerminal teardown + slot release); idempotent for terminal (short-circuit + swallow raced `IllegalTaskTransitionError`).
- [x] 4.5 `apps/api/src/tasks/tasks.controller.ts`: added `POST tasks/:taskId/stop` (HttpCode 200) → `TasksService.stop`; covered by global `APP_GUARD`.
- [x] 4.6 `apps/api/src/audit/audit-mapping.ts` + `audit.service.ts`: added `abnormal_exit` to `ForceFailCause`/`AuditEventKind` + descriptor + `causeLabel`; added `cancelled` case to `kindForStatus` (`task.cancelled` infra already present).
- [x] 4.7 Tests: `task-lifecycle.test.mjs` cancelled edges/terminality (5/5); `api-e2e.mjs` test C — guardrail-param round-trip (sent==readable + omitted→null) + stop→cancelled + idempotent + 404 + 401 (runs live against DB). api `tsc` 0, eslint 0.

## 5. Track: web (depends: contracts)

- [x] 5.1 `apps/web/src/components/dashboard/new-task-dialog.tsx`: added "空闲自动回收" + "运行时限" preset selects (default off/none), `IDLE_TIMEOUT_OPTIONS`/`DEADLINE_OPTIONS` + `guardrailSelectValue`/`parseGuardrailSelectValue` (exported); submit sends integer ms `idleTimeoutMs`/`deadlineMs` only when chosen; `buildCommandPreview` emits `--idle-timeout-ms`/`--deadline-ms`; reset-on-open clears them.
- [x] 5.2 `apps/web/src/routes/_app/tasks/new.tsx`: mirrors the idle/deadline selects + preview + submit (imports the shared catalogs/helpers).
- [x] 5.3 `apps/web/src/lib/api/{real,mutations}.ts`: added `real.stopTask` (POST `/tasks/:taskId/stop`) + `stopTaskMutation` (invalidates task + tasks). Task reads carry `idleTimeoutMs`/`deadlineMs` via `TaskResponseSchema` automatically (optional/nullable → mock needs no change).
- [x] 5.4 `apps/web/src/routes/_app/tasks/$taskId.tsx` + `session-header.tsx`: confirm-gated "停止任务" control (two-step, no blocking dialog) wired to `stopTaskMutation`, shown only when `!terminal` (via `TERMINAL_TASK_STATUSES`); guardrail readout item ("空闲回收 …/关闭 · 运行时限 …/无") via `formatDuration`.
- [x] 5.5 `task-status.ts` + `history-result.ts`: added the `cancelled` entry (已取消, neutral, settled/connectable) to both exhaustive `Record<TaskStatus>` maps (the second was a required build fix).
- [x] 5.6 Web vitest: `task-status.test.ts` (cancelled in both maps + isOpenTask) + `new-task-dialog.test.ts` (preview opt-in lines + select round-trip + default-off). 49/49 pass; tsc 0, eslint 0.

## 6. Track: verify-and-docs (depends: contracts, db-schema, guardrails, api-lifecycle, web)

- [x] 6.1 Static gates GREEN: contracts build + tests; api `tsc` 0 / eslint 0 / nest build OK; web `tsc` 0 / eslint 0 / vitest 49/49; guardrails suite (idle 32, exit-roundtrip 14, breaker 27, semaphore 44) + lifecycle 5. (Live-only: `api-e2e.mjs` test C + `aio-e2e` require a running DB/compose stack — run in CI/live, same as the pre-existing e2e suite.)
- [x] 6.2 Docs: `.env.example` updated — idle reclaim is OFF by default; `MAX_IDLE_MS` is the OPTIONAL operator-level default; per-task `idleTimeoutMs` overrides; manual stop (`POST /tasks/:taskId/stop`) is the deliberate slot-release path; the implicit 10-minute reclaim is removed.
- [x] 6.3 No `debugger`/stray artifacts in changed `apps/api/src`, `apps/web/src`, `packages/contracts/src` (grep clean).
