# Research Brief — task-guardrail-controls

Side-car research (not a tracked artifact). Grounded by direct codebase reads
during the `/opsx:explore` pass; every claim carries a `file:line` anchor.

## 1. The trigger

The operator asked: "the idle reclaim should be OFF by default; let the user
opt in at task-creation time." Today a running task is force-failed after
**10 minutes** of no terminal output / hook activity. That is the ONLY
idle-based reclaim, owned by `IdleTracker` (`apps/api/src/guardrails/idle-tracker.ts`)
with ceiling `MAX_IDLE_MS` defaulting to `10 * 60 * 1000`
(`guardrails.service.ts:106`, env read at `guardrails.module.ts:71-73`).

## 2. `deadlineMs` is the per-task opt-in precedent (mirror it)

The wall-clock deadline is ALREADY per-task, optional, opt-in — the exact shape
the idle timeout should take:

- Contract: `CreateTaskRequestSchema.deadlineMs: z.number().int().positive().optional()` (`packages/contracts/src/task.ts:170-177`).
- Service: `create()` passes `body.deadlineMs` into `admit(task.id, body.deadlineMs)` (`tasks.service.ts:173`).
- Guardrails: `admit(taskId, deadlineMs?)` parks it in `pendingDeadlines` when queued, arms `deadlines.armAfter` at `startRunning` (`guardrails.service.ts:236-247`, `343-350`); `DeadlineWatcher.armAfter` already takes a per-arm TTL (`deadline-watcher.ts:99-101`).
- **Asymmetry to note**: `deadlineMs` is TRANSIENT — NOT persisted to the DB and NOT echoed on read (`tasks.service.ts` create-data + `toResponse` omit it). branch/strategy/skills ARE persisted+echoed. This change promotes BOTH idleTimeoutMs and deadlineMs to persisted+echoed (operator decision: 入库+回显).

By contrast `idle` is GLOBAL + UNCONDITIONAL: `startRunning` always calls
`this.idle.start(taskId)` (`guardrails.service.ts:345`) with the construction-time
single `maxIdleMs`. `IdleTracker` stores no per-task ceiling — it holds one
`maxIdleMs` field used by `start`/`recordActivity`/`onIdle` alike
(`idle-tracker.ts:59,74,109-114,142-154,162-178`).

## 3. What resets the idle window (so "idle" means truly unattended)

`recordActivity` re-arms the window; wired in `terminal.gateway.ts` to:
- codex/PTY output (`:1089`),
- operator keystroke (`:786`),
- **operator heartbeat — even a read-only attendee with the tab open (`:803`)**,
- hook permission request (`:951`) and post-tool-use report (`:994`).

So today an ATTENDED task (tab open → heartbeats) is never idle-failed; only a
genuinely unattended + silent task is. Closing the tab stops the heartbeat
(`idle-tracker.ts` doc `:14-17`, gateway `:796-801`). After this change, with idle
default-off, `recordActivity` becomes a cheap no-op for untracked tasks
(`idle-tracker.ts:110`), so those 6 call sites need NO removal.

## 4. The capacity hazard that makes the naive flip unsafe

How does a running codex task EVER leave `running` and release its concurrency
slot? `MAX_CONCURRENT_TASKS` defaults to **5** (`guardrails.service.ts:105`), the
queue has **no timeout** (FIFO wait is unbounded, `semaphore.ts`).

- **No `completed` transition exists.** Grep finds zero callers of
  `transition(.., 'completed')` anywhere in `apps/api/src` (only the lifecycle
  edge definition `task-lifecycle.ts:39-40`, the teardown reason param, and audit
  mapping). A codex TUI does not self-exit on turn-end — it sits at the composer.
- **No manual stop/cancel endpoint.** `tasks.controller.ts` exposes only
  `@Post('repos/:repoId/tasks')` (create). No stop/cancel route; the status enum
  has no `cancelled` (`task-status.ts:45` comment: "seven members (no cancelled)").
  The session header has copy/pause only — no "stop task".
- **Bootstrap reclaim** transitions stranded `running`/`awaiting_input` → `failed`
  only on process restart (`tasks.service.ts:99-123`).

Net: idle reclaim (10 min) is effectively the ONLY routine mechanism that frees a
slot from a finished-or-abandoned codex session. Turning it off with no
replacement leaks all 5 slots → queue deadlock until restart.

