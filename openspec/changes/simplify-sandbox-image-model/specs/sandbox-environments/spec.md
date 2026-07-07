## MODIFIED Requirements

### Requirement: Admin-managed sandbox environment registry

The system SHALL provide an admin-only registry of sandbox environments. Each
environment SHALL have a stable id, display name, source descriptor, provider
family compatibility, runtime compatibility, lifecycle status, default marker,
creation/update timestamps, and non-secret validation metadata. Environment
records SHALL NOT store provider API tokens, forge tokens, model credentials, or
other task secrets. Managed environment creation SHALL support only AIO image
sources and BoxLite image sources; loaded Docker image sources, BoxLite rootfs
sources, provider-template sources, and other delivery-specific source kinds
SHALL be rejected for managed custom images.

#### Scenario: Admin creates an environment from a supported image source

- **WHEN** an admin registers a sandbox environment with provider `aio` or
  `boxlite` and a non-empty pinned image reference
- **THEN** the system stores the environment with a stable id and an initial
  non-ready status
- **AND** the source descriptor contains no provider credentials or task secrets

#### Scenario: Removed source kinds are rejected

- **WHEN** an admin attempts to create a managed environment from
  `aio-loaded-docker-image`, `boxlite-rootfs`, or `provider-template`
- **THEN** the request is rejected
- **AND** no environment registry state changes

#### Scenario: Non-admin cannot manage environments

- **WHEN** a non-admin operator attempts to create, edit, validate, delete, or set
  a default sandbox environment
- **THEN** the request is rejected
- **AND** no environment registry state changes

### Requirement: Sandbox environment source descriptors are provider-aware

The system SHALL model managed sandbox environment sources explicitly while
keeping only one custom image source per provider family. Supported managed
source kinds SHALL include AIO Docker image and BoxLite image. A source SHALL
declare the provider family that can consume it. A source that is ambiguous or
not one of the supported managed image kinds SHALL fail validation rather than
being guessed.

#### Scenario: AIO image source is AIO-only

- **WHEN** an environment source is an AIO Docker image reference
- **THEN** its compatibility includes AIO provisioning
- **AND** a BoxLite task cannot select that environment

#### Scenario: BoxLite image source is BoxLite-only

- **WHEN** an environment source is a BoxLite image reference
- **THEN** its compatibility includes BoxLite provisioning
- **AND** an AIO task cannot select that environment

#### Scenario: Delivery-specific source kinds fail closed

- **WHEN** an environment source kind represents a local loaded Docker image,
  local rootfs path, release asset, or provider template
- **THEN** managed environment creation and validation reject that source kind
- **AND** the environment is not selectable for tasks

### Requirement: Environment validation gates task selection

The system SHALL validate sandbox environments before they can be selected by a
task. Validation SHALL record status, checked timestamp, provider family,
runtime compatibility, resolved image digest when available, probe output
summary, and failure reason. Only environments with a ready status and compatible
runtime/provider family SHALL be selectable. A validation SHALL NOT pass merely
because the source descriptor parses; it SHALL prove the selected provider can
start the image and pass the runtime/tool probes.

#### Scenario: Successful validation makes environment selectable

- **WHEN** validation proves the image source can start a sandbox or container
  and pass the required runtime/tool probes
- **THEN** the environment status becomes ready
- **AND** compatible task creation surfaces can select it

#### Scenario: Failed validation blocks selection

- **WHEN** validation fails because the image is missing, unreachable,
  incompatible, or lacks required runtime tools
- **THEN** the environment status becomes failed
- **AND** task creation rejects that environment before sandbox provisioning

#### Scenario: Descriptor-only validation is not sufficient

- **WHEN** a source descriptor parses but the provider-backed probe has not
  started and checked the image
- **THEN** the environment does not become ready
- **AND** task creation cannot select it

#### Scenario: Stale validation blocks new tasks

- **WHEN** an environment is marked stale because the CAP sandbox contract changed
- **THEN** new task creation cannot select it until validation passes again
- **AND** already-running tasks that used the prior validation are not stopped by
  this state change

### Requirement: Environment resolution produces immutable provisioning metadata

Before sandbox provisioning, the system SHALL resolve the requested or default
sandbox environment into immutable non-secret provisioning metadata. The resolved
metadata SHALL include environment id when present, source kind, provider family,
runtime id, resolved image reference or digest when available, and validation
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
include provider credentials, forge tokens, model credentials, or raw task
secrets.

#### Scenario: Sandbox run records environment metadata

- **WHEN** a task provisions a sandbox with a resolved environment
- **THEN** the sandbox run owner metadata records environment id, source kind,
  runtime id, provider family, and resolved image reference or digest metadata
- **AND** the metadata is sufficient to distinguish two different validated
  versions of the same display environment

#### Scenario: Secrets are not persisted in run metadata

- **WHEN** sandbox run metadata is inspected after provisioning
- **THEN** it does not contain provider API tokens, forge tokens, model
  credentials, or task prompt contents
