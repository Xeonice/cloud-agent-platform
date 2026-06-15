## MODIFIED Requirements

### Requirement: Per-task AIO Sandbox container provisioning
The system SHALL provision exactly one AIO Sandbox container per task via dockerode `createContainer`, naming it `cap-aio-<taskId>` from the pinned derived AIO image, configured with `HostConfig.SecurityOpt` containing `seccomp=unconfined`, capable of joining the `cap-net` user-defined network, with `ShmSize` of approximately 2g and `AutoRemove` DISABLED (`HostConfig.AutoRemove: false`), and with NO `PortBindings` so the container publishes no host port. After starting the container the system SHALL poll the sandbox `/v1/docs` endpoint until it responds (readiness) before treating the sandbox as usable.

Because `AutoRemove` is disabled, a terminal task's container SHALL be RETAINED in a stopped state rather than removed: `teardownSandbox` SHALL be a STOP-ONLY operation (it stops the container and SHALL NOT issue a `remove`), so the frozen container filesystem — including the codex `rollout-*.jsonl` session record under `/home/gem/.codex/sessions/` — survives for later read-only replay. BEFORE the stop, while the container is still running and its `/v1/shell/exec` surface is reachable, `teardownSandbox` SHALL trim `/home/gem/.codex` over `/v1/shell/exec` — deleting the codex cache and `logs_*.sqlite` files while KEEPING `/home/gem/.codex/sessions/` and the workspace — and SHALL clear (zero/empty) `/home/gem/.codex/auth.json` as cheap defense-in-depth, so the retained stopped container holds a bounded footprint and no usable credential. A pre-stop trim/clear failure SHALL NOT block the stop+retain. This is a **BREAKING** change for any consumer that assumed a terminal task's `cap-aio-*` container no longer exists.

#### Scenario: Container is created with required security and network options
- **WHEN** `AioSandboxProvider` provisions a sandbox for a task with id `<taskId>`
- **THEN** it calls dockerode `createContainer` with name `cap-aio-<taskId>` from the pinned AIO image
- **AND** `HostConfig.SecurityOpt` includes `seccomp=unconfined`
- **AND** the container is attached to the `cap-net` network with no `PortBindings` so no host port is published

#### Scenario: Container is created with AutoRemove disabled
- **WHEN** `AioSandboxProvider` provisions a sandbox for a task
- **THEN** `HostConfig.AutoRemove` is `false`, so the Docker daemon does not auto-remove the container when its process exits

#### Scenario: Readiness is confirmed by polling /v1/docs
- **WHEN** the container has been started
- **THEN** the provider polls `GET /v1/docs` on the sandbox and does not return the sandbox as ready until that endpoint responds successfully

#### Scenario: seccomp=unconfined is required
- **WHEN** the container is created without `seccomp=unconfined` in `HostConfig.SecurityOpt`
- **THEN** provisioning is treated as invalid and the sandbox is not used for task execution

#### Scenario: Teardown stops and retains the container without removing it
- **WHEN** a terminal task's `teardownSandbox` runs
- **THEN** the container is stopped and NOT removed, so `docker inspect cap-aio-<taskId>` after teardown reports an `Exited` (stopped) container rather than "No such container"

#### Scenario: Pre-stop trim drops caches and clears auth before stopping
- **WHEN** `teardownSandbox` runs while the container is still running
- **THEN** it trims `/home/gem/.codex` over `/v1/shell/exec` (deleting the codex cache and `logs_*.sqlite`, keeping `/home/gem/.codex/sessions/` and the workspace) and clears `/home/gem/.codex/auth.json`, BEFORE issuing the container stop
- **AND** a failure of the trim/clear does not prevent the container from being stopped and retained
