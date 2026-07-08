# sandbox-environments Specification

## Purpose
TBD - created by archiving change add-sandbox-environments. Update Purpose after archive.
## Requirements
### Requirement: Admin-managed sandbox environment registry

The system SHALL provide an admin-only registry of sandbox environments. Each
environment SHALL have a stable id, display name, source descriptor, provider
family compatibility, runtime compatibility, lifecycle status, default marker,
creation/update timestamps, and non-secret validation metadata. Environment
records SHALL NOT store provider API tokens, forge tokens, model credentials, or
other task secrets.

#### Scenario: Admin creates an environment from a supported source

- **WHEN** an admin registers a sandbox environment with a supported source kind
- **THEN** the system stores the environment with a stable id and an initial
  non-ready status
- **AND** the source descriptor contains no provider credentials or task secrets

#### Scenario: Non-admin cannot manage environments

- **WHEN** a non-admin operator attempts to create, edit, validate, delete, or set
  a default sandbox environment
- **THEN** the request is rejected
- **AND** no environment registry state changes

### Requirement: Sandbox environment source descriptors are provider-aware

The system SHALL model sandbox environment sources explicitly. Supported source
kinds SHALL include AIO Docker image, AIO already-loaded Docker image, BoxLite
image, and BoxLite rootfs path. A source SHALL declare the provider family or
families that can consume it. A source that is ambiguous for the selected
provider family SHALL fail validation rather than being guessed.

#### Scenario: Rootfs source is BoxLite-only

- **WHEN** an environment source is a BoxLite rootfs path
- **THEN** its compatibility excludes AIO provisioning
- **AND** an AIO task cannot select that environment

#### Scenario: Ambiguous source fails closed

- **WHEN** an environment source resolves to both an image and a rootfs path for
  the same provider family/runtime
- **THEN** validation fails with a source-ambiguity error
- **AND** the environment is not selectable for tasks

### Requirement: Environment validation gates task selection

The system SHALL validate sandbox environments before they can be selected by a
task. Validation SHALL record status, checked timestamp, provider family,
runtime compatibility, resolved digest or checksum when available, probe output
summary, and failure reason. Only environments with a ready status and compatible
runtime/provider family SHALL be selectable.

#### Scenario: Successful validation makes environment selectable

- **WHEN** validation proves the environment source can start a sandbox and pass
  the required runtime/tool probes
- **THEN** the environment status becomes ready
- **AND** compatible task creation surfaces can select it

#### Scenario: Failed validation blocks selection

- **WHEN** validation fails because the image/rootfs is missing, unreadable, or
  lacks required runtime tools
- **THEN** the environment status becomes failed
- **AND** task creation rejects that environment before sandbox provisioning

#### Scenario: Stale validation blocks new tasks

- **WHEN** an environment is marked stale because the CAP sandbox contract changed
- **THEN** new task creation cannot select it until validation passes again
- **AND** already-running tasks that used the prior validation are not stopped by
  this state change

### Requirement: Environment resolution produces immutable provisioning metadata

Before sandbox provisioning, the system SHALL resolve the requested or default
sandbox environment into immutable non-secret provisioning metadata. The resolved
metadata SHALL include environment id when present, source kind, provider family,
runtime id, resolved image digest or rootfs checksum/path when available, and
validation id/version.

#### Scenario: Explicit environment resolves for a task

- **WHEN** a task create request supplies a ready compatible
  `sandboxEnvironmentId`
- **THEN** environment resolution returns immutable metadata for that exact
  environment
- **AND** provisioning receives that metadata rather than rereading a mutable tag
  alone

#### Scenario: Omitted environment uses default fallback

- **WHEN** a task create request omits `sandboxEnvironmentId`
- **THEN** the resolver uses the compatible managed default if one exists
- **AND** otherwise uses the existing deployment-level sandbox source as an
  implicit default

### Requirement: Environment run metadata is auditable but non-secret

The system SHALL persist non-secret environment metadata with each sandbox run so
operators can diagnose which sandbox base was used. Persisted metadata SHALL NOT
include provider credentials, forge tokens, model credentials, or raw task
secrets.

#### Scenario: Sandbox run records environment metadata

- **WHEN** a task provisions a sandbox with a resolved environment
- **THEN** the sandbox run owner metadata records environment id, source kind,
  runtime id, provider family, and resolved digest/checksum/path metadata
- **AND** the metadata is sufficient to distinguish two different validated
  versions of the same display environment

#### Scenario: Secrets are not persisted in run metadata

- **WHEN** sandbox run metadata is inspected after provisioning
- **THEN** it does not contain provider API tokens, forge tokens, model
  credentials, or task prompt contents

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
