## ADDED Requirements

### Requirement: AIO provisions from a resolved Docker-image environment

The AIO provider SHALL provision a task container from the resolved sandbox
environment when the environment source is compatible with AIO Docker-image
execution. If task creation omits an environment and no managed default exists,
AIO SHALL continue to use the existing deployment-level `AIO_SANDBOX_IMAGE`
fallback. The effective image SHALL remain pinned or resolved to immutable digest
metadata for auditability.

#### Scenario: Selected AIO environment overrides deployment image

- **WHEN** a task selects a ready AIO-compatible Docker-image environment
- **THEN** AIO creates the task container from that resolved image source
- **AND** it does not use `AIO_SANDBOX_IMAGE` for that task

#### Scenario: Omitted environment preserves current AIO default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** AIO provisions from the existing pinned `AIO_SANDBOX_IMAGE`
- **AND** existing deployments continue to provision as before

#### Scenario: Incompatible environment never reaches createContainer

- **WHEN** a task selects a BoxLite-only rootfs environment on an AIO deployment
- **THEN** task admission or provider selection rejects the task before
  dockerode `createContainer` is called
- **AND** no fallback AIO container is created from the deployment image

#### Scenario: AIO run records effective image metadata

- **WHEN** AIO provisions a task from a managed environment
- **THEN** the sandbox run metadata records the environment id and effective
  image reference or digest used for the container
