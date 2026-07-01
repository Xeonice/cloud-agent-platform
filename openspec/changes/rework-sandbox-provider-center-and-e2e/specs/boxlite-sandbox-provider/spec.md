## ADDED Requirements

### Requirement: BoxLite provider package owns complete backend lifecycle

`@cap/sandbox-provider-boxlite` SHALL own BoxLite configuration, client protocol, sandbox lifecycle, command execution, terminal descriptor and transport, workspace/archive transfer, runtime preflight, retention descriptors, readoption support, readiness handling, and provider descriptor registration. API code SHALL only pass neutral host harness ports into `@cap/sandbox`; it SHALL NOT call BoxLite provider factories or parse BoxLite env/config directly.

#### Scenario: BoxLite registers through the sandbox host harness
- **WHEN** BoxLite is configured for CAP
- **THEN** `@cap/sandbox` registers it through `@cap/sandbox-provider-boxlite` descriptor/factory exports
- **AND** API-local wiring does not implement BoxLite lifecycle, descriptor assembly, readiness, env parsing, or provider-family fallback behavior

#### Scenario: Runtime setup is injected through hooks
- **WHEN** BoxLite provisioning needs runtime setup or preflight behavior
- **THEN** the provider package receives that behavior through explicit hooks
- **AND** it does not import API runtime registries, Prisma services, or Nest providers directly

#### Scenario: BoxLite terminal transport is not implemented in API
- **WHEN** a BoxLite-backed interactive terminal is opened
- **THEN** BoxLite exec/attach, binary channel decoding, resize/control frames, token/header handling, and terminal errors are handled by the BoxLite provider terminal harness
- **AND** `apps/api/src/terminal` does not instantiate a BoxLite terminal transport or read `BOXLITE_*` env

### Requirement: BoxLite provider e2e runs against real BoxLite without CAP API

The BoxLite provider package SHALL include an e2e suite that provisions real BoxLite sandboxes and validates provider behavior without starting the CAP API backend or production web app.

#### Scenario: BoxLite e2e validates real provision and exec
- **WHEN** BoxLite provider e2e runs with valid `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and sandbox source configuration
- **THEN** it creates a real BoxLite sandbox through the provider package
- **AND** it verifies readiness and normalized command execution

#### Scenario: BoxLite e2e validates selected-run descriptors
- **WHEN** BoxLite provider e2e provisions a sandbox
- **THEN** it verifies provider id, provider sandbox id, connection, terminal descriptor when advertised, `boxlite-exec-v1` command descriptor, workspace descriptor, capabilities, retention policy, and preflight result

#### Scenario: BoxLite e2e validates workspace transfer
- **WHEN** BoxLite advertises archive or git workspace capabilities
- **THEN** the e2e suite verifies materialization and capture or delivery through provider-neutral workspace descriptors

#### Scenario: BoxLite e2e never falls back to AIO
- **WHEN** BoxLite e2e prerequisites are invalid or the BoxLite sandbox source cannot satisfy required capabilities
- **THEN** the e2e suite fails or skips with a BoxLite-specific reason
- **AND** it does not provision AIO as a fallback
