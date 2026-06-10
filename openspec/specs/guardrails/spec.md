# guardrails Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Concurrency semaphore bounds running tasks
The orchestrator SHALL enforce a maximum number of concurrently running tasks (the slot ceiling). The effective ceiling SHALL resolve as `persisted system setting ?? env MAX_CONCURRENT_TASKS ?? 5`: the persisted system-level setting (see `account-settings`) is authoritative once saved; the env variable `MAX_CONCURRENT_TASKS` is only the first-boot seed used when no persisted value exists. The ceiling SHALL be runtime-mutable without a process restart via a semaphore setter: a non-integer or non-positive value SHALL be rejected without changing the current ceiling; RAISING the ceiling SHALL immediately admit queued tasks in FIFO order until the new capacity is filled or the queue empties (no waiting for the next slot release); LOWERING the ceiling SHALL NOT interrupt, evict, or kill any running task — it SHALL only stop admitting new tasks while the running count exceeds the new ceiling, so the running count converges naturally as tasks release. When the limit is reached, newly created tasks SHALL remain queued rather than provisioning a sandbox, and when a running task reaches a terminal state (completed/failed/cancelled) the orchestrator SHALL admit the next queued task in FIFO order only while the running count is below the ceiling. The admission hot path SHALL NOT read the database: the in-memory ceiling is authoritative and is written only at bootstrap load and on a settings-save push.

#### Scenario: Task over the limit stays queued
- **WHEN** the effective ceiling of tasks are already running and a new task is created
- **THEN** the new task remains in the queued state and no sandbox is provisioned for it

#### Scenario: Freeing a slot admits the next queued task
- **WHEN** a running task reaches a terminal state while at least one task is queued and the running count is below the ceiling after release
- **THEN** the orchestrator provisions the oldest queued task, bringing the running count back to at most the effective ceiling

#### Scenario: Persisted setting overrides the env value
- **WHEN** the process boots with a persisted slot ceiling of N while `MAX_CONCURRENT_TASKS` is set to a different value M
- **THEN** the effective ceiling after bootstrap is N (the persisted value), not M

#### Scenario: Env seeds the ceiling only when no persisted value exists
- **WHEN** the process boots with no persisted slot ceiling
- **THEN** the effective ceiling is the value of `MAX_CONCURRENT_TASKS`, or 5 when the env variable is also unset

#### Scenario: Raising the ceiling promotes queued tasks immediately
- **WHEN** the ceiling is raised from N to N+k while the semaphore holds N running tasks and at least k queued tasks
- **THEN** the k oldest queued tasks are admitted in FIFO order immediately upon the raise, without waiting for any running task to release its slot

#### Scenario: Lowering the ceiling never evicts running tasks
- **WHEN** the ceiling is lowered below the current running count
- **THEN** no running task is interrupted, evicted, or transitioned by the resize; no new task is admitted while the running count exceeds the new ceiling; and as running tasks reach terminal states the running count converges down to the new ceiling, after which FIFO admission resumes

#### Scenario: Invalid ceiling value is rejected without effect
- **WHEN** the semaphore setter is invoked with zero, a negative number, or a non-integer
- **THEN** the call is rejected and the current ceiling, running set, and queue are unchanged

### Requirement: Wall-clock deadline force-fails a task
A task MAY carry a wall-clock deadline, supplied via the task create request (`deadlineMs`) and passed to concurrency admission (`admit(taskId, deadlineMs)`) so the deadline watcher arms. When a running task passes its deadline, the orchestrator SHALL transition it to `failed`, invoke `SandboxProvider.teardownSandbox()` for the task, and free its concurrency slot. Teardown is a **port-level** call: per design D9 the deferred minimal Docker provider documents it as a no-op (Docker is the deploy plane, not the per-task execution sandbox), while a future OS-isolating provider performs a real teardown through the same port.

#### Scenario: Task exceeding its deadline is failed and torn down
- **WHEN** a running task's wall-clock deadline passes
- **THEN** the orchestrator transitions the task to `failed`, invokes `SandboxProvider.teardownSandbox()` for the task, and releases its concurrency slot

