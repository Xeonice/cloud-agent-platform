## MODIFIED Requirements

### Requirement: AIO provisions from a resolved Docker-image environment

The AIO provider SHALL provision a task container from the resolved sandbox
environment when the environment source is an AIO Docker image reference. If
task creation omits an environment and no managed default exists, AIO SHALL
continue to use the existing deployment-level `AIO_SANDBOX_IMAGE` fallback. The
effective image SHALL remain pinned or resolved to immutable digest metadata for
auditability. Managed AIO environments SHALL NOT model local Docker preload state
as a separate source kind; registry reachability or preloading is an operator
responsibility proven by validation.

#### Scenario: Selected AIO environment overrides deployment image

- **WHEN** a task selects a ready AIO-compatible Docker-image environment
- **THEN** AIO creates the task container from that resolved image source
- **AND** it does not use `AIO_SANDBOX_IMAGE` for that task

#### Scenario: Omitted environment preserves current AIO default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** AIO provisions from the existing pinned `AIO_SANDBOX_IMAGE`
- **AND** existing deployments continue to provision as before

#### Scenario: Loaded-image source kind is rejected before createContainer

- **WHEN** a task or API request resolves a managed environment source kind other
  than the AIO Docker image source for AIO
- **THEN** task admission or provider selection rejects the task before
  dockerode `createContainer` is called
- **AND** no fallback AIO container is created from the deployment image

#### Scenario: AIO run records effective image metadata

- **WHEN** AIO provisions a task from a managed environment
- **THEN** the sandbox run metadata records the environment id and effective
  image reference or digest used for the container
