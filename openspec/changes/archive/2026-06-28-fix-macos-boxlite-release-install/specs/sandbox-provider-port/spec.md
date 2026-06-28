## ADDED Requirements

### Requirement: Explicit provider selection constrains eligible providers

When an operator explicitly selects a sandbox provider through deployment configuration, the scheduler registry SHALL restrict provisioning to that provider family. If the explicitly selected provider is unavailable, invalid, or missing required capabilities, provisioning SHALL fail closed with a provider-selection error instead of silently falling back to another provider.

#### Scenario: Explicit BoxLite does not fall back to AIO

- **WHEN** `CAP_SANDBOX_PROVIDER=boxlite` is configured
- **AND** BoxLite is invalid, unreachable, or missing required capabilities
- **THEN** task provisioning fails with a BoxLite/provider-selection error
- **AND** the scheduler does not provision an AIO sandbox as a fallback

#### Scenario: Explicit AIO does not select BoxLite

- **WHEN** `CAP_SANDBOX_PROVIDER=aio` is configured
- **THEN** the scheduler considers only AIO-compatible providers for task provisioning
- **AND** a configured BoxLite provider is not selected for new tasks

#### Scenario: Auto mode keeps capability selection

- **WHEN** `CAP_SANDBOX_PROVIDER=auto` or the variable is absent
- **THEN** platform policy chooses the default eligible provider family
- **AND** selection within that family still uses declared capabilities and priorities

### Requirement: Provider-selection errors are actionable

Provider-selection failures SHALL include the selected provider family and the missing or invalid dependency that prevented provisioning.

#### Scenario: Missing capability is reported

- **WHEN** the selected provider family lacks a capability required by the task's provision plan
- **THEN** the provisioning error names the provider family and the missing capabilities
