## ADDED Requirements

### Requirement: Delivery runs through the selected provider executor

Workspace delivery SHALL execute inside the sandbox owned by the task's selected provider. The delivery path SHALL use the selected run context or durable provider owner to obtain the command executor and workspace path, rather than assuming an AIO `/v1/shell/exec` endpoint.

#### Scenario: BoxLite task delivers through BoxLite executor
- **WHEN** a completed BoxLite-backed task with `deliver != 'none'` has workspace changes
- **THEN** commit, branch, and push commands run in the BoxLite-owned sandbox through the BoxLite command executor
- **AND** the change-request HTTP calls still run platform-side through the forge port

#### Scenario: AIO delivery behavior is preserved
- **WHEN** a completed AIO-backed task is delivered after this change
- **THEN** delivery still runs in the AIO-owned sandbox and produces the same persisted delivery fields as before

### Requirement: Delivery requires proven provider ownership and capability

The system SHALL attempt workspace delivery only when the provider owner for the task is known or reattached and that provider advertises delivery support. If ownership cannot be proven or the provider lacks delivery capability, the delivery attempt SHALL be recorded as skipped or failed according to the existing best-effort delivery result rules, and task settling SHALL continue.

#### Scenario: Unknown owner is not guessed
- **WHEN** a completed task requests delivery but no provider owner can be resolved
- **THEN** the system does not guess a writer provider
- **AND** it records a delivery skip or failure without blocking teardown or slot release

#### Scenario: Provider without delivery capability is not used
- **WHEN** the owning provider does not advertise workspace delivery capability
- **THEN** the system does not run git delivery commands through that provider
- **AND** it records the unsupported delivery result without failing the completed task lifecycle

### Requirement: Workspace bridge supplies delivery inputs

The selected provider workspace descriptor SHALL supply the workspace path and materialization mode needed by delivery. Providers MAY use git clone or archive materialization internally, but delivery SHALL receive a consistent workspace path with a valid git working tree when `workspace.git.deliver` is advertised.

#### Scenario: Archive materialization still supports git delivery
- **WHEN** a provider materializes the workspace by archive but advertises git delivery
- **THEN** the workspace descriptor points delivery to a valid git working tree inside the provider sandbox
