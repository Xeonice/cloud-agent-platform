## Context

See `research-brief.md` for the grounded codebase trace. In short: a running task
is force-failed after a global, unconditional **10-minute** idle ceiling
(`guardrails.service.ts:345` arms `idle.start` for every task; ceiling from
`config.maxIdleMs`, default `10*60*1000`). The operator wants idle reclaim OFF by
default and opt-in per task — exactly the shape `deadlineMs` already has
(`task.ts:170-177` → `tasks.service.ts:173` → `admit(taskId, deadlineMs?)`).

The blocker: idle reclaim is effectively the ONLY routine path that frees a
concurrency slot from a finished/abandoned codex session. No code transitions a
task to `completed` (grep: zero callers); a clean `code 0` terminal exit only
calls `recordSuccess` (circuit-breaker reset) and leaks the slot
(`guardrails.service.ts:277-278`); there is no manual stop endpoint; the queue has
no timeout; `MAX_CONCURRENT_TASKS` defaults to 5. So naively flipping idle off
deadlocks the slot pool. This change therefore couples the idle-default flip with
the slot-release fixes the 10-minute reclaim was masking.

## Goals / Non-Goals

**Goals:**
- Idle reclaim is per-task opt-in and OFF by default; `deadlineMs` joins it as a
  first-class, persisted guardrail parameter.
- A single terminal sandbox exit (clean / non-zero / abnormal) reliably
  transitions the task and frees its slot — no zombie `running` tasks.
- A deliberate operator action (`POST /tasks/:taskId/stop` → `cancelled`) replaces
  automatic idle reclaim as the routine way to free a slot.
- Console exposes idle + deadline controls (default off), a stop control, and a
  read-back of each task's configured guardrails.

**Non-Goals:**
- Live countdown / remaining-time display of idle or deadline timers (only the
  CONFIGURED values are surfaced; the live timer stays in-memory).
- Historical idle/deadline metering or persistence of WHEN a watcher armed.
- Reworking `awaiting_input` semantics or the `Stop`-hook notification.
- Auto-pausing / hibernating idle sandboxes (we stop or keep, not suspend).

## Decisions

### D1 — Idle is per-task opt-in, default off; operator-level default retained
Effective idle ceiling = `task.idleTimeoutMs ?? config.defaultIdleTimeoutMs ?? undefined`.
`config.maxIdleMs: number` becomes `defaultIdleTimeoutMs: number | null = null`, sourced
from env `MAX_IDLE_MS` (now defaulting to UNSET/off). When the effective ceiling is
undefined, `idle.start` is NOT called, so the task is never idle-tracked.
- *Why keep the env at all?* A shared/unattended deployment may still want a global
  safety net without configuring every task; per-task value always wins. Out of the
  box (no env) idle is off, honoring the operator's "default no capability".
- *Alternative rejected:* drop the env entirely (pure per-task). Cleaner symmetry
  with `deadlineMs` (which has no env), but removes the only knob a shared host
  could use to bound abandoned tasks. We keep it as opt-in.

### D2 — IdleTracker stores a per-task ceiling
`IdleTracker.start(taskId, maxIdleMs)` records the ceiling in the `Tracked` entry;
`recordActivity` re-arms against the stored value; `onIdle` compares against it. The
constructor-level `maxIdleMs` is removed (or kept only as an unused fallback). This
mirrors `DeadlineWatcher.armAfter(taskId, ttlMs)`, which already takes a per-arm TTL.
- Consequence: with idle off by default, `recordActivity` is a no-op for untracked
  tasks (`idle-tracker.ts:110`), so the 6 gateway call sites stay unchanged.

### D3 — `admit` takes an options object; one parking map
`admit(taskId, opts?: { deadlineMs?, idleTimeoutMs? })`. The queued-task parking map
`pendingDeadlines` generalizes to `pendingGuardrails: Map<string, {deadlineMs?, idleTimeoutMs?}>`,
consumed at `onAdmit`/`startRunning`. The `IGuardrailsService.admit` interface and the
`tasks.service` caller update accordingly.
- *Why an object:* avoids positional-arg sprawl (`admit(id, deadlineMs, idleTimeoutMs)`)
  and keeps queued-task parking in one structure.

### D4 — A terminal exit transitions the task and frees the slot
`recordExit` is widened from "circuit-breaker outcome only" to drive lifecycle:
- `code 0 && !abnormal` → `safeTransition(taskId, 'completed')` (plus `recordSuccess`),
- non-zero clean → `safeTransition(taskId, 'failed')` (plus `recordFailure` for audit/threshold),
- abnormal → `forceFail(taskId, …)` (unchanged path).
`completed`/`failed` route through `TasksService.transition` → `isTerminal` →
`guardrails.onTerminal` → teardown + slot release (the existing chain). The
circuit-breaker's count-to-threshold is explicitly scoped to provision-time
`agent_failed_to_start`; a running task's single WS-close exit no longer waits for a
threshold.
- *Why reuse `transition('completed')` rather than calling `onTerminal` directly:*
  `onTerminal` does teardown+release but does NOT set status; the status write +
  audit + terminal hook all live in `TasksService.transition`. Going through it keeps
  one status-write chokepoint.
- *Alternative rejected:* leave abnormal-only release and rely on idle. That is the
  current bug; default-off idle makes it permanent.

