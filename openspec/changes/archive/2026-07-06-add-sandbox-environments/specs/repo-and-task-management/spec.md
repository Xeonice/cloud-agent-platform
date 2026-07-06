## ADDED Requirements

### Requirement: Task creation accepts sandbox environment selection

Task creation SHALL accept an optional `sandboxEnvironmentId` run parameter. The
system SHALL validate that the selected environment exists, is ready, and is
compatible with the selected runtime before the task is admitted for sandbox
provisioning. Invalid selections SHALL be rejected without creating an unusable
sandbox.

#### Scenario: Valid selected environment is persisted

- **WHEN** a task create request supplies a ready compatible
  `sandboxEnvironmentId`
- **THEN** the task record persists that environment id
- **AND** task read paths echo the selected environment id

#### Scenario: Unknown environment is rejected

- **WHEN** a task create request supplies a `sandboxEnvironmentId` that does not
  exist
- **THEN** the request is rejected before sandbox provisioning
- **AND** no provider fallback is attempted

#### Scenario: Not-ready environment is rejected

- **WHEN** a task create request supplies an environment whose status is failed,
  stale, or validating
- **THEN** the request is rejected before sandbox provisioning
- **AND** the error identifies the environment readiness problem

#### Scenario: Omitted environment resolves the default

- **WHEN** a task create request omits `sandboxEnvironmentId`
- **THEN** task creation uses the compatible managed default environment when
  configured
- **AND** otherwise preserves the existing deployment-level sandbox default
  behavior

### Requirement: Task reads expose a public environment summary

Task read responses SHALL expose a public, non-secret sandbox environment summary
when a task has a managed selected environment. The summary SHALL include id,
display name, status at selection time when available, provider family/source
kind, and runtime compatibility. It SHALL NOT expose host-local secrets or
provider credentials.

#### Scenario: Task response includes environment summary

- **WHEN** an operator reads a task that selected a managed sandbox environment
- **THEN** the response includes a sandbox environment summary
- **AND** the summary does not expose provider credentials or task secrets

#### Scenario: Legacy task response remains valid

- **WHEN** an operator reads a task created before sandbox environments existed
- **THEN** the response remains valid with a null or absent environment summary
- **AND** existing clients that do not know the field continue to work
