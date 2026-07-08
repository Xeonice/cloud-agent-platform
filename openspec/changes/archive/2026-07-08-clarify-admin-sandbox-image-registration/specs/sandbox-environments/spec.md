## MODIFIED Requirements

### Requirement: Admin-managed sandbox environment registry

The system SHALL provide an admin-only registry of sandbox environments backed
by existing registry image references. Each environment SHALL have a stable id,
display name, source descriptor, provider family compatibility, runtime
compatibility, lifecycle status, default marker, creation/update timestamps, and
non-secret validation metadata. Environment records SHALL NOT store provider API
tokens, registry credentials, forge tokens, model credentials, or other task
secrets. Environment records SHALL NOT represent uploaded artifacts, local
rootfs paths, already-loaded provider images, or CAP-built images.

#### Scenario: Admin registers an existing image reference

- **WHEN** an admin registers a sandbox environment with a supported registry
  image source kind
- **THEN** the system stores the environment with a stable id and an initial
  non-ready status
- **AND** the source descriptor contains only non-secret image reference
  metadata
- **AND** CAP does not build, upload, or push an image as part of registration

#### Scenario: Legacy managed source kinds are rejected

- **WHEN** an admin attempts to register an AIO already-loaded image source, a
  BoxLite rootfs path source, an OCI upload, or any other unsupported managed
  source kind
- **THEN** the request is rejected before validation
- **AND** no environment registry state changes

#### Scenario: Non-admin cannot manage environments

- **WHEN** a non-admin operator attempts to create, edit, validate, delete, or set
  a default sandbox environment
- **THEN** the request is rejected
- **AND** no environment registry state changes

### Requirement: Sandbox environment source descriptors are provider-aware

The system SHALL model sandbox environment sources explicitly. Supported managed
source kinds SHALL be limited to AIO registry Docker image references and
BoxLite registry image references. A source SHALL declare the provider family or
families that can consume it. Unsupported local, uploaded, already-loaded, or
rootfs source descriptors SHALL fail validation rather than being guessed or
converted.

#### Scenario: AIO image source maps to AIO

- **WHEN** an environment source kind is `aio-docker-image`
- **THEN** its compatibility includes the AIO provider family
- **AND** its source descriptor stores a non-secret registry image reference

#### Scenario: BoxLite image source maps to BoxLite

- **WHEN** an environment source kind is `boxlite-image`
- **THEN** its compatibility includes the BoxLite provider family
- **AND** its source descriptor stores a non-secret registry image reference

#### Scenario: Unsupported source fails closed

- **WHEN** an environment source uses a rootfs path, a local loaded-image name,
  an upload artifact, or another unsupported source kind
- **THEN** registration or validation fails with an unsupported-source error
- **AND** the environment is not selectable for tasks

### Requirement: Environment validation gates task selection

The system SHALL validate sandbox environments before they can be selected by a
task. Validation SHALL record status, checked timestamp, provider family,
runtime compatibility, resolved image digest when available, probe output
summary, and failure reason. Only environments with a ready status and compatible
runtime/provider family SHALL be selectable.

#### Scenario: Successful validation makes environment selectable

- **WHEN** validation proves the provider host can pull or resolve the image,
  start a sandbox, and pass the required runtime/tool probes
- **THEN** the environment status becomes ready
- **AND** compatible task creation surfaces can select it

#### Scenario: Failed validation blocks selection

- **WHEN** validation fails because the image is missing, unreachable,
  unauthorized, architecture-incompatible, or lacks required runtime tools
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
runtime id, image reference, resolved image digest when available, and validation
id/version.

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
include provider credentials, registry credentials, forge tokens, model
credentials, raw task secrets, uploaded image artifacts, or local rootfs
contents.

#### Scenario: Sandbox run records environment metadata

- **WHEN** a task provisions a sandbox with a resolved managed environment
- **THEN** the sandbox run owner metadata records environment id, source kind,
  runtime id, provider family, image reference, and resolved digest metadata when
  available
- **AND** the metadata is sufficient to distinguish two different validated
  versions of the same display environment

#### Scenario: Secrets are not persisted in run metadata

- **WHEN** sandbox run metadata is inspected after provisioning
- **THEN** it does not contain provider API tokens, registry credentials, forge
  tokens, model credentials, or task prompt contents
