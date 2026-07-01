## ADDED Requirements

### Requirement: Sandbox package unit tests live outside source directories

Sandbox package unit tests SHALL live under each package's `test/` directory rather than under `src/`, while source directories SHALL contain runtime implementation code only.

#### Scenario: Unit tests are located under package test directories
- **WHEN** sandbox package test files are inspected
- **THEN** unit and contract tests for that package are located under `packages/<sandbox-package>/test/`
- **AND** no new sandbox package unit test is added under `packages/<sandbox-package>/src/`

### Requirement: Provider packages own real backend e2e

Each concrete sandbox provider package SHALL own an `e2e/` suite that provisions real backend resources through that provider package without starting the CAP API backend or the production web app.

#### Scenario: AIO provider e2e starts real AIO containers without CAP API
- **WHEN** the AIO provider e2e suite runs with its Docker prerequisites satisfied
- **THEN** it provisions a real AIO sandbox container through `@cap/sandbox-provider-aio`
- **AND** it verifies readiness, command execution, selected-run descriptors, workspace behavior, readoption, and teardown without starting the CAP API server

#### Scenario: BoxLite provider e2e starts real BoxLite sandboxes without CAP API
- **WHEN** the BoxLite provider e2e suite runs with valid `BOXLITE_*` configuration
- **THEN** it provisions a real BoxLite sandbox through `@cap/sandbox-provider-boxlite`
- **AND** it verifies readiness, command execution, selected-run descriptors, workspace behavior, readoption when supported, and teardown without starting the CAP API server

#### Scenario: Missing provider e2e prerequisites skip or fail clearly
- **WHEN** real provider e2e prerequisites are absent
- **THEN** the suite reports the missing Docker or `BOXLITE_*` prerequisite clearly
- **AND** it does not silently fall back to a fake provider or a different provider family

### Requirement: Fast conformance remains available without live providers

Sandbox provider contracts SHALL also have a fake/in-process conformance suite that validates provider declarations, selected-run shape, routing, ownership, and fail-closed behavior without requiring Docker, BoxLite, API, or web processes.

#### Scenario: Fake conformance validates selected-run contracts
- **WHEN** the fast conformance suite runs
- **THEN** it validates provider capabilities, provision shape, selected-run descriptors, operation routing, and ownership behavior using fake providers
- **AND** it runs without provisioning a real sandbox backend

### Requirement: API harness boundary is tested

API source boundary tests SHALL prevent concrete provider implementation logic from entering `apps/api/src/sandbox` or `apps/api/src/terminal`.

#### Scenario: Boundary rejects provider composer code in API sandbox
- **WHEN** `apps/api/src/sandbox` contains concrete provider factories, provider env/config readers, Docker lifecycle, AIO/BoxLite lifecycle helpers, provider-family selection, provider command protocol switches, or provider workspace fallbacks
- **THEN** the API boundary test fails
- **AND** the fix is to move that code into `@cap/sandbox` or the owning provider package

#### Scenario: Boundary rejects provider terminal code in API terminal
- **WHEN** `apps/api/src/terminal` contains provider terminal transports, provider protocol registrations, direct AIO/BoxLite terminal clients, provider command executor fallback logic, or provider-specific readiness/env checks
- **THEN** the API boundary test fails
- **AND** `TerminalGateway` remains a browser-facing orchestration layer over the sandbox terminal harness

### Requirement: Web terminal rendering uses provider contract fixtures

Web terminal provider rendering SHALL be verified by Vite story and Playwright tests that consume provider contract fixtures instead of live provider resources.

#### Scenario: Web fixture verifies reconnect rendering without backend
- **WHEN** the provider terminal fixture story runs
- **THEN** it renders `SessionTerminal` using fixture selected-run and terminal frames
- **AND** it verifies initial render, snapshot plus tail replay, final reveal, reconnect, scroll behavior, and provider descriptor handling without starting CAP API or a real provider

#### Scenario: Provider internals are not exposed in web fixtures
- **WHEN** provider fixture data is rendered in the browser story
- **THEN** provider-internal tokens, private URLs, and sandbox identifiers that are not part of the browser contract are not displayed in the DOM
