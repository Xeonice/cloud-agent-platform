## ADDED Requirements

### Requirement: Provider selection produces a selected run context

The sandbox scheduler SHALL produce a selected run context for each provisioned task instead of exposing only a raw provider object to downstream callers. The selected run context SHALL carry the selected provider id, effective capabilities, provider connection, terminal descriptor, command executor descriptor, workspace descriptor, image/runtime/preflight result, and retention/readoption policy needed by later lifecycle steps.

#### Scenario: Downstream lifecycle uses the same selected context
- **WHEN** a task is provisioned
- **THEN** runtime setup, terminal attach, delivery, transcript read, retention, teardown, and readoption consume the same selected run context or its durable owner record
- **AND** they do not independently re-select a provider for the already-provisioned task

#### Scenario: Missing selected context fails closed
- **WHEN** a lifecycle step requires a provider-owned sandbox but no selected run context or durable owner can be resolved
- **THEN** the step fails with a provider-owner error rather than guessing a writer provider

### Requirement: Capability vocabulary distinguishes provider features from CAP operations

The system SHALL maintain capability names for provider features such as command execution, interactive terminal transport, archive workspace transfer, retained transcript source, readoption, snapshot, sleep, and port exposure, while preserving operation-level required-capability helpers for CAP workflows. The scheduler SHALL match on capabilities rather than concrete provider class names.

#### Scenario: Provider feature capabilities compose into operation requirements
- **WHEN** CAP provisions an interactive task with workspace materialization
- **THEN** the planner resolves that operation into the required provider feature capabilities before selecting a provider

#### Scenario: Provider class checks are not used for selection
- **WHEN** AIO and BoxLite are both registered
- **THEN** selecting a provider for a task depends on declared capabilities, priority, and location preference, not on `instanceof` checks or provider names

### Requirement: Provider run ownership is durable enough for restart

After a provider successfully provisions a task sandbox, the system SHALL persist enough provider ownership metadata to reattach or tear down that sandbox after API restart. The metadata SHALL include at least the CAP task id, provider id, and provider sandbox identifier or connection key. Older tasks without persisted owner metadata MAY still use provider probing fallback.

#### Scenario: Restart reattaches through stored provider owner
- **WHEN** the API restarts while a task has a persisted provider owner record
- **THEN** readoption, terminal attach, delivery, and teardown first route through that provider owner

#### Scenario: Older tasks use probing fallback
- **WHEN** a retained or running task lacks persisted provider owner metadata
- **THEN** the system may probe compatible providers for backward compatibility
- **AND** it still does not deliver workspace changes through a provider that did not prove ownership

### Requirement: Workspace materialization is provider-neutral

The sandbox provider port SHALL expose workspace materialization and sync through provider-neutral descriptors or helpers. Implementations MAY use git clone, archive upload/download, provider file APIs, or provider-native volumes internally, but orchestration code SHALL not depend on those provider-specific mechanisms.

#### Scenario: Archive-backed provider materializes a workspace
- **WHEN** a provider supports archive upload/download rather than AIO-style git setup
- **THEN** CAP can materialize the selected workspace through the workspace descriptor without changing guardrails or terminal code

#### Scenario: Provider-native volumes are not canonical truth
- **WHEN** a provider uses a native volume or snapshot internally
- **THEN** CAP still treats its database, audit records, transcript archive, and configured workspace delivery as the durable truth

### Requirement: Provider conformance covers terminal, executor, workspace, and ownership contracts

Provider conformance SHALL verify not only basic provision/teardown shape, but also the provider's advertised terminal transport, command executor, workspace transfer, readoption, retention, transcript, and ownership behavior. A provider SHALL NOT advertise a capability that does not pass its conformance scenario.

#### Scenario: Terminal capability requires terminal conformance
- **WHEN** a provider declares interactive terminal capability
- **THEN** conformance verifies output, input, resize, close/replacement, and attach semantics

#### Scenario: Workspace delivery capability requires executor ownership
- **WHEN** a provider declares workspace delivery capability
- **THEN** conformance verifies delivery commands run in the provider-owned sandbox for the selected task
