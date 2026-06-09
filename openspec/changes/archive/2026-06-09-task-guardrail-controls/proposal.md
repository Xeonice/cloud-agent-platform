## Why

Today every running task is force-failed after **10 minutes** of silence, and
that automatic idle reclaim is effectively the ONLY routine way a finished or
abandoned codex session frees its concurrency slot — there is no manual stop, no
`completed` transition, and a cleanly-exited codex (`code 0`) leaves a zombie
`running` task that leaks its slot until idle-timeout or restart. We want idle
reclaim to be **off by default** and **opt-in per task at creation time** (so a
legitimately long, quiet task is never killed), but flipping that default
without a replacement slot-release path would deadlock the 5-slot pool. This
change makes the guardrails operator-controlled AND fixes the slot-release gaps
that the 10-minute reclaim was silently masking.

## What Changes

- **Idle reclaim becomes per-task opt-in, default OFF.** A task is idle-tracked
  only when it carries an explicit `idleTimeoutMs` (or an operator-level global
  default is configured). With neither, the task is never reclaimed for idleness.
  **BREAKING (operational):** deployments relying on the implicit 10-minute
  reclaim must now set `MAX_IDLE_MS` or pass `idleTimeoutMs` per task.
- **`idleTimeoutMs` is a new optional create-task parameter**, mirroring the
  existing `deadlineMs`; both are now **persisted and echoed** on every task read
  path (today `deadlineMs` is transient).
- **Clean/early exits now release the slot.** A `code 0` terminal exit transitions
  the task to `completed`; a non-zero terminal exit transitions it to `failed`;
  both run the existing teardown + slot-release chain. The circuit-breaker's
  count-to-threshold role is clarified to provision-time start failures, not a
  running task's single terminal WS-close exit.
- **New manual stop:** `POST /tasks/:taskId/stop` transitions a running/queued
  task to a new terminal `cancelled` status, tearing down the sandbox and
  releasing the slot — the deliberate, operator-driven replacement for automatic
  idle reclaim.
- **New `cancelled` terminal status**, distinct from `completed` (codex finished)
  and `failed` (crash/overrun), already anticipated by the audit contract.
- **Console:** the new-task form gains "空闲自动回收" and "运行时限" controls
  (default off / none); the session page gains a "停止任务" control; the task
  detail page surfaces the task's configured guardrails.

## Capabilities

### New Capabilities

None — all changes refine existing capabilities.

### Modified Capabilities

- `guardrails`: idle reclaim is per-task opt-in (default off) instead of a global
  unconditional 10-minute ceiling; a terminal sandbox exit (clean or non-zero)
  transitions the task and releases its slot; the circuit-breaker accumulation
  applies to provision-time start failures, not a running task's single exit.
- `repo-and-task-management`: `CreateTaskRequest` gains optional `idleTimeoutMs`;
  `idleTimeoutMs` and `deadlineMs` are persisted and echoed on task reads; a new
  `cancelled` terminal task status; a new `POST /tasks/:taskId/stop` endpoint.
- `frontend-console`: the new-task form exposes per-task idle-timeout and deadline
  controls (default off); the session view exposes a manual stop control; the task
  detail view surfaces the configured guardrails.

> Note: `audit-history` is intentionally NOT listed as a modified capability. Its
> existing "Persist task lifecycle and audit events" requirement ALREADY mandates
> recording `task.completed` and `task.cancelled` transitions (and open-ended
> force-fail causes); this change merely makes the implementation reach those
> already-specified terminals, so no audit delta spec is needed.

## Impact

- **Contracts** (`packages/contracts/src/task.ts`): `CreateTaskRequestSchema` +
  `idleTimeoutMs`; `TaskSchema` + persisted `idleTimeoutMs`/`deadlineMs`;
  `TaskStatusSchema` + `cancelled`; `audit.ts` event for cancelled.
- **API**: `IdleTracker` (per-task ceiling), `GuardrailsService`
  (`admit({deadlineMs?, idleTimeoutMs?})`, `pendingGuardrails`,
  `defaultIdleTimeoutMs`, `recordExit` → terminal+release), `tasks.controller`
  (`stop` route), `tasks.service` (persist params, `cancel`/`stop` path),
  `task-lifecycle` (`cancelled` edges), `audit-mapping`.
- **DB**: Prisma `Task` gains `idleTimeoutMs Int?` + `deadlineMs Int?`; the
  `TaskStatus` enum gains `cancelled` — a hand-written migration (no local DB,
  mirroring `20260609000000_add_task_skills`).
- **Web**: `new-task-dialog.tsx` + `routes/_app/tasks/new.tsx` (idle + deadline
  controls, command preview), `routes/_app/tasks/$taskId.tsx` + `session-header`
  (stop control, guardrail readout), `task-status.ts` (`cancelled` rendering),
  api query/real/mock layers (stop mutation).
- **Config/Deploy**: `MAX_IDLE_MS` default flips to unset/off (kept as an optional
  operator-level global default); document the operational behavior change.
- **Tests**: idle-tracker (per-task ceiling), guardrails.service (default-off,
  exit→terminal+release, stop path), contracts, web vitest, provider/lifecycle.
