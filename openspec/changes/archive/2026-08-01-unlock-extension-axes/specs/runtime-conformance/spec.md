## ADDED Requirements

### Requirement: The conformance suite owns all test logic behind a harness-maker seam

The runtime-conformance suite SHALL own every scenario assertion. A runtime SHALL
participate by supplying only a harness maker — runtime construction plus
environment hooks (fixture material, launch expectations, credential stubs) — and
SHALL NOT contribute scenario logic of its own. Admitting a runtime to the suite
SHALL require registering a harness maker and ledger data, never writing new
assertions.

#### Scenario: Codex and claude participate through harness makers only

- **WHEN** the suite's per-runtime entry points are inspected
- **THEN** each runtime supplies a harness maker (construction + environment
  hooks) and zero scenario assertions, and every assertion lives in suite-owned
  shared scenario modules

#### Scenario: The harness-maker seam is typed as construction plus hooks

- **WHEN** the harness-maker interface is inspected
- **THEN** its members expose runtime construction and environment hooks only —
  no member accepts or returns test assertions — so a runtime physically cannot
  fork scenario logic through the seam

### Requirement: Participation is a compile-time ledger derived from declared execution modes

The suite SHALL maintain a participation ledger as a pair of total Records
(structurally copied from the provider suite's `required-participation.ts`
pattern): one keyed by runtime identifier, one keyed by scenario family. The set
of families a runtime MUST run SHALL be derived from the runtime's declared
`executionModes` (a runtime declaring `headless-exec` MUST run the headless
family). A declared runtime missing from the ledger, or a scenario family with no
coverage entry, MUST fail typecheck rather than being detected at runtime or
silently skipped. The ledger shape SHALL be stated in this form from the first
commit — not retrofitted after a looser registry lands.

#### Scenario: A missing runtime registration is a compile error

- **WHEN** a runtime identifier is added to the contracts declaration and no
  ledger entry is added in the conformance suite
- **THEN** the suite's typecheck fails naming the missing runtime key, before any
  test executes

#### Scenario: Declared execution modes imply mandatory families

- **WHEN** a runtime declares `headless-exec` in its execution modes but its
  ledger entry does not run the headless family
- **THEN** the reconciliation fails (compile error or failing ledger assertion)
  rather than the family being skipped silently

### Requirement: Five scenario families port existing assertions rather than inventing new ones

The suite SHALL cover five scenario families — launch, lifecycle, transcript,
headless, secret-canary — and each family's assertions SHALL be ported from the
existing seed suites: launch/lifecycle from the codex launch golden (byte-exact
launch-line fixtures) and the DSR/quiesce/exit-detection policy assertions;
transcript from the existing parser tests; headless from the existing argv-capture
tests; secret-canary from the injection / exactly-once / zero-leak assertion
vocabulary of `workspace-git-conformance.ts`. The seeds live in `apps/api`, and
extraction SHALL move in the api→package direction only: the suite package SHALL
NOT import api-only modules.

#### Scenario: Codex golden launch fixtures stay byte-identical

- **WHEN** the launch family runs for `codex`
- **THEN** the asserted launch line equals the pre-existing golden fixture
  byte-for-byte — the fixture is moved, not regenerated

#### Scenario: Secret canary asserts exactly-once injection and zero leakage

- **WHEN** the secret-canary family runs for a runtime
- **THEN** it asserts the canary credential appears exactly once in
  provider-private configuration and zero times across the execution boundary
  (process listings, logs, transcript output), using the assertion vocabulary
  ported from `workspace-git-conformance.ts`

#### Scenario: The suite package typechecks without api internals

- **WHEN** the conformance package is built and typechecked
- **THEN** it compiles with no import resolving into `apps/api`, proving the
  api→package extraction carried no api-only dependency

### Requirement: Per-runtime conformance reports make skips visible

Each suite run SHALL produce a per-runtime report artifact mapping every scenario
family to `pass` or `skip` with a reason. A family skipped because the runtime
does not declare the implying capability SHALL appear as an explicit `skip` row
carrying that reason — never as silence.

#### Scenario: An undeclared capability yields a reasoned skip row

- **WHEN** a runtime does not declare an execution mode that implies a family
- **THEN** the report artifact contains a row for that (runtime, family) pair
  with status `skip` and a reason naming the missing declaration

#### Scenario: The report is total over runtimes and families

- **WHEN** a suite run completes
- **THEN** the report contains one row for every (declared runtime, family) pair
  across all five families, each `pass` or `skip` with a reason — no absent rows

### Requirement: CI enrollment is by directory discovery with no workflow edits

The suite SHALL live in a `packages/*` package that declares a `test` script, so
the existing package-suites CI job's directory filter enrolls it automatically.
Landing the suite SHALL require zero workflow-file edits and SHALL NOT change any
frozen CI check display name. The new lane SHALL start as non-required.

#### Scenario: The suite runs in CI without a workflow change

- **WHEN** the suite package with its `test` script lands
- **THEN** the package-suites job runs it via the existing `./packages/*` turbo
  filter, and this change's diff contains no workflow-file edit

#### Scenario: Frozen check names are untouched

- **WHEN** CI check display names are compared before and after the change
- **THEN** they are identical, and the new suite is not a required check at
  introduction
