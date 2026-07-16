## ADDED Requirements

### Requirement: Sandbox environments carry validated provisioning resource limits

A managed sandbox environment SHALL carry an OPTIONAL, dedicated, non-secret
provisioning resource policy separate from guest image parameters, initially
including a positive integer disk-size limit. Environment validation SHALL
verify that the selected provider supports and can enforce every explicit
resource, and environment resolution SHALL produce an immutable resource
snapshot used by both validation probes and task provisioning. When an
environment omits a resource, the provider's validated deployment fallback
SHALL be resolved and snapshotted; mutable fallback changes SHALL NOT rewrite an
existing task's resolved provisioning metadata. Resource controls SHALL NOT be
injected into the guest as runtime parameters or exposed with provider secrets.

#### Scenario: Explicit BoxLite disk size is resolved immutably

- **WHEN** an admin validates a BoxLite environment with an explicit disk-size resource and a task later selects it
- **THEN** validation and task provisioning use the same validated disk size
- **AND** the resolved value is retained in the task's non-secret immutable environment/run metadata

#### Scenario: Legacy environment uses the provider fallback

- **WHEN** an existing environment has no resource policy
- **THEN** it remains valid and resolves the BoxLite deployment disk fallback
- **AND** the resolved value is snapshotted for the task rather than read again during recovery

#### Scenario: Unsupported resource fails environment validation

- **WHEN** an environment requests a resource the selected provider does not advertise or cannot enforce
- **THEN** validation fails with an actionable non-secret reason
- **AND** the environment cannot be selected for a new task

#### Scenario: Provisioning resources are not guest parameters

- **WHEN** a task uses an environment with a disk-size resource and separate image parameters
- **THEN** the provider receives the disk-size resource before sandbox creation
- **AND** only the declared image parameters follow the existing guest materialization path
