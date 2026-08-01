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

### Requirement: Runtime artifact checksums are keyed by the runtime vocabulary with explicit partial semantics

`RuntimeArtifactChecksumsSchema` SHALL be a record keyed by the declared runtime
vocabulary (`z.record(RuntimeSchema, Sha256ChecksumSchema)`) rather than a strict
literal-key object, and its semantics SHALL be explicitly partial: an attestation
that lacks a checksum for some declared runtime — for example a historical
attestation persisted before a new runtime was declared — MUST continue to
parse. A key outside the runtime vocabulary MUST be rejected, and values MUST
remain validated sha-256 checksums.

`packages/contracts`, `apps/api`, and `apps/web` SHALL construct and consume this
schema through the Zod classic v3 entrypoint only: v4 flips enum-keyed
`z.record` semantics to exhaustive, which would silently break the partial
contract (the future v4 migration path is `z.partialRecord`).

#### Scenario: A historical attestation missing a new runtime's key parses

- **WHEN** a runtime identifier is added to the declaration and a previously
  persisted attestation carries checksums only for `codex` and `claude-code`
- **THEN** the attestation parses successfully and its consumers behave exactly
  as before the new runtime existed

#### Scenario: Existing attestation fixtures parse identically

- **WHEN** the pre-change attestation fixtures (both keys, either key alone, and
  invalid checksum values) are parsed with the record schema
- **THEN** every fixture accepted before is accepted with an identical parsed
  result, and every fixture rejected before (e.g. malformed checksum) is still
  rejected

#### Scenario: A non-vocabulary key is rejected

- **WHEN** an attestation carries a checksum keyed by an identifier that is not
  in the runtime vocabulary
- **THEN** parsing fails rather than accepting or silently dropping the unknown
  key

#### Scenario: No zod/v4 entrypoint import exists in the constrained packages

- **WHEN** the sources of `packages/contracts`, `apps/api`, and `apps/web` are
  scanned for imports of the `zod/v4` subpath
- **THEN** zero such imports are found

### Requirement: The environment source-kind vocabulary has a single declaration with an explicit extension tier

`SandboxEnvironmentSourceKindSchema` in `sandbox-environment.ts` SHALL be the
single declaration of the environment source-kind vocabulary. The runtime-model
side SHALL derive its members from this declaration plus explicitly modeled
extension/legacy members (`provider-snapshot`, `boxlite-rootfs`) rather than
maintaining an independent member list. Managed environment creation and
validation SHALL keep rejecting non-managed source kinds exactly as today — the
extension tier does not widen the managed surface. After the merge, the R5
vocabulary parity gate (`sandbox-core-vocabulary-parity.mjs`) SHALL carry a
`PAIRS` entry covering this vocabulary.

#### Scenario: The derived side cannot drift from the declaration

- **WHEN** the runtime-model source union's kind members are compared against the
  single declaration plus its declared extension members
- **THEN** they reconcile exactly, the R5 parity gate passes, and an injected
  divergence on either side turns the gate red

#### Scenario: Managed creation still rejects non-managed kinds

- **WHEN** a managed environment create or validate request carries
  `provider-snapshot` or `boxlite-rootfs`
- **THEN** it is rejected exactly as before the merge and the environment is not
  selectable for tasks

#### Scenario: The parity gate covers the merged vocabulary

- **WHEN** the R5 gate's `PAIRS` list is inspected after the merge
- **THEN** it contains an entry pairing the source-kind declaration with its
  runtime-model derivation site, and the gate's paired self-test passes

