## ADDED Requirements

### Requirement: Optional cloud sandbox provider configuration is capability gated
The API MAY register a managed HTTP sandbox provider when `CAP_SANDBOX_CLOUD_HTTP_BASE_URL` is configured. That provider SHALL advertise only configured capabilities, SHALL default to `terminal.websocket` when no explicit capability list is provided, and SHALL NOT be selected for requirements it does not advertise. Local AIO priority and cloud priority SHALL be configurable, and `CAP_SANDBOX_PREFER_LOCATION` MAY bias equivalent candidates.

#### Scenario: Cloud provider is not registered without a base URL
- **WHEN** `CAP_SANDBOX_CLOUD_HTTP_BASE_URL` is unset
- **THEN** no cloud HTTP provider is registered
- **AND** local AIO remains available as the default provider

#### Scenario: Cloud capabilities gate selection
- **WHEN** the cloud HTTP provider is configured with a limited capability set
- **THEN** it is only eligible for tasks whose required capabilities are fully covered by that set
- **AND** tasks requiring unsupported capabilities select another provider or fail closed

#### Scenario: No eligible provider fails closed
- **WHEN** task provisioning requires capabilities that no registered provider satisfies
- **THEN** the task is failed with a provision failure rather than silently falling back to an incompatible provider

## MODIFIED Requirements

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL accept a provider-neutral provision context carrying the task id and optional clone spec. The clone spec SHALL be resolved before provider selection and passed into the selected provider, so the local AIO provider does not need API-local task lookup logic. The provider SHALL return a `SandboxConnection` handle carrying `taskId`, an HTTP `baseUrl` of the form `http://cap-aio-<taskId>:8080`, and a `wsUrl` of the form `ws://cap-aio-<taskId>:8080/v1/shell/ws`, so that the orchestrator can address the sandbox by container name over `cap-net` and open the terminal WebSocket. The provider SHALL also clone the task repository into a DEDICATED, EMPTY workspace directory (e.g. `/home/gem/workspace`) — never into the non-empty `/home/gem` HOME — via `POST /v1/shell/exec` before returning the handle. The provider SHALL PARSE the `/v1/shell/exec` response body, treating a non-zero command `exit_code` (not merely a non-`ok` HTTP status) as a provisioning failure, and SHALL surface a real provision error rather than logging success on a silent clone failure.

The clone success path and the clone fail-closed path SHALL be VERIFIED END-TO-END on a live compose stack (not merely unit-tested), as fossilized black-box regression scenarios in the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`): cloning into the dedicated empty workspace directory SHALL succeed with an asserted zero `exit_code`; a FORCED clone failure (non-empty target directory or bad repository URL) SHALL raise a non-zero exit_code with NO silent success. The `AioApprovalEnforcer` exec-gate is NOT verified end-to-end in this change: the enforcer class is fail-closed (covered by unit tests) but is currently DORMANT — there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through it (it is wired as a DI provider for future use); see the `agent-events-and-approvals` spec for the honest coverage statement.

#### Scenario: Provision receives an explicit clone spec
- **WHEN** the API admits a task and selects the local AIO provider
- **THEN** it passes a provision context containing the task id and the resolved clone spec
- **AND** the provider uses that clone spec for repository setup instead of reading task state through API internals

#### Scenario: AIO remains the default local provider
- **WHEN** no cloud sandbox provider is configured
- **THEN** task provisioning uses the local AIO provider through the shared sandbox facade
- **AND** the returned connection remains addressable by container name over `cap-net`

#### Scenario: Provision returns an addressable connection handle
- **WHEN** provisioning completes for task `<taskId>`
- **THEN** the returned `SandboxConnection` has `taskId` set, `baseUrl` equal to `http://cap-aio-<taskId>:8080`, and `wsUrl` equal to `ws://cap-aio-<taskId>:8080/v1/shell/ws`

#### Scenario: Task repository is cloned into a dedicated empty workspace dir before the handle is returned
- **WHEN** the sandbox is ready and before `provision()` returns
- **THEN** the provider issues a git clone of the task repository into a dedicated, empty workspace directory (e.g. `/home/gem/workspace`) via `POST /v1/shell/exec`
- **AND** it does NOT clone into the non-empty `/home/gem` HOME directory

#### Scenario: Clone failure surfaces a provision error instead of silent success
- **WHEN** the `POST /v1/shell/exec` clone command returns a non-zero `exit_code` in its response body (for example because the destination already exists or is non-empty)
- **THEN** the provider parses the response `exit_code`/`output` and raises a provisioning error
- **AND** it does NOT log "cloned task repository" or otherwise report success on a failed clone

#### Scenario: Clone success is verified end-to-end on a live compose stack
- **WHEN** the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) provisions a real sandbox and clones the task repository into the dedicated empty `/home/gem/workspace` via `POST /v1/shell/exec`
- **THEN** the clone command returns a zero `exit_code` and the e2e assertion passes that the repository is present in the workspace directory
- **AND** no provisioning error is raised on the success path

#### Scenario: Forced clone failure fails closed end-to-end with no silent success
- **WHEN** the compose e2e suite forces a clone failure (a non-empty target directory or a bad repository URL) via `POST /v1/shell/exec`
- **THEN** the provider parses the non-zero `exit_code` and the e2e suite observes a real provisioning error
- **AND** the suite asserts there is NO "cloned task repository" / silent success log on the failed clone

#### Scenario: Enforcer exec-gate class is fail-closed; no live gated call site exists
- **WHEN** the `AioApprovalEnforcer` class is evaluated for its fail-closed contract
- **THEN** the class resolves `allow` to `allowed:true`, and resolves `deny`, an approval error, or decision timeout to `allowed:false` (fail closed) — covered by unit tests
- **AND** this contract is NOT currently exercised end-to-end: there are no cap-owned gated `/v1/shell/exec` call sites in production code that route through the enforcer; it is registered as a DI provider (`AIO_APPROVAL_ENFORCER`) for future use but is dormant
- **AND** the spec does NOT claim this gate is live in the current production stack