## 5. The exit-path bug (confirmed; prerequisite to fix)

`AioPtyClient` detects termination by the sandbox terminal WS close (no `node-pty`
`onExit` in connect-in): `onSocketClose` → `resolveExitStatus`
(`aio-pty-client.ts:397-434`) → `onExit({code, abnormal})` →
`gateway.onSessionExit` (`terminal.gateway.ts:749-756`) → `guardrails.recordExit`.

`recordExit` (`guardrails.service.ts:276-291`):
- `code === 0 && !abnormal` → `recordSuccess` ONLY (resets the circuit-breaker
  counter, `circuit-breaker.ts:114-121`). **No transition, no `onTerminal`, no
  `semaphore.release`.** → task stays `running` (zombie), slot LEAKS.
- `abnormal` → `forceFail(taskId,'idle')` → `failed` + teardown + release ✓
  (someone patched the crash path; the comment `:280-286` says "force-fail now to
  release its concurrency slot").
- non-zero clean → `recordFailure` (breaker). The breaker needs **3 CONSECUTIVE**
  failures to trip (`guardrails.service.ts:107`, `circuit-breaker.ts:83-103`). In
  connect-in a single WS-close exit is terminal (no runner re-launches codex —
  `openSession` arms autoLaunch once, `terminal.gateway.ts:706-717`), so a single
  non-zero exit also leaves a zombie `running` + held slot; the 2nd/3rd trip never
  comes.

**Direction is backwards**: the crash path releases, the clean path doesn't.
Today this is MASKED by the 10-min idle reclaim. Default-off idle UNMASKS it into
a permanent leak — hence the fix is a PREREQUISITE for the idle change, not
optional. The circuit-breaker's "count-to-N" accumulation is a holdover from the
old runner model; it still fits provision-time `agent_failed_to_start`
(`tasks.service.ts:255-289`) but NOT a running task's single terminal exit.

## 6. Terminal-state semantics become a clean 3-way split

With the exit fix + a manual stop, three distinct terminal meanings emerge,
justifying a new `cancelled` status (already anticipated — `audit.ts:40,65`
reference `task.cancelled`):
- codex exits clean (operator `/quit`, or finishes) → `completed`
- operator clicks "停止任务" → `cancelled`
- crash / non-zero / idle / deadline / circuit / provision-fail → `failed`

`completed`/`cancelled` route through `TasksService.transition` whose
`isTerminal` hook already calls `guardrails.onTerminal` → teardown + slot release
(`tasks.service.ts:238-246`, `guardrails.service.ts:309-327`); `onTerminal` is
idempotent (tolerates the double-call from a concurrent WS-close handler).

## 7. Capability mapping (openspec/specs/)

- `guardrails` — idle becomes per-task opt-in default-off; exit→terminal+release;
  circuit-breaker role clarified.
- `repo-and-task-management` — CreateTaskRequest gains `idleTimeoutMs`;
  `idleTimeoutMs`+`deadlineMs` persisted+echoed; new `cancelled` terminal status;
  new `POST /tasks/:taskId/stop` endpoint.
- `frontend-console` — new-task form gains idle+deadline controls (default off);
  session page gains a stop control; detail page surfaces configured guardrails.
- `audit-history` — records the operator-stop (`task.cancelled`) and clean-exit
  (`task.completed`) terminals.

No NEW capability is introduced — all four are existing specs.

## 8. Open design points (resolved in design.md)

1. Bundle `admit` params into `{deadlineMs?, idleTimeoutMs?}` and generalize
   `pendingDeadlines` → `pendingGuardrails` (touches `IGuardrailsService` +
   `tasks.service`).
2. `IdleTracker.start(taskId, maxIdleMs)` per-task ceiling stored in `Tracked`;
   `recordActivity`/`onIdle` use the stored value; constructor `maxIdleMs` becomes
   optional fallback.
3. `config.maxIdleMs` → `defaultIdleTimeoutMs: number | null = null`; env
   `MAX_IDLE_MS` default flips to unset/off (kept as optional operator-level net).
4. `recordExit` re-entrancy with the WS-close→unregisterSession path (idempotent).
5. New `cancelled` status ripples: Prisma enum migration, contracts
   `TaskStatusSchema`, `task-lifecycle.ts` edges, `audit-mapping.ts`, frontend
   `task-status.ts`.