### D5 — New `cancelled` terminal status (not `failed`-reuse)
Operator stop → `cancelled`; clean agent exit → `completed`; crash/overrun/idle/
deadline/circuit → `failed`. Three distinct meanings. `cancelled` is ALREADY
referenced by the guardrails + audit specs (`task.cancelled`), so this aligns the
implementation to the spec rather than inventing a state.
- Ripple: Prisma `TaskStatus` enum (+ migration `ADD VALUE`), contracts
  `TaskStatusSchema`, `task-lifecycle.ts` edges (`queued`/`running`/`awaiting_input`
  → `cancelled`, terminal), `audit-mapping.ts`, frontend `task-status.ts` rendering,
  `TERMINAL_TASK_STATUSES`.
- *Alternative rejected:* reuse `failed` for stop. Smaller, but conflates a
  deliberate stop with a failure in the timeline and the audit dot color.

### D6 — Persist + echo `idleTimeoutMs` AND `deadlineMs`
Both become nullable `Int?` columns on `Task`, persisted at create and echoed on every
read path (create/list/get). `deadlineMs` is promoted from transient (it was passed to
`admit` but never stored) so the detail page can show the configured guardrails. They
remain consumed at admission too (arming the watchers).
- Hand-written migration (no local DB), mirroring `20260609000000_add_task_skills`.

### D7 — Manual stop endpoint
`POST /tasks/:taskId/stop` → `TasksService` stops the task by transitioning it to
`cancelled` (from `queued`/`running`/`awaiting_input`), which fires the terminal
teardown chain. Idempotent: stopping a terminal task is a safe no-op (the lifecycle
rejects the illegal edge and the handler swallows it). Global `APP_GUARD` covers the
new route automatically.

### D8 — Console controls
- new-task form (dialog + `/tasks/new`): "空闲自动回收" and "运行时限" controls,
  default off/none, preset durations + custom, submitting integer ms. `buildCommandPreview`
  reflects them.
- session page: a "停止任务" control (confirm → stop mutation → reconcile cache),
  inert/hidden for terminal tasks; a read-back of the task's configured guardrails.
- api query layer gains a `stopTaskMutation` (real + mock).

## Risks / Trade-offs

- **[Operational BREAKING: implicit 10-min reclaim removed]** → A deployment that
  silently relied on the 10-minute reclaim no longer reclaims abandoned tasks
  automatically. *Mitigation:* the exit-fix (D4) frees slots on real codex exits, the
  manual stop (D7) covers deliberate cleanup, and an operator can restore a global net
  via `MAX_IDLE_MS`. Documented as a behavior change in the proposal.
- **[`recordExit` → `transition('completed')` re-entrancy with WS-close teardown]** →
  the gateway is handling the same session's close while `onTerminal` unregisters it.
  *Mitigation:* `onTerminal` is idempotent (clearTimers, teardown `.catch`, release
  tolerates double-call) and `safeTransition` swallows an already-terminal edge.
- **[Postgres enum `ADD VALUE` for `cancelled`]** → `ALTER TYPE … ADD VALUE` cannot be
  used in the same transaction that then references the new value (and historically
  could not run inside a transaction block). *Mitigation:* the migration adds the value
  in its own statement ahead of any use; nullable column adds are independently safe.
- **[Single non-zero exit now terminal]** → previously a non-zero exit only incremented
  the breaker (waiting for 3). Treating one exit as terminal is correct for connect-in
  (no re-launch) but changes breaker-driven behavior. *Mitigation:* breaker stays for
  provision-time `agent_failed_to_start`; the spec scopes it explicitly.
- **[Stop is irreversible]** → a misclick cancels a task. *Mitigation:* the console
  requires an explicit confirmation before POSTing stop.

## Migration Plan

1. Contracts: add `idleTimeoutMs` to `CreateTaskRequest`; add persisted
   `idleTimeoutMs`/`deadlineMs` + `cancelled` to `TaskSchema`/`TaskStatusSchema`.
2. DB: hand-write a Prisma migration adding `idle_timeout_ms`/`deadline_ms` nullable
   int columns and the `cancelled` enum value (own statement).
3. API: IdleTracker per-task ceiling; `GuardrailsService` (`admit` options,
   `pendingGuardrails`, `defaultIdleTimeoutMs`, `recordExit` terminal+release);
   `tasks.service` persist + stop path; `tasks.controller` stop route; lifecycle +
   audit mapping for `cancelled`.
4. Web: form controls + command preview; session stop control + guardrail readout;
   `task-status.ts` `cancelled`; query/real/mock stop mutation.
5. Deploy order: contracts → api (with migration) → web. Announce the idle-default
   behavior change.
- **Rollback:** columns are additive + nullable and the enum value is additive
  (harmless if unused); revert app code and the default reverts. The added enum value
  cannot be trivially dropped but is inert without code paths using it.

## Open Questions

- Exact preset durations for the idle/deadline controls (e.g. 10m/30m/1h/custom for
  idle; 30m/1h/2h/custom for deadline) — UX detail, settle at apply.
- Rename the abnormal-exit `forceFail` cause from the current `'idle'` misnomer to
  e.g. `'abnormal_exit'` for honest audit text? (Cosmetic; audit "cause" list is
  open-ended `e.g.`, so not spec-blocking.)
- Should stopping also be offered from the dashboard task list, not only the session
  page? (Out of scope for this change unless requested.)
