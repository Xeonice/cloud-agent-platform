## MODIFIED Requirements

### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL expose sandbox providers through provider descriptors that include an id, location (`local` or `cloud`), priority, supported capabilities, and the provider implementation. Capability selection SHALL be provider-neutral: callers declare required capabilities, the scheduler SHALL consider only providers satisfying all required capabilities, and selection SHALL order candidates by priority with optional preferred-location tie-breaking. The legacy sandbox mode remains informational metadata and MUST NOT be the scheduling boundary.

Reusable provider contracts, capability helpers, scheduler logic, lifecycle helpers, workspace clone planning, local AIO provider code, cloud HTTP provider code, and conformance tests SHALL live in dedicated workspace packages rather than inside `@cap/api`, so future providers can be added without importing API internals.

#### Scenario: Provider selection is capability based
- **WHEN** a task requires a set of sandbox capabilities
- **THEN** the scheduler only selects a provider whose descriptor advertises every required capability
- **AND** if multiple providers qualify, priority and optional preferred location determine the winner

#### Scenario: Local and cloud providers share the same port
- **WHEN** both local AIO and cloud HTTP providers are configured
- **THEN** the API consumes them through the same provider descriptor and `SandboxProvider` surface
- **AND** it does not branch on concrete implementation classes to provision a task

#### Scenario: Sandbox package boundaries are enforceable
- **WHEN** sandbox provider logic is inspected
- **THEN** reusable contracts, scheduler, lifecycle, workspace-git, local AIO, cloud HTTP, conformance, and facade code live in workspace packages
- **AND** `@cap/api` imports package surfaces rather than duplicating those reusable primitives locally

### Requirement: The transcript read is generalized behind a runtime-declared source-read strategy
The provider transcript read SHALL remain generalized behind runtime-declared artifact/source strategy, and the API SHALL consume a provider-neutral `TranscriptSource` rather than assuming the local AIO retained container. When multiple providers are available, transcript reads SHALL be routed through the provider/facade capable of materializing the retained source for the task and runtime.

#### Scenario: Transcript read is provider-neutral
- **WHEN** the API reads a retained transcript for a task
- **THEN** it requests the runtime-tagged source through the sandbox provider/facade seam
- **AND** parsing is selected from the returned runtime format rather than from a concrete provider class

#### Scenario: Missing retained source remains non-throwing
- **WHEN** no provider can materialize a retained transcript source for the task
- **THEN** the read resolves to an absent source rather than throwing
