## ADDED Requirements

### Requirement: Provision context carries a resolved sandbox environment

The sandbox provider port SHALL allow callers to pass a resolved sandbox
environment through `SandboxProvisionContext`. The resolved environment SHALL be
provider-neutral and non-secret. Providers SHALL consume this resolved metadata
instead of independently reading task or environment database rows.

#### Scenario: Provider receives resolved environment during provisioning

- **WHEN** a task is provisioned with a selected sandbox environment
- **THEN** `provision()` receives a `ProvisionContext` that includes the resolved
  environment metadata
- **AND** the provider does not query Prisma or task services to discover the
  environment

#### Scenario: Missing required environment fails closed

- **WHEN** a provider needs a resolved environment but none can be resolved from
  the task selection or deployment default
- **THEN** provider selection or provisioning fails with an environment
  resolution error
- **AND** the scheduler does not silently choose a different provider family to
  hide the mismatch

### Requirement: Selected run context carries environment metadata

The selected sandbox run context and durable owner metadata SHALL include
non-secret resolved environment metadata for provisioned tasks. Lifecycle steps
SHALL route through the selected provider owner and retain the environment
metadata for readoption, debugging, and task read surfaces.

#### Scenario: Selected run exposes environment metadata

- **WHEN** a sandbox run is selected or reattached after provisioning
- **THEN** the selected run context includes the environment id/source metadata
  that was used at provision time
- **AND** lifecycle steps do not re-resolve a new environment for that existing
  sandbox

#### Scenario: Owner record persists environment metadata

- **WHEN** the provider router records sandbox ownership for a provisioned task
- **THEN** the durable owner record includes non-secret environment metadata
- **AND** API restart readoption can report the environment that was used without
  reselecting a provider