#### Scenario: Task finishing before its deadline is unaffected
- **WHEN** a task reaches a terminal state before its deadline
- **THEN** no deadline-based force-fail is applied

### Requirement: Idle ceiling reclaims wedged tasks
Idle reclamation SHALL be OPT-IN PER TASK and OFF BY DEFAULT. The orchestrator SHALL track a running task's idle time (no terminal output and no agent-hook activity) and force-fail it on exceeding an idle ceiling ONLY when an idle ceiling is in effect for that task. An idle ceiling is in effect when the task carries an explicit per-task `idleTimeoutMs` (supplied via the task create request and passed through concurrency admission), OR when an operator-level global default is configured (`MAX_IDLE_MS`). When NEITHER is present — the default for a task created without an idle timeout in a deployment that has not set `MAX_IDLE_MS` — the task SHALL NOT be idle-tracked and SHALL NEVER be force-failed for idleness, so a legitimately long, quiet task is not reclaimed. The per-task `idleTimeoutMs` SHALL take precedence over the operator-level default. The idle ceiling is per task (not a single process-wide constant): when armed, the timer is sized to that task's effective ceiling and activity resets it against that same ceiling. (This remains distinct from the shorter "awaiting input" notification driven by the `Stop` hook, which does not fail the task.)

#### Scenario: Task without an idle ceiling is never idle-reclaimed
- **WHEN** a task is created without an `idleTimeoutMs` and the deployment has no `MAX_IDLE_MS` configured, then runs silently past any prior 10-minute mark
- **THEN** the orchestrator does NOT idle-track the task and never force-fails it for idleness, holding its slot until it terminates by another path (completion, operator stop, deadline, crash)

#### Scenario: Per-task idle ceiling reclaims an idle task
- **WHEN** a task is created WITH an explicit `idleTimeoutMs` and then produces no terminal output and no hook activity for longer than that ceiling
- **THEN** the orchestrator force-fails the task, invokes `SandboxProvider.teardownSandbox()` for the task, and frees its slot

#### Scenario: Operator-level default applies when no per-task value is given
- **WHEN** the deployment configures a global `MAX_IDLE_MS` and a task is created without a per-task `idleTimeoutMs`
- **THEN** the task is idle-tracked at the operator-level default ceiling

#### Scenario: Per-task value overrides the operator-level default
- **WHEN** a task supplies an `idleTimeoutMs` and the deployment also configures `MAX_IDLE_MS`
- **THEN** the task's idle ceiling is its own `idleTimeoutMs`, not the operator-level default

#### Scenario: Activity resets the idle timer against the task's own ceiling
- **WHEN** an idle-tracked task emits terminal output or a hook event before reaching its ceiling
- **THEN** the idle timer resets and the task is not force-failed, re-armed against that task's own ceiling rather than a process-wide constant

### Requirement: Circuit breaker on repeated start/turn failure
The orchestrator SHALL count consecutive agent-failed-to-start (and turn-failure) events for a task and, on reaching a configured threshold, SHALL circuit-break the task to `failed` without further automatic retry, preventing a burn loop. This accumulation applies to PROVISION-TIME / start failures (`agent_failed_to_start`) where a task may legitimately be retried before tripping; it SHALL NOT be the mechanism that reclaims a RUNNING task whose sandbox terminal session has exited. Under the connect-in execution model a running task's terminal WebSocket close is a single terminal event with no automatic re-launch, so that exit is handled by the terminal-exit requirement (which transitions the task and frees its slot on the FIRST exit), not by waiting for a threshold of consecutive failures.

#### Scenario: Threshold consecutive start failures trip the breaker
- **WHEN** a task accumulates the configured number of consecutive agent-start/turn failures
- **THEN** the orchestrator transitions it to `failed` and does not automatically retry

#### Scenario: A success resets the failure counter
- **WHEN** a task records a successful start/turn before reaching the threshold
- **THEN** the consecutive-failure counter resets to zero

#### Scenario: A single running-task exit does not wait for the breaker threshold
- **WHEN** a running task's terminal session exits once (cleanly or with a non-zero code)
- **THEN** the task is transitioned and its slot freed by the terminal-exit handling immediately, rather than remaining `running` until a threshold of consecutive failures is reached

