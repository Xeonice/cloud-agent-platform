## MODIFIED Requirements

### Requirement: Admin-managed sandbox environment registry

The system SHALL provide an admin-only registry of sandbox environments backed by existing registry image references. Each environment SHALL have a stable id, display name, source descriptor, provider family compatibility, runtime compatibility, lifecycle status, default marker, creation/update timestamps, non-secret validation metadata, and optional image runtime parameters. Environment records SHALL NOT store provider API tokens, registry credentials, forge tokens, model credentials, or other task secrets except encrypted image secret parameters explicitly configured by an admin for that environment. Environment read APIs SHALL NOT return plaintext image secret parameter values. Environment records SHALL NOT represent uploaded artifacts, local rootfs paths, already-loaded provider images, or CAP-built images.

#### Scenario: Admin registers an existing image reference

- **WHEN** an admin registers a sandbox environment with a supported registry image source kind
- **THEN** the system stores the environment with a stable id and an initial non-ready status
- **AND** the source descriptor contains only non-secret image reference metadata
- **AND** CAP does not build, upload, or push an image as part of registration

#### Scenario: Admin registers image parameters

- **WHEN** an admin registers a sandbox environment with plain and secret image parameters
- **THEN** the system stores plain parameter values in readable form
- **AND** stores secret parameter values encrypted at rest
- **AND** environment reads expose secret parameter names without plaintext values
