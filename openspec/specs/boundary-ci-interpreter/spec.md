# boundary-ci-interpreter Specification

## Purpose
TBD - created by archiving change enforce-boundaries-from-manifest. Update Purpose after archive.
## Requirements
### Requirement: An independent interpreter scans the whole tree from the manifest

A standalone script under `scripts/` SHALL read
`docs/refactor/boundaries-manifest.json` directly and scan every governed
source file for boundary violations. It SHALL NOT run through the ESLint
pipeline, consume ESLint configuration, or consume ESLint output — so ESLint
suppression comments have no effect on it.

#### Scenario: An eslint-disable comment does not exempt a violation

- **WHEN** a boundary-violating import carries an `eslint-disable` (or
  `eslint-disable-next-line`) comment and the interpreter runs
- **THEN** the interpreter still reports the violation, naming file and line,
  and exits non-zero

#### Scenario: A clean tree passes

- **WHEN** the interpreter runs on a tree with no violation outside recorded
  dispositions
- **THEN** it exits zero

### Requirement: The interpreter covers dynamic imports and replicates the type-only distinction

The interpreter SHALL detect violations in both static `import ... from '…'`
clauses and dynamic `import('…')` expressions, and SHALL replicate the P6
import-kind distinction: a type-only import from a types-only-permitted package
passes, a value import fails.

#### Scenario: A dynamic import of a forbidden package is red

- **WHEN** a governed file references a manifest-forbidden specifier via
  dynamic `import('…')` and the interpreter runs
- **THEN** the interpreter reports it and exits non-zero

#### Scenario: The interpreter distinguishes import kind for P6

- **WHEN** the interpreter scans a `packages/sandbox-core` fixture containing a
  value import from contracts and another containing only `import type`
- **THEN** the value-import fixture is reported as a violation and the
  type-only fixture is not

### Requirement: The interpreter catches egress spellings the selector layer cannot

For S1, the interpreter SHALL detect network-egress variants that the ESLint
esquery selector misses — at minimum `window.fetch(...)`, `globalThis.fetch(...)`,
and calls through a local alias of `fetch` — in non-seam web source files.

#### Scenario: window.fetch outside the seam is red

- **WHEN** a non-seam web source file calls `window.fetch(...)` and the
  interpreter runs
- **THEN** the interpreter reports it and exits non-zero

#### Scenario: An aliased fetch call outside the seam is red

- **WHEN** a non-seam web source file assigns `fetch` to a local name and calls
  it, and the interpreter runs
- **THEN** the interpreter reports it and exits non-zero

### Requirement: The interpreter is a canon gate

The interpreter SHALL ship in the canon gate shape: a paired self-test invoked
as `node <script>.mjs && node --test <script>.test.mjs`; exemptions honored
only as three-field `{reason, owner, change}` data; and an empty scan treated
as failure, never as success.

#### Scenario: Zero files scanned is a failure

- **WHEN** the interpreter's scan roots resolve to zero source files (e.g. the
  manifest scope points at a missing directory)
- **THEN** it exits non-zero reporting the empty scan

#### Scenario: The paired self-test proves the red paths on fixtures

- **WHEN** the interpreter's self-test runs under `node --test`
- **THEN** it demonstrates, against fixtures and without modifying the real
  tree, non-zero outcomes for: a forbidden static import, a forbidden dynamic
  import, a P6 value import, a disable-commented violation, an egress variant
  spelling, and an exemption entry missing one of its three fields

#### Scenario: An incomplete exemption is rejected

- **WHEN** the interpreter loads an exemption entry lacking `reason`, `owner`,
  or `change`
- **THEN** it exits non-zero naming the entry and the missing field

### Requirement: The interpreter is wired into CI without renaming any existing check

The interpreter SHALL be exposed as a root `package.json` script following the
paired pattern and executed as a new step inside the existing required CI job.
No pre-existing CI check display name (`name:` value) SHALL change.

#### Scenario: A violating tree fails the required job at the interpreter step

- **WHEN** CI runs on a tree containing a boundary violation not covered by a
  recorded disposition
- **THEN** the existing required job fails at the interpreter's step

#### Scenario: Existing check names are byte-identical

- **WHEN** the CI workflow file is diffed against its pre-change version
- **THEN** every pre-existing `name:` value is byte-for-byte unchanged

