## MODIFIED Requirements

### Requirement: Idle ceiling reclaims wedged tasks
Idle reclamation SHALL be OPT-IN PER TASK and OFF BY DEFAULT. The orchestrator SHALL track a running task's idle time (no terminal output and no agent-hook activity) and reclaim it on exceeding an idle ceiling ONLY when an idle ceiling is in effect for that task. An idle ceiling is in effect when the task carries an explicit per-task `idleTimeoutMs` (supplied via the task create request and passed through concurrency admission), OR when an operator-level global default is configured (`MAX_IDLE_MS`). When NEITHER is present — the default for a task created without an idle timeout in a deployment that has not set `MAX_IDLE_MS` — the task SHALL NOT be idle-tracked and SHALL NEVER be reclaimed for idleness, so a resident continuous-conversation session that is quietly waiting for the next input is not reclaimed. The per-task `idleTimeoutMs` SHALL take precedence over the operator-level default. The idle ceiling is per task (not a single process-wide constant): when armed, the timer is sized to that task's effective ceiling and activity resets it against that same ceiling.

When a configured idle ceiling trips, the integration layer SHALL transition the task to `completed` (the graceful end of a resident session that went quiet), NOT a force-`failed` — idle reclamation of a resident conversation is a normal end of life, distinct from an abnormal death. (This remains distinct from the shorter "awaiting input" notification driven by the `Stop` hook, which does not end the task.) When an idle reclamation tears down the sandbox, `SandboxProvider.teardownSandbox()` is STOP-ONLY for the AIO provider (the container is retained for read-only replay), and the slot is still freed.

#### Scenario: Task without an idle ceiling is never idle-reclaimed
- **WHEN** a task is created without an `idleTimeoutMs` and the deployment has no `MAX_IDLE_MS` configured, then runs (or idles waiting for input) silently past any prior mark
- **THEN** the orchestrator does NOT idle-track the task and never reclaims it for idleness, holding its slot until it terminates by another path (operator stop, deadline, crash)

#### Scenario: A configured idle ceiling reclaims an idle task as completed
- **WHEN** a task is created WITH an explicit `idleTimeoutMs` (or the deployment sets `MAX_IDLE_MS`) and then produces no terminal output and no hook activity for longer than that ceiling
- **THEN** the task is reclaimed and transitions to `completed`, its sandbox is torn down STOP-ONLY (retained for replay), and its concurrency slot is freed

#### Scenario: Idle teardown is stop-only and frees the slot
- **WHEN** an idle reclamation invokes `teardownSandbox()` on the AIO provider
- **THEN** the container is stopped (not removed) so the session remains replayable, and the running slot is released for the next admission
