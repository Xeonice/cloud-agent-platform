## ADDED Requirements

### Requirement: Admin can retire sandbox environment records

The system SHALL let an admin retire a sandbox environment record without direct
database edits. Retiring an environment SHALL mark it non-selectable, preserve
its non-secret source and validation history for audit, and clear its global
default marker if it was the default. Retired environments SHALL NOT be used as
task defaults, SHALL NOT be accepted as explicit task selections, and SHALL NOT
be listed as selectable user defaults.

#### Scenario: Admin retires a failed image import

- **WHEN** an admin retires a failed sandbox environment
- **THEN** the environment lifecycle status becomes non-selectable
- **AND** its validation history remains available for diagnosis
- **AND** no task can select that environment for new provisioning

#### Scenario: Retiring the default clears the default marker

- **WHEN** an admin retires the sandbox environment currently marked as default
- **THEN** the system clears that environment's default marker in the same
  lifecycle change
- **AND** omitted task creation falls back to the next valid configured behavior
  rather than using the retired environment

#### Scenario: Non-admin cannot retire environments

- **WHEN** a non-admin operator attempts to retire a sandbox environment
- **THEN** the request is rejected
- **AND** no environment registry state changes

### Requirement: Sandbox environment validation failures are actionable

The system SHALL preserve non-secret validation failure details in a form that
helps operators distinguish invalid source descriptors, provider configuration
errors, registry reachability failures, registry authorization failures,
architecture/runtime incompatibility, and missing runtime tools. Validation
details SHALL NOT include provider API tokens, registry credentials, forge
tokens, model credentials, or task secrets.

#### Scenario: Registry pull failure records actionable context

- **WHEN** provider-backed validation fails because the provider host cannot
  pull the image reference
- **THEN** the validation record includes a non-secret failure reason indicating
  registry pull or reachability failure
- **AND** the environment status remains non-ready

#### Scenario: Validation details remain non-secret

- **WHEN** a validation failure is stored and later displayed
- **THEN** the stored probes and error text do not contain provider API tokens,
  registry credentials, forge tokens, model credentials, or task secrets
