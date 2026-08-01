# boundaries-manifest — delta

## ADDED Requirements

### Requirement: A machine-readable boundaries manifest is the single declaration source

The repository SHALL contain `docs/refactor/boundaries-manifest.json` encoding,
as data, every boundary rule fixed in `docs/refactor/02-boundaries-manifest.md`:
the A-table package rules (P1–P8), the C-table seam rules (S1–S3), and the
D-table security seams (four entries). The manifest SHALL be a transcription of
those tables — it invents no rule the tables do not state, and it omits no rule
the tables do state.

#### Scenario: Every fixed rule has exactly one manifest entry

- **WHEN** the manifest is parsed as JSON
- **THEN** it contains exactly one entry for each of P1–P8, exactly one entry
  for each of S1–S3, and exactly four D-table security-seam entries
- **AND** no entry exists whose rule id is absent from the 工件02 tables

### Requirement: Manifest edits are architecture decisions carried with provenance

The manifest SHALL open with a top-level `$comment` — same contract as
`docs/refactor/contexts-manifest.json` — stating that modifying the file is an
architecture decision that requires an OpenSpec change for provenance. Every
rule entry SHALL carry a `provenance` field (the 工件02 table row it
transcribes) and a `change` field (the owning change name). A manifest entry
missing either field SHALL be rejected by manifest consumers as malformed.

#### Scenario: The change-provenance comment is present

- **WHEN** the manifest's top-level keys are read
- **THEN** a `$comment` exists stating that modification of this file is an
  architecture decision requiring change 留痕

#### Scenario: An entry without provenance is rejected

- **WHEN** a consumer (the CI interpreter or the shared ESLint config) loads a
  manifest fixture whose rule entry lacks `provenance` or `change`
- **THEN** that consumer exits non-zero (or throws at config load) naming the
  malformed entry and the missing field

### Requirement: Exemption entries are three-field reviewable data

Every exemption the manifest tolerates SHALL carry exactly the three fields
`{reason, owner, change}` — per-file seam exemptions, tolerated egress sites,
and any rule-scoped allowlist entry alike. An exemption entry missing any of the
three fields SHALL NOT be honored: consumers SHALL fail red naming the entry
and the missing field, rather than silently applying or silently dropping it.

#### Scenario: A complete exemption is honored

- **WHEN** a consumer evaluates a site covered by an exemption entry carrying
  `reason`, `owner`, and `change`
- **THEN** the site is not reported as a violation

#### Scenario: An incomplete exemption fails closed

- **WHEN** a consumer loads a manifest fixture containing an exemption entry
  missing one of `reason`, `owner`, `change`
- **THEN** the consumer exits non-zero naming the entry and the missing field

### Requirement: Already-landed rules are incorporated by reference, never re-implemented

The manifest entries for P3, P7, and S3 SHALL reference the paths of their
existing enforcers (as recorded in the 工件02 tables) instead of restating
enforceable rule data, and neither the ESLint layer nor the CI interpreter
SHALL emit a second enforcement for them.

#### Scenario: Landed rules point at their existing gates

- **WHEN** the manifest entries for P3, P7, and S3 are read
- **THEN** each carries a reference to the existing enforcer's repository path
- **AND** searching the shared ESLint config and the CI interpreter finds no
  second implementation of those three rules

### Requirement: Two consumers derive independently from the manifest, with no codegen

The manifest SHALL be consumed by exactly two independent interpreters — the
shared ESLint config (loaded at lint time) and the standalone CI interpreter
script — each reading `docs/refactor/boundaries-manifest.json` directly.
Neither consumer SHALL read the other's output or configuration, and no
generated intermediate artifact (ESLint config fragment, rule snapshot, or
equivalent) SHALL be committed or produced as a build step.

#### Scenario: No generated artifact exists between manifest and consumers

- **WHEN** the repository is searched for a committed or build-produced config
  fragment derived from the boundaries manifest
- **THEN** none exists; the shared ESLint config imports the manifest JSON at
  load time and the CI interpreter reads the same JSON path itself

#### Scenario: The interpreters do not feed each other

- **WHEN** the CI interpreter's inputs are inspected
- **THEN** it reads the manifest and repository source files only — no ESLint
  output, suppression file, or ESLint config is among its inputs

### Requirement: Boundary registries record the enforcing change

The registry rows governed by this change SHALL be flipped to their enforced
status — the 工件04 C-table rows for R1/R2/R9/R10 and the 工件02 A/C/D/E rows
for the rules landed here — and every flipped cell SHALL name the change that
landed the enforcement.

#### Scenario: Flipped registry cells carry the change name

- **WHEN** the R1/R2/R9/R10 rows of `docs/refactor/04-rules-registry.md` and
  the corresponding rows of `docs/refactor/02-boundaries-manifest.md` are read
- **THEN** each cell flipped by this change names `enforce-boundaries-from-manifest`
