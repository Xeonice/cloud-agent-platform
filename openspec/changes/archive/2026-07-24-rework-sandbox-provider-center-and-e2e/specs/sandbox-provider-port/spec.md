## ADDED Requirements

### Requirement: `@cap/sandbox` is the API-facing provider center

The API SHALL consume sandbox behavior through `@cap/sandbox` as the provider center and host harness boundary. Provider registry composition, selection, explicit provider-family constraints, owner pinning, readoption routing, selected-run aggregation, workspace helpers, lifecycle planning, command executor resolution, provider readiness, and provider-neutral terminal session behavior SHALL live behind that center rather than in API-local wiring or helper-only packages.

#### Scenario: API imports sandbox behavior through the center
- **WHEN** API sandbox, task, guardrail, terminal, and retention code imports sandbox-layer functionality
- **THEN** it imports the API-facing surface from `@cap/sandbox`
- **AND** it does not import scheduler, lifecycle, workspace-git, conformance, AIO-local, or provider-helper packages directly
- **AND** it does not import concrete provider factories, provider env readers, provider terminal transports, or provider command executor implementations

#### Scenario: Provider center owns selected-run routing
- **WHEN** a lifecycle step needs terminal, command, workspace, retention, delivery, transcript, or teardown behavior for a task
- **THEN** the provider center resolves the selected run or durable owner record
- **AND** the step does not independently select a provider for an already-owned task

#### Scenario: Provider center owns configured registry creation
- **WHEN** the API binds the sandbox provider port
- **THEN** API passes a neutral host harness into `@cap/sandbox`
- **AND** `@cap/sandbox` composes AIO, BoxLite, cloud-http, and future provider descriptors according to configuration
- **AND** API does not branch on provider family or provider capability implementation details

### Requirement: Helper-only sandbox packages are not runtime extension packages

Sandbox helper logic SHALL be located inside the owning package unless it represents a stable external extension boundary. Scheduler, lifecycle, workspace-git, AIO-local configuration, and conformance helpers SHALL NOT remain runtime packages solely to hold internal helper code.

#### Scenario: Internal helpers move under owning packages
- **WHEN** the sandbox package graph is inspected after the refactor
- **THEN** scheduler, lifecycle, and workspace helper code is under `@cap/sandbox`
- **AND** AIO local configuration/spec helper code is under `@cap/sandbox-provider-aio`
- **AND** conformance helpers are dev-only testkit or test code rather than runtime dependencies

### Requirement: Provider packages expose backend descriptors through a common center contract

Each provider package SHALL expose descriptor factories and provider instances that the provider center can register without API-specific dependencies.

#### Scenario: A provider registers without Nest dependencies
- **WHEN** `@cap/sandbox` registers AIO or BoxLite provider descriptors
- **THEN** the descriptor is created from provider package exports and injected hooks
- **AND** the provider package does not import Nest, Prisma, API controllers, or API-local module wiring

#### Scenario: Explicit provider family remains fail-closed
- **WHEN** an operator explicitly selects a provider family and that provider cannot satisfy the required capabilities
- **THEN** the provider center fails provisioning with an actionable provider-selection error
- **AND** it does not silently fall back to another provider family

## MODIFIED Requirements

### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL define a `SandboxProvider` port abstraction whose `provision()` method accepts a `ProvisionContext` (which no longer carries a `taskToken`, since there is no dial-back to authenticate) and returns a `SandboxConnection { taskId, baseUrl, wsUrl }` rather than `void`, so that callers can address the provisioned sandbox by container name and open its terminal WebSocket. Providers SHALL be exposed through provider descriptors that include an id, location (`local` or `cloud`), priority, supported capabilities, and the provider implementation. Capability selection SHALL be provider-neutral: callers declare required capabilities, the provider center SHALL consider only providers satisfying all required capabilities, and selection SHALL order candidates by priority with optional preferred-location tie-breaking. The port SHALL continue to expose the execution sandbox mode (one of `read-only`, `workspace-write`, `danger-full-access`) as an explicit capability via `getSandboxMode()`, but that mode SHALL be treated as INFORMATIONAL only and SHALL NOT be the scheduling boundary — under AIO Sandbox the real isolation boundary is the container with `seccomp=unconfined` plus network isolation, not the reported mode. The concrete OS-isolating implementation SHALL remain deferrable and swappable without changing callers. `teardownSandbox` SHALL be unchanged.

Provider-neutral contracts and capability types SHALL live in `@cap/sandbox-core`. Provider registry, selection, lifecycle, workspace, readoption, selected-run routing, and shared terminal-session behavior SHALL live in the API-facing `@cap/sandbox` provider center. Concrete AIO, BoxLite, and cloud HTTP mechanics SHALL live in their owning provider packages. Internal scheduler, lifecycle, workspace-git, and AIO-local helpers SHALL NOT remain helper-only runtime packages, and conformance code SHALL be dev-only testkit or package test code rather than a production dependency. None of these layers SHALL require `@cap/api` internals.

#### Scenario: provision returns a SandboxConnection, not void
- **WHEN** a caller invokes `SandboxProvider.provision()` with a `ProvisionContext`
- **THEN** it returns a `SandboxConnection` carrying `taskId`, `baseUrl`, and `wsUrl`
- **AND** the returned handle is sufficient for the caller to open the sandbox terminal WebSocket without any further lookup

#### Scenario: ProvisionContext no longer carries a task token
- **WHEN** the `ProvisionContext` type accepted by `provision()` is inspected
- **THEN** it does not contain a `taskToken` field, because no dial-back handshake needs authenticating

#### Scenario: getSandboxMode is informational under AIO
- **WHEN** `getSandboxMode()` is called on the AIO-backed provider
- **THEN** the returned mode is treated as informational metadata
- **AND** the actual execution isolation boundary is the AIO container with `seccomp=unconfined` plus network isolation rather than the reported mode

#### Scenario: Port exposes a sandbox-mode capability
- **WHEN** the `SandboxProvider` port interface is inspected
- **THEN** it exposes the sandbox mode as an informational capability whose values include `read-only`, `workspace-write`, and `danger-full-access`

#### Scenario: Callers depend on the port, not a concrete impl
- **WHEN** orchestrator and runner code that provisions execution is inspected
- **THEN** it depends on the `SandboxProvider` port interface rather than directly on a specific sandbox implementation
- **AND** it consumes the returned `SandboxConnection` handle rather than assuming a `void` provision result

#### Scenario: teardownSandbox is unchanged
- **WHEN** the `teardownSandbox` signature and behavior are inspected after the redesign
- **THEN** they are unchanged from before the AIO migration

#### Scenario: Provider selection is capability based
- **WHEN** a task requires a set of sandbox capabilities
- **THEN** the provider center only selects a provider whose descriptor advertises every required capability
- **AND** if multiple providers qualify, priority and optional preferred location determine the winner

#### Scenario: Local and cloud providers share the same port
- **WHEN** local AIO, BoxLite, or cloud HTTP providers are configured
- **THEN** the API consumes them through the same provider-center facade and `SandboxProvider` surface
- **AND** it does not branch on concrete implementation classes to provision a task

#### Scenario: Sandbox package boundaries match real extension points
- **WHEN** sandbox provider logic and package manifests are inspected
- **THEN** provider-neutral contracts live in `@cap/sandbox-core`, shared orchestration lives in `@cap/sandbox`, and backend mechanics live in concrete provider packages
- **AND** helper-only packages are not production runtime dependencies, conformance is dev-only, and `@cap/api` imports only the provider-center surface
