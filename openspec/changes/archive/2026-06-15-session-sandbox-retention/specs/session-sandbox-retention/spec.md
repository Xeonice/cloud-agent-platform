## ADDED Requirements

### Requirement: Terminal-state sandbox containers are retained, not removed
When a task reaches a terminal lifecycle state (`completed`, `cancelled`, or `failed`), the orchestrator SHALL retain that task's `cap-aio-<taskId>` container in a STOPPED state rather than removing it, so the frozen container filesystem (including the codex `rollout-*.jsonl` session record) survives for later read-only replay. Containers SHALL be created with `HostConfig.AutoRemove: false` so the Docker daemon does NOT auto-remove the container on exit, and the terminal teardown path SHALL stop the container WITHOUT a subsequent `remove`. Retention SHALL apply to BOTH terminal chokepoints — natural completion and `forceFail` (covering all abnormal causes including deadline, idle, circuit-breaker, abnormal-exit, and provision-failed) — and SHALL apply EVEN when the task terminated abnormally (e.g. via SIGKILL), because killing the container's processes does not destroy its filesystem. Freeing the task's concurrency slot SHALL remain unchanged; only the container removal is suppressed.

This is a **BREAKING** change for any consumer that assumes a terminal task's `cap-aio-*` container no longer exists.

#### Scenario: Container is created with AutoRemove disabled
- **WHEN** the orchestrator provisions a `cap-aio-<taskId>` container for a task
- **THEN** `HostConfig.AutoRemove` is `false`
- **AND** the Docker daemon does not auto-remove the container when the container process exits

#### Scenario: Terminal teardown stops but does not remove the container
- **WHEN** a task reaches a terminal state and the orchestrator invokes the terminal teardown path
- **THEN** the container is stopped
- **AND** no `remove` is issued for that container, so a `docker inspect` of `cap-aio-<taskId>` after teardown reports an `Exited` (stopped) container rather than "No such container"

#### Scenario: Abnormally-terminated tasks are still retained
- **WHEN** a task is force-failed for an abnormal cause (deadline, idle, circuit-breaker, abnormal-exit, or provision-failed) and its container process is killed
- **THEN** the container is stopped-and-retained (not removed), and its filesystem — including any `rollout-*.jsonl` written before the interruption — remains readable from the stopped container

#### Scenario: Slot is still freed on retention
- **WHEN** a running task reaches a terminal state and its container is retained instead of removed
- **THEN** the task's concurrency slot is still released and the next queued task may be admitted, identical to the pre-retention behavior

### Requirement: Pre-stop cache trim and auth.json clear bound the retained footprint
Before stopping a terminal task's container — while the container is still RUNNING and its `/v1/shell/exec` surface is reachable — the orchestrator SHALL trim `/home/gem/.codex` to bound the retained writable-layer footprint: it SHALL delete the codex cache and the `logs_*.sqlite` files, and SHALL KEEP the `/home/gem/.codex/sessions/` directory (which holds the `rollout-*.jsonl` records) and the task workspace intact, reducing a multi-turn container's writable layer from roughly 106 MB toward roughly 15 MB. As cheap defense-in-depth the orchestrator SHALL ALSO clear (zero/empty) `/home/gem/.codex/auth.json` before the stop, so retained containers do not hold a usable credential. The trim and clear SHALL run over the existing `/v1/shell/exec` channel BEFORE the stop call (never after, when the exec surface is gone), and a trim/clear failure SHALL NOT block the stop+retain from proceeding (the retain is the load-bearing outcome).

#### Scenario: Cache and logs are dropped, sessions are kept
- **WHEN** the orchestrator runs the pre-stop trim on a terminal task's running container
- **THEN** the codex cache and `/home/gem/.codex/logs_*.sqlite` files are deleted
- **AND** `/home/gem/.codex/sessions/` (containing `rollout-*.jsonl`) and the task workspace remain present in the retained container

#### Scenario: auth.json is cleared before stop
- **WHEN** the pre-stop trim runs before the container is stopped
- **THEN** `/home/gem/.codex/auth.json` is cleared (zeroed/emptied) so the retained stopped container holds no usable credential

#### Scenario: Trim runs while the container is still running
- **WHEN** the terminal teardown executes the pre-stop trim
- **THEN** the trim is issued over `/v1/shell/exec` before the container `stop` call, while the exec surface is still reachable, not after the container has been stopped

#### Scenario: A trim failure does not block retention
- **WHEN** the pre-stop trim or `auth.json` clear fails (e.g. the exec surface is unreachable)
- **THEN** the container is still stopped and retained, and the failure does not prevent the stop+retain

### Requirement: Multi-policy retention cleaner reaps stopped retained containers
The orchestrator SHALL run a periodic, unref'd retention cleaner (modeled on the existing `CodexDeviceLoginService` sweep) that removes STOPPED `cap-aio-*` containers under MULTIPLE simultaneous policies, removing a container when ANY policy trips. Policy 1 (age): a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window SHALL be removed. The retention window SHALL be read from account settings (the persisted retention-days value, default 30 days when unset). Policy 2 (free-disk high-water-mark): when host free disk drops below a configured floor, the cleaner SHALL evict OLDEST-stopped `cap-aio-*` containers FIRST until free disk recovers above the floor, even if those containers are younger than the retention window, because age alone cannot bound disk under a burst. The cleaner SHALL only ever remove containers that are STOPPED and carry the `cap-aio-*` identity — it SHALL NEVER remove a RUNNING container. The cleaner SHALL carry an in-process `isRunning` overlap guard so a slow sweep never overlaps the next tick, and the single-instance assumption SHALL be stated explicitly (no distributed lock; a multi-replica deployment would require one).

#### Scenario: A stopped container past the retention window is reaped
- **WHEN** the cleaner sweeps and finds a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window
- **THEN** the cleaner removes that container

#### Scenario: Retention window is read from settings with a 30-day default
- **WHEN** the cleaner resolves the retention window and no retention-days value is persisted in account settings
- **THEN** it uses a default of 30 days
- **AND** when a retention-days value IS persisted, the cleaner uses the persisted value instead of the default

#### Scenario: Low free disk evicts the oldest stopped containers first
- **WHEN** host free disk is below the configured high-water-mark floor and stopped `cap-aio-*` containers exist that are younger than the retention window
- **THEN** the cleaner removes the OLDEST-stopped containers first until free disk recovers above the floor, even though those containers have not yet aged out

#### Scenario: Running containers are never reaped by the cleaner
- **WHEN** the cleaner sweeps while a `cap-aio-*` container is RUNNING (an active task), regardless of its age or the free-disk level
- **THEN** the cleaner does not remove that running container

#### Scenario: Overlapping sweeps are prevented by the in-process guard
- **WHEN** a cleaner sweep is still in progress and the next scheduled tick fires
- **THEN** the second tick is skipped by the `isRunning` guard and only one sweep runs at a time
