# boundary-lint-rules — delta

## ADDED Requirements

### Requirement: Package-boundary rules P1–P8 are derived from the manifest as package-name patterns

The shared ESLint config SHALL derive, at load time and directly from
`docs/refactor/boundaries-manifest.json`, import-restriction rules for the
A-table package rules — expressed as package-name patterns
(`no-restricted-imports` patterns), never as filesystem zones — and SHALL scope
each rule to the package the manifest constrains (a rule constraining
`apps/web` applies to `apps/web` files only).

#### Scenario: A forbidden cross-package import is reported

- **WHEN** a source file in a governed package imports a specifier the manifest
  forbids for that package, and ESLint runs on that file
- **THEN** ESLint reports an error on the import naming the restriction

#### Scenario: An allowed import stays clean

- **WHEN** a source file imports a specifier the manifest allows for its
  package, and ESLint runs on that file
- **THEN** no boundary rule reports an error for that import

#### Scenario: A rule scoped to one package does not fire in another

- **WHEN** a source file imports a specifier that the manifest forbids only for
  a different package, and ESLint runs on that file
- **THEN** no boundary rule reports an error for that import

### Requirement: P6 permits type-only imports and rejects value imports

The derived P6 rule SHALL use the typescript-eslint restricted-imports variant
with `allowTypeImports: true`, so that in `packages/sandbox-core` (which may
reference `@cap/contracts` as types only) an `import type` from contracts is
accepted and any value import from contracts is an error.

#### Scenario: A value import from contracts in sandbox-core is an error

- **WHEN** a `packages/sandbox-core` source file contains a value import from
  `@cap/contracts`, and ESLint runs on it
- **THEN** ESLint reports an error on that import

#### Scenario: A type-only import from contracts in sandbox-core is clean

- **WHEN** a `packages/sandbox-core` source file imports from `@cap/contracts`
  using `import type` only, and ESLint runs on it
- **THEN** no boundary rule reports an error

### Requirement: S1 flags network egress outside the designated transport files by discovery

The ESLint layer SHALL flag `fetch(...)` calls and `new WebSocket(...)`
constructions anywhere under `apps/web/src` by syntax discovery (esquery
selectors), with per-file exemptions for exactly the two designated transport
files (`lib/api/real.ts` and the WebSocket client module) granted in flat
config. The rule SHALL NOT be implemented as an enumeration of files to scan.

#### Scenario: Egress added outside the seam is reported

- **WHEN** a `fetch` call or `new WebSocket` construction is added to a web
  source file that is not a designated transport file, and ESLint runs on it
- **THEN** ESLint reports an error on that call

#### Scenario: The designated transport files are exempt

- **WHEN** ESLint runs on the two designated transport files containing their
  existing `fetch` and `new WebSocket` sites
- **THEN** no S1 error is reported for those files

### Requirement: Pre-existing non-seam egress sites are dispositioned, and the tree lints green

Every pre-existing egress site outside the designated transport files SHALL be
covered by exactly one recorded disposition — a three-field exemption entry, a
ratchet baseline entry, or removal by consolidating the call into the seam —
such that lint on the committed tree passes without any unrecorded suppression.

#### Scenario: The committed tree passes lint with dispositions recorded

- **WHEN** the repository lint task runs on the committed tree after the rules land
- **THEN** it exits zero
- **AND** every pre-existing non-seam egress site either no longer exists (was
  consolidated) or appears in exactly one recorded disposition (exemption entry
  or ratchet baseline), never in both and never in neither

### Requirement: S2 forbids components bypassing the capabilities seam

The ESLint layer SHALL report component code that imports data-fetching
functions from the real transport module directly, bypassing the
`capabilities.ts` single real/mock switch point that the rule's message SHALL
cite as its normative source. Pre-existing bypasses SHALL be tolerated through
exactly one ratchet mechanism (ESLint bulk suppressions or the shared
`scripts/ratchets` comparator — the design decides which), never recorded in
both.

#### Scenario: A new seam bypass is reported

- **WHEN** a component file adds an import of a data-fetching function from the
  real transport module, and ESLint runs on it
- **THEN** ESLint reports an error citing the capabilities seam

#### Scenario: Tolerated bypasses live in exactly one ledger

- **WHEN** the S2 存量 records are inspected
- **THEN** each tolerated bypass appears in exactly one ratchet mechanism, and
  no bypass is double-recorded across ESLint suppressions and a
  `scripts/ratchets` baseline

#### Scenario: A fixed bypass cannot pass without shrinking the ledger

- **WHEN** a tolerated bypass is removed from the code but its ledger entry is
  not shrunk in the same change
- **THEN** the owning ratchet mechanism reports the stale entry as a failure

### Requirement: Boundary rules reach every package through the shared config

The derived rules SHALL take effect through the shared ESLint config so that
all 14 `eslint.config.*` files in the repository resolve them, giving both the
editor loop (ESLint on a single file) and the pre-commit loop (`turbo run
lint`) without new hooks.

#### Scenario: A violation anywhere fails the repo lint task

- **WHEN** a boundary violation exists in any workspace package and the
  repository lint task runs (the same entry pre-commit invokes)
- **THEN** the run exits non-zero naming the violating file

#### Scenario: Single-file ESLint reports the violation in place

- **WHEN** ESLint is invoked on just the violating file, as an editor
  integration does
- **THEN** the boundary error is reported for that file

### Requirement: Manifest edits invalidate cached lint results

The boundaries manifest path SHALL be wired into turbo's lint-task inputs
(`globalDependencies` or per-package lint inputs) so that editing the manifest
never allows a stale green lint result to be replayed from cache.

#### Scenario: A manifest edit forces lint to re-run

- **WHEN** `docs/refactor/boundaries-manifest.json` is modified and the lint
  task is invoked again
- **THEN** turbo reports a cache miss for the lint tasks and re-executes them

### Requirement: Lint fails closed when the manifest cannot be loaded

The shared config load SHALL throw — so lint exits non-zero — when the
manifest is missing, unparsable, or yields an empty rule set; the rules are
never silently absent while lint reports green.

#### Scenario: A missing manifest turns lint red

- **WHEN** the manifest file is absent or unparsable and the lint task runs
- **THEN** lint exits non-zero with a config-load error, instead of passing
  with boundary rules skipped
