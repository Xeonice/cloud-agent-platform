# guardrails Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Concurrency semaphore bounds running tasks
The orchestrator SHALL enforce a configured maximum number of concurrently running tasks (`MAX_CONCURRENT_TASKS`). When the limit is reached, newly created tasks SHALL remain queued rather than provisioning a sandbox, and when a running task reaches a terminal state (completed/failed/cancelled) the orchestrator SHALL admit the next queued task in FIFO order.

#### Scenario: Task over the limit stays queued
- **WHEN** `MAX_CONCURRENT_TASKS` tasks are already running and a new task is created
- **THEN** the new task remains in the queued state and no sandbox is provisioned for it

#### Scenario: Freeing a slot admits the next queued task
- **WHEN** a running task reaches a terminal state while at least one task is queued
- **THEN** the orchestrator provisions the oldest queued task, bringing the running count back to at most `MAX_CONCURRENT_TASKS`

### Requirement: Wall-clock deadline force-fails a task
A task MAY carry a wall-clock deadline, supplied via the task create request (`deadlineMs`) and passed to concurrency admission (`admit(taskId, deadlineMs)`) so the deadline watcher arms. When a running task passes its deadline, the orchestrator SHALL transition it to `failed`, invoke `SandboxProvider.teardownSandbox()` for the task, and free its concurrency slot. Teardown is a **port-level** call: per design D9 the deferred minimal Docker provider documents it as a no-op (Docker is the deploy plane, not the per-task execution sandbox), while a future OS-isolating provider performs a real teardown through the same port.

#### Scenario: Task exceeding its deadline is failed and torn down
- **WHEN** a running task's wall-clock deadline passes
- **THEN** the orchestrator transitions the task to `failed`, invokes `SandboxProvider.teardownSandbox()` for the task, and releases its concurrency slot

#### Scenario: Task finishing before its deadline is unaffected
- **WHEN** a task reaches a terminal state before its deadline
- **THEN** no deadline-based force-fail is applied

### Requirement: Idle ceiling reclaims wedged tasks
The orchestrator SHALL track per-task idle time (no terminal output and no agent-hook activity). When idle exceeds a configured ceiling (`MAX_IDLE`), the orchestrator SHALL force-fail the task and free its slot, so a wedged session cannot hold a slot indefinitely. (Distinct from the shorter "awaiting input" notification driven by the `Stop` hook, which does not fail the task.)

#### Scenario: Task idle beyond the ceiling is reclaimed
- **WHEN** a running task produces no terminal output and no hook activity for longer than `MAX_IDLE`
- **THEN** the orchestrator force-fails the task, invokes `SandboxProvider.teardownSandbox()` for the task, and frees its slot

#### Scenario: Activity resets the idle timer
- **WHEN** a task emits terminal output or a hook event before reaching `MAX_IDLE`
- **THEN** the idle timer resets and the task is not force-failed

### Requirement: Circuit breaker on repeated start/turn failure
The orchestrator SHALL count consecutive agent-failed-to-start (and turn-failure) events for a task and, on reaching a configured threshold, SHALL circuit-break the task to `failed` without further automatic retry, preventing a burn loop.

#### Scenario: Threshold consecutive failures trip the breaker
- **WHEN** a task accumulates the configured number of consecutive start/turn failures
- **THEN** the orchestrator transitions it to `failed` and does not automatically retry

#### Scenario: A success resets the failure counter
- **WHEN** a task records a successful start/turn before reaching the threshold
- **THEN** the consecutive-failure counter resets to zero
