# agent-docs-reconciliation Specification

## Purpose
TBD - created by archiving change enforce-boundaries-from-manifest. Update Purpose after archive.
## Requirements
### Requirement: Every governed CLAUDE.md carries the dependency section

Each of the four governed subtree CLAUDE.md files SHALL contain a
"What this subtree may depend on" section — `apps/api`, `apps/web`,
`packages/contracts`, `packages/sandbox`. The two files currently lacking it
(`packages/contracts`, `packages/sandbox`) SHALL gain it as part of this
change.

#### Scenario: All four files have the section

- **WHEN** each governed CLAUDE.md is parsed for the
  "What this subtree may depend on" heading
- **THEN** the section is present in all four files

### Requirement: A gate reconciles the dependency sections against the manifest

A gate SHALL parse the "What this subtree may depend on" section of each
governed CLAUDE.md and compare the declared dependency set against the A-table
entries of `docs/refactor/boundaries-manifest.json` for that subtree. Any
divergence — a declared dependency the manifest forbids, or a
manifest-material constraint the section contradicts — SHALL fail the gate
naming the file and the mismatched entry.

#### Scenario: A contradicting declaration is red

- **WHEN** a governed CLAUDE.md's dependency section declares a dependency the
  manifest's A-table forbids for that subtree, and the gate runs
- **THEN** the gate exits non-zero naming the file and the contradicting entry

#### Scenario: Aligned prose passes

- **WHEN** every governed dependency section agrees with the manifest's
  A-table for its subtree, and the gate runs
- **THEN** the gate exits zero

#### Scenario: A manifest edit without a prose update is caught

- **WHEN** the manifest's A-table entry for a subtree changes and the
  corresponding CLAUDE.md section is left stale, and the gate runs
- **THEN** the gate exits non-zero naming the stale file

### Requirement: A missing section fails closed

The gate SHALL exit non-zero, naming the file, when a governed CLAUDE.md lacks
the "What this subtree may depend on" section or the section cannot be parsed
into a dependency set — it SHALL NOT skip that file and report success.

#### Scenario: A missing section is red, not skipped

- **WHEN** a governed CLAUDE.md has no parseable
  "What this subtree may depend on" section and the gate runs
- **THEN** the gate exits non-zero naming that file
- **AND** the gate's output shows the file was rejected, not omitted from the
  comparison

### Requirement: Perishable exact counts are demoted to approximations

The three located perishable exact figures SHALL be rewritten as
approximations rather than exact claims — the source-file counts in
`apps/api/CLAUDE.md` and `apps/web/CLAUDE.md` and the module count in
`packages/contracts/CLAUDE.md`.

#### Scenario: The exact figures no longer appear as exact claims

- **WHEN** the three located lines are read after the change
- **THEN** none of them states an exact count ("454 source files",
  "261 source files", "45 modules"); each uses approximate wording instead

### Requirement: The reconciliation gate is a canon gate

The gate SHALL ship with a paired self-test
(`node <script>.mjs && node --test <script>.test.mjs`) proving its red paths on
fixtures, and SHALL treat zero governed files found as failure.

#### Scenario: Zero governed files is a failure

- **WHEN** the gate resolves zero governed CLAUDE.md files (e.g. paths moved)
- **THEN** it exits non-zero reporting the empty set

#### Scenario: The paired self-test proves the red paths

- **WHEN** the self-test runs under `node --test`
- **THEN** it demonstrates, against fixtures, non-zero outcomes for a
  missing-section fixture, a contradicting-declaration fixture, and an
  empty-governed-set fixture

