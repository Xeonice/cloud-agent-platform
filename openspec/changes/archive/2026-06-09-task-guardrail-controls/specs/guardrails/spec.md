## MODIFIED Requirements

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

## ADDED Requirements

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
