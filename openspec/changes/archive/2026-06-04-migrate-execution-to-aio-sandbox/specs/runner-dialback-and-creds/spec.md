## REMOVED Requirements

### Requirement: Runner dials back to the orchestrator
**Reason**: The execution model inverts from dial-back OUT to connect-in IN. The orchestrator no longer waits for a runner to dial back as a WS server; instead it dockerode-creates a per-task AIO Sandbox container and connects INTO its terminal WebSocket as a WS client, addressing the sandbox by container name over `cap-net`. There is no runner to initiate an outbound connection.
**Migration**: Replace the dial-back runner with `AioPtyClient` connect-in: the orchestrator opens an OUTBOUND WebSocket to `ws://cap-aio-<taskId>:8080/v1/shell/ws`. Network isolation (sandboxes publish no host port and live only on `cap-net`) replaces the "no inbound port" property the dial-back model provided.

#### Scenario: No runner dials back after removal
- **WHEN** a task starts under the AIO connect-in model
- **THEN** no runner opens an outbound WebSocket to the orchestrator
- **AND** the orchestrator instead connects INTO the sandbox terminal WebSocket by container name over `cap-net`

### Requirement: Dial-back handshake authenticated by a short-lived TASK_TOKEN
**Reason**: With the connect-in model there is no inbound runner connection to authenticate, so the `dialback_handshake` frame and its `TASK_TOKEN` are obsolete. The orchestrator addresses the sandbox directly by container name and there is no dial-back token to verify.
**Migration**: Remove the `dialback_handshake` contracts frame and the `TaskTokenService` dial-back verify path. The sandbox is reached over `cap-net` by container name; trust is provided by network isolation rather than a per-task dial-back token.

#### Scenario: No dial-back handshake frame is exchanged
- **WHEN** the orchestrator establishes the sandbox terminal connection under the AIO model
- **THEN** no `dialback_handshake` frame and no `TASK_TOKEN` are exchanged
- **AND** the connection is addressed by sandbox container name over `cap-net` with no dial-back token verification

### Requirement: Per-task token scope and one-task binding
**Reason**: The `TASK_TOKEN` existed solely to bind a dial-back connection to one task. Under connect-in the orchestrator already knows which sandbox it dialed (by container name `cap-aio-<taskId>`), so per-task token scoping is no longer meaningful.
**Migration**: Drop `TASK_TOKEN` entirely; the orchestrator's own dialed-by-name connection to `cap-aio-<taskId>` provides the one-task binding that the token previously enforced.

#### Scenario: Task binding comes from the dialed container name
- **WHEN** the orchestrator connects to a sandbox for a task
- **THEN** the task binding is established by the dialed container name `cap-aio-<taskId>`
- **AND** no per-task `TASK_TOKEN` is issued or validated

### Requirement: Ephemeral credentials destroyed with the session
**Reason**: The sandbox-scoped dial-back credentials (the per-task `TASK_TOKEN` and `ORCHESTRATOR_WS_URL` runner env) were artifacts of the runner provisioning the orchestrator no longer performs. Under connect-in the safety boundary is network isolation plus per-task container teardown, not session-bound dial-back credentials.
**Migration**: Remove the ephemeral dial-back credentials and the `ORCHESTRATOR_WS_URL`/`RUNNER_IMAGE`/`RUNNER_AGENT_BIN`/`TASK_TOKEN` env. Session teardown is handled by stopping and removing the per-task AIO container (`AutoRemove`), and the security boundary becomes network isolation on `cap-net`.

#### Scenario: No dial-back credentials are provisioned or revoked
- **WHEN** a task session starts and later ends under the AIO model
- **THEN** no ephemeral dial-back credentials (`TASK_TOKEN`, `ORCHESTRATOR_WS_URL`) are provisioned for the session
- **AND** session teardown is performed by stopping and removing the per-task AIO container rather than by destroying dial-back credentials
