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
