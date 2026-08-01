## ADDED Requirements

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