### Requirement: A terminal sandbox exit transitions the task and frees its slot
When a running task's sandbox terminal session terminates (the connect-in terminal WebSocket closes and the orchestrator resolves an exit status), the orchestrator SHALL drive the task to a terminal lifecycle state and release its concurrency slot on that SINGLE exit — it SHALL NOT leave the task in `running` with a held slot. A resolved exit code of zero SHALL transition the task to `completed`; a resolved non-zero exit code SHALL transition the task to `failed`; an abnormal termination (the session never established, or the exit code is unresolvable) SHALL force-fail the task. In every case the orchestrator SHALL invoke `SandboxProvider.teardownSandbox()`, tear down the session-scoped credentials, and free the concurrency slot (admitting the next queued task), reusing the same terminal-teardown path as natural completion. This closes the gap whereby a cleanly-exited or single-non-zero-exit session previously remained `running` and leaked its slot until idle reclamation or a process restart — a gap that becomes a permanent leak once idle reclamation is off by default.

#### Scenario: Clean exit completes the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved code of zero
- **THEN** the orchestrator transitions the task to `completed`, tears down its sandbox and session credentials, and frees its concurrency slot

#### Scenario: Non-zero exit fails the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved non-zero code
- **THEN** the orchestrator transitions the task to `failed`, tears down its sandbox and session credentials, and frees its concurrency slot on that first exit

#### Scenario: Abnormal termination force-fails the task and frees the slot
- **WHEN** a running task's terminal session closes before being established, or its exit code cannot be resolved
- **THEN** the orchestrator force-fails the task, tears down its sandbox, and frees its concurrency slot

#### Scenario: Terminal teardown is idempotent under concurrent close handling
- **WHEN** the exit-driven terminal transition runs while the terminal gateway is also handling the same session's close
- **THEN** the teardown + slot release completes exactly once without error (double-calls to teardown and slot release are tolerated)

### Requirement: Startup recovery reclaims orphaned tasks and re-offers queued tasks
On application bootstrap the orchestrator SHALL perform a two-phase recovery so a process restart never strands work. Phase 1 (reclaim): every task persisted as `running` or `awaiting_input` — whose in-memory session and sandbox did not survive the restart — SHALL be transitioned to `failed`. Phase 2 (re-offer): after the persisted ceiling override has been loaded into the semaphore, every task persisted as `queued` SHALL be re-offered to the concurrency semaphore in `createdAt` ascending (FIFO) order, restoring each task's persisted per-task guardrail parameters (`deadlineMs`, `idleTimeoutMs`) from its task row; tasks within the post-reclaim capacity are admitted and the remainder stay queued in that order. A task persisted as `queued` SHALL NOT remain stranded (never re-offered) after a restart.

#### Scenario: Orphaned running tasks are failed at startup
- **WHEN** the process restarts while the database holds tasks in `running` or `awaiting_input`
- **THEN** bootstrap transitions each of those tasks to `failed` before any queued task is re-offered

#### Scenario: Queued tasks are re-offered in FIFO order at startup
- **WHEN** the process restarts while the database holds K tasks in `queued` and the effective ceiling is M
- **THEN** bootstrap re-offers all K tasks to the semaphore in `createdAt` ascending order, the oldest min(K, M) begin admission, and the remaining K − min(K, M) stay `queued` in that order rather than being lost

#### Scenario: Persisted guardrail parameters are restored on re-offer
- **WHEN** a re-offered queued task was created with a `deadlineMs` and/or `idleTimeoutMs` persisted on its task row
- **THEN** once that task is admitted after the restart, its deadline watcher and idle ceiling arm with those persisted values, identical to a task admitted before the restart

#### Scenario: The persisted ceiling is loaded before queued re-offer
- **WHEN** the process restarts with a persisted ceiling of 2, `MAX_CONCURRENT_TASKS=5`, and 3 queued tasks in the database
- **THEN** the re-offer admits exactly 2 tasks (the persisted ceiling), not 5, proving the DB override is applied before the queued re-offer runs

