## ADDED Requirements

### Requirement: AIO provider orchestration lives in the AIO provider package

The full AIO provider implementation SHALL live in `@cap/sandbox-provider-aio`, including Docker lifecycle, readiness, runtime setup hooks, workspace materialization, terminal and command descriptors, terminal session lifecycle, command executor protocol handling, retention behavior, transcript/readoption support, and provider descriptor registration. API code SHALL only provide neutral host harness ports such as persistence adapters, runtime registries, auth/material lookup, skill installers, approval sinks, and Nest wiring.

#### Scenario: AIO provision does not require API provider class logic
- **WHEN** `@cap/sandbox-provider-aio` is built and tested independently
- **THEN** it can provision, describe, command, retain, readopt, and tear down AIO sandboxes through its exported provider implementation
- **AND** it does not rely on `apps/api/src/sandbox/aio-sandbox.provider.ts` for lifecycle orchestration

#### Scenario: AIO is registered by the sandbox host harness
- **WHEN** CAP registers configured sandbox providers
- **THEN** `@cap/sandbox` creates the AIO descriptor from `@cap/sandbox-provider-aio` using neutral host harness hooks
- **AND** API code does not import AIO provider factories, controllers, Docker clients, AIO env readers, AIO command executors, or AIO terminal transports

#### Scenario: AIO terminal lifecycle is not implemented in API
- **WHEN** an AIO-backed task terminal is opened
- **THEN** launch-or-attach, initial ready handling, DSR/CPR startup behavior, tmux liveness, exit status resolution, and AIO frame translation are provided by the AIO provider terminal harness
- **AND** `apps/api/src/terminal` does not instantiate an AIO PTY client or AIO terminal transport

### Requirement: AIO provider e2e runs without CAP API backend

The AIO provider package SHALL include an e2e suite that starts real AIO resources and validates the provider lifecycle without starting the CAP API backend or production web app.

#### Scenario: AIO e2e validates real provision and exec
- **WHEN** AIO provider e2e runs with Docker and the AIO e2e image available
- **THEN** it creates a real task-scoped AIO container through the provider package
- **AND** it waits for readiness and verifies command execution inside that container

#### Scenario: AIO e2e validates selected-run descriptors
- **WHEN** AIO provider e2e provisions a sandbox
- **THEN** it verifies the selected run contains the AIO provider id, provider sandbox id, connection, `aio-json-v1` terminal descriptor, `aio-http-exec-v1` command descriptor, workspace descriptor, capabilities, and retention policy

#### Scenario: AIO e2e validates readoption after provider instance restart
- **WHEN** the AIO e2e suite creates a sandbox and then constructs a new provider instance
- **THEN** the new instance can discover or reattach the existing task sandbox through provider readoption
- **AND** operations route through the readopted provider owner

#### Scenario: AIO e2e cleans up real resources
- **WHEN** an AIO provider e2e test completes or fails
- **THEN** it removes or stops all task-scoped e2e AIO containers and any e2e-only Docker network it created
