# sandbox-host-harness Specification

## Purpose
TBD - created by archiving change rework-sandbox-provider-center-and-e2e. Update Purpose after archive.
## Requirements
### Requirement: API exposes a sandbox host harness only

The API SHALL act as a sandbox host harness, not a concrete sandbox provider composer. API code MAY provide host-side ports such as owner storage, provision lookup, runtime registry, runtime material resolvers, auth persistence, skill installer lookup, approval routing, logging, and Nest/WebSocket wiring. API code SHALL NOT construct, register, select, or translate concrete sandbox providers.

#### Scenario: API module binds one neutral sandbox factory
- **WHEN** `apps/api/src/sandbox/sandbox.module.ts` binds `SANDBOX_PROVIDER`
- **THEN** it calls a neutral `@cap-console/sandbox` host-harness factory with API-owned host ports
- **AND** it does not import or call concrete provider factories such as AIO, BoxLite, or cloud-http descriptor builders
- **AND** it does not instantiate Docker clients, provider controllers, provider env readers, or provider-family selectors

#### Scenario: API source has no provider-specific sandbox composition
- **WHEN** `apps/api/src/sandbox` is inspected
- **THEN** it contains API host ports, Prisma adapters, DI tokens, and neutral sandbox aliases only
- **AND** it does not contain AIO or BoxLite lifecycle code, provider readiness code, provider command protocol switches, provider workspace fallbacks, or provider env parsing

### Requirement: Provider registry composition lives in `@cap-console/sandbox`

`@cap-console/sandbox` SHALL own configured provider registry composition. It SHALL read provider selection configuration, register concrete provider package descriptors, enforce explicit provider-family fail-closed behavior, and return the API-facing sandbox provider facade.

#### Scenario: Provider packages are imported by the sandbox center
- **WHEN** configured provider registry code is inspected
- **THEN** `@cap-console/sandbox` imports provider package factories and env/config readers as needed
- **AND** API code imports only the `@cap-console/sandbox` facade and host-harness types

#### Scenario: Explicit provider family does not leak into API
- **WHEN** an operator sets `CAP_SANDBOX_PROVIDER` to AIO, BoxLite, or a control-plane provider
- **THEN** `@cap-console/sandbox` resolves and validates the configured provider family
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
- **AND** implementation must move the logic to `@cap-console/sandbox` or the owning provider package instead of adding an API allowlist

### Requirement: The operator provider vocabulary can name every selectable provider family

`ConfiguredSandboxProviderFamily` SHALL include a `'cloud-http'` member so an
operator can explicitly select the cloud-http family. The vocabulary SHALL remain
an independent declaration — per the recorded D14 ruling, the operator vocabulary
is a deliberate fork from the provider-family vocabulary, reconciled by a gate
rather than derived — written as a satisfies-subset with the reason recorded at
the declaration site.

#### Scenario: An operator explicitly selects cloud-http

- **WHEN** `CAP_SANDBOX_PROVIDER=cloud-http` is set and a cloud endpoint is
  configured
- **THEN** the configured registry resolves the cloud-http family exclusively,
  with the same explicit-family fail-closed semantics as the other named families

#### Scenario: Explicit cloud-http without an endpoint fails closed

- **WHEN** `CAP_SANDBOX_PROVIDER=cloud-http` is set but no cloud endpoint is
  configured
- **THEN** provider composition fails closed with an actionable error naming the
  missing configuration, rather than silently falling back to another family

#### Scenario: The declaration records why it is independent

- **WHEN** the `ConfiguredSandboxProviderFamily` declaration is inspected
- **THEN** it is written as a satisfies-subset over the provider-family
  vocabulary with an in-place comment recording the D14 independent-declaration
  ruling

### Requirement: Provider-family allowance is one total lookup table

The three `providerFamilyAllows*` predicate functions SHALL be replaced by a
single total `Record<ConfiguredSandboxProviderFamily, readonly SandboxProviderFamily[]>`
lookup. All existing consumers — the selection sites in `configured-provider.ts`
and the allowance sites in `deployment-environment.ts` — SHALL consult the table.
The conversion SHALL be behavior-equivalent for the existing configured families;
the `deploymentBehavior` branch structure is explicitly out of scope and SHALL be
unchanged.

#### Scenario: Allowance decisions are unchanged for existing families

- **WHEN** every existing configured family (`auto`, `aio`, `boxlite`,
  `control-plane`) is evaluated against every provider family through the table
- **THEN** each allow/deny result equals the pre-change three-predicate result

#### Scenario: A new configured family demands a table row at compile time

- **WHEN** a member is added to `ConfiguredSandboxProviderFamily` without a table
  entry
- **THEN** typecheck fails — the Record is total, so allowance is never undefined
  for a declared family

#### Scenario: No allowance predicate branching remains at the consumers

- **WHEN** `configured-provider.ts` and `deployment-environment.ts` are inspected
  after the conversion
- **THEN** their allowance decisions read the single table, and the three
  `providerFamilyAllows*` functions no longer exist

### Requirement: An R8 gate reconciles the operator vocabulary against selectable families

A new R8 coverage gate SHALL verify that the operator vocabulary is a superset of
the selectable provider families union `{auto, control-plane}`, and its
reconciliation SHALL include the fifth vocabulary `SandboxTerminalStoryProvider`,
declared in `packages/sandbox/src/host-harness/provider-terminal-story.ts`. The
gate SHALL follow the existing parity-gate canon
(`provider-contract-parity-check.mjs`): recursive discovery with no hardcoded
participant list, a scan matching zero participants fails, a paired self-test
ships with the gate, and its introduction is proven by an injection probe whose
red run is recorded verbatim and then reverted. No new analysis tool
(dependency-cruiser, ArchUnit, or similar) SHALL be introduced.

#### Scenario: A selectable family missing from the operator vocabulary turns the gate red

- **WHEN** a provider family becomes selectable while no matching operator
  vocabulary member exists
- **THEN** the R8 gate fails naming the missing member

#### Scenario: The gate fails on an empty scan

- **WHEN** the gate's discovery finds zero vocabularies to reconcile (for
  example after a file move)
- **THEN** the gate fails rather than passing vacuously

#### Scenario: The gate ships with a paired self-test and recorded red proof

- **WHEN** the R8 gate lands
- **THEN** a paired self-test exercises it, and the change's evidence records a
  verbatim red run produced by an injected divergence plus the revert restoring
  green

### Requirement: The tmux session protocol has one declaration in the sandbox facade

The tmux session protocol helpers SHALL be declared once in
`@cap-console/sandbox` and consumed by the api through the facade import only
(launch-line building, detached session naming and wrapping, UTF-8 flags,
has-session probing).
The api-side duplicate declaration (the `codex-launch.ts` copy) SHALL be deleted.
Every facade export added for this consumption SHALL be listed in
`expected-facade-surface.json` so the R6 facade-surface gate stays green.

#### Scenario: The api imports the facade instead of declaring a copy

- **WHEN** `apps/api` sources are searched for the tmux session protocol helper
  declarations
- **THEN** none are declared in the api; the api imports them from
  `@cap-console/sandbox`, and produced launch lines, session names, and probes
  are byte-identical to before

#### Scenario: New facade exports are whitelisted for R6

- **WHEN** the R6 facade-surface gate runs after the deduplication
- **THEN** it passes because every newly consumed export is present in
  `expected-facade-surface.json`

