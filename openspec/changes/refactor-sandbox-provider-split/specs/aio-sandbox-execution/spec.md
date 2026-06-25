## MODIFIED Requirements

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL accept a provider-neutral provision context carrying the task id and optional clone spec. The clone spec SHALL be resolved before provider selection and passed into the selected provider, so the local AIO provider does not need API-local task lookup logic. The provider SHALL still return the addressable `SandboxConnection { taskId, baseUrl, wsUrl }` and preserve the dedicated workspace clone/fail-closed behavior.

#### Scenario: Provision receives an explicit clone spec
- **WHEN** the API admits a task and selects the local AIO provider
- **THEN** it passes a provision context containing the task id and the resolved clone spec
- **AND** the provider uses that clone spec for repository setup instead of reading task state through API internals

#### Scenario: AIO remains the default local provider
- **WHEN** no cloud sandbox provider is configured
- **THEN** task provisioning uses the local AIO provider through the shared sandbox facade
- **AND** the returned connection remains addressable by container name over `cap-net`

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
