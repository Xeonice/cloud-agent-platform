## ADDED Requirements

### Requirement: API exposes a sandbox host harness only

The API SHALL act as a sandbox host harness, not a concrete sandbox provider composer. API code MAY provide host-side ports such as owner storage, provision lookup, runtime registry, runtime material resolvers, auth persistence, skill installer lookup, approval routing, logging, and Nest/WebSocket wiring. API code SHALL NOT construct, register, select, or translate concrete sandbox providers.

#### Scenario: API module binds one neutral sandbox factory
- **WHEN** `apps/api/src/sandbox/sandbox.module.ts` binds `SANDBOX_PROVIDER`
- **THEN** it calls a neutral `@cap/sandbox` host-harness factory with API-owned host ports
- **AND** it does not import or call concrete provider factories such as AIO, BoxLite, or cloud-http descriptor builders
- **AND** it does not instantiate Docker clients, provider controllers, provider env readers, or provider-family selectors

#### Scenario: API source has no provider-specific sandbox composition
- **WHEN** `apps/api/src/sandbox` is inspected
- **THEN** it contains API host ports, Prisma adapters, DI tokens, and neutral sandbox aliases only
- **AND** it does not contain AIO or BoxLite lifecycle code, provider readiness code, provider command protocol switches, provider workspace fallbacks, or provider env parsing

### Requirement: Provider registry composition lives in `@cap/sandbox`

`@cap/sandbox` SHALL own configured provider registry composition. It SHALL read provider selection configuration, register concrete provider package descriptors, enforce explicit provider-family fail-closed behavior, and return the API-facing sandbox provider facade.

#### Scenario: Provider packages are imported by the sandbox center
- **WHEN** configured provider registry code is inspected
- **THEN** `@cap/sandbox` imports provider package factories and env/config readers as needed
- **AND** API code imports only the `@cap/sandbox` facade and host-harness types

#### Scenario: Explicit provider family does not leak into API
- **WHEN** an operator sets `CAP_SANDBOX_PROVIDER` to AIO, BoxLite, or a control-plane provider
- **THEN** `@cap/sandbox` resolves and validates the configured provider family
- **AND** API code does not branch on provider family names

### Requirement: API terminal code consumes a neutral sandbox terminal harness

The API terminal gateway SHALL consume a neutral terminal session factory from the sandbox harness. API terminal code SHALL NOT construct provider-specific terminal clients or register provider terminal protocols.

#### Scenario: Gateway opens terminal through the harness
- **WHEN** `TerminalGateway.openSession()` opens a provider-backed task terminal
- **THEN** it calls a sandbox terminal harness or selected-run terminal factory that returns the `AgentTerminalPty`-compatible session
- **AND** it does not instantiate AIO or BoxLite terminal clients directly

#### Scenario: Provider terminal protocols are not registered in API
- **WHEN** `apps/api/src/terminal` is inspected
- **THEN** it does not register or switch on provider terminal protocol strings such as `aio-json-v1` or `boxlite-v1`
- **AND** provider-specific terminal transport implementations live in provider packages or the sandbox harness layer

### Requirement: Command and workspace execution are provider-harness responsibilities

Command executor protocol handling and workspace fallback/default behavior SHALL live behind the sandbox/provider harness. API code SHALL NOT switch on provider command protocols or assume AIO workspace paths.

#### Scenario: API does not resolve provider command protocol
- **WHEN** API code needs to run a sandbox command for runtime setup, liveness, retention, or terminal lifecycle
- **THEN** it obtains a `SandboxCommandExecutor` through the sandbox/provider harness
- **AND** it does not switch on `aio-http-exec-v1`, `boxlite-exec-v1`, or any provider-specific command protocol

#### Scenario: Workspace behavior comes from selected provider descriptors
- **WHEN** API code needs workspace materialization, delivery, or retention behavior
- **THEN** it routes through the selected provider or provider-center workspace router
- **AND** it does not use an API-local AIO workspace fallback path

### Requirement: Boundary tests enforce the harness contract

The repository SHALL include boundary tests that prevent provider-specific sandbox logic from re-entering `apps/api/src/sandbox` or `apps/api/src/terminal`.

#### Scenario: Boundary test rejects provider-specific implementation in API
- **WHEN** API source contains concrete provider factories, provider config readers, Docker lifecycle code, provider terminal transports, provider protocol strings, or command protocol switches
- **THEN** the API boundary test fails with a clear message naming the disallowed boundary
- **AND** implementation must move the logic to `@cap/sandbox` or the owning provider package instead of adding an API allowlist
