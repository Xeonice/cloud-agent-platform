## ADDED Requirements

### Requirement: docs/repo-layout.md exists in a new docs directory

The system SHALL provide an orientation guide at `docs/repo-layout.md`, creating the `docs/` directory if it does not yet exist.

#### Scenario: File present at expected path
- **WHEN** an inspector lists the `docs/` directory at the repository root
- **THEN** a file named exactly `repo-layout.md` exists at `docs/repo-layout.md`
- **AND** the file is non-empty (byte size greater than 0)

### Requirement: Guide presents an annotated directory tree with the two-bucket model

`docs/repo-layout.md` SHALL present an annotated directory tree that distinguishes the `.claude/` agent-tooling bucket from the `openspec/` spec-content bucket.

#### Scenario: Both buckets and their key subdirectories appear in the tree
- **WHEN** a reader reads the directory-tree section of `docs/repo-layout.md`
- **THEN** the tree references `.claude/` with its `commands/opsx`, `skills`, and `workflows` subdirectories
- **AND** the tree references `openspec/` with its `specs`, `changes`, `changes/archive`, `schemas/spec-driven`, and `config.yaml` entries

#### Scenario: File naming convention is lowercase-hyphenated
- **WHEN** an inspector checks the name of the orientation guide and any new doc files added by this change
- **THEN** every new doc filename uses only lowercase letters, digits, and hyphens before the extension (e.g. `repo-layout.md`)

### Requirement: Guide explains per-change anatomy and the delta convention

`docs/repo-layout.md` SHALL explain the per-change artifact anatomy and the requirement-delta convention, citing the live example change.

#### Scenario: Artifact files and delta operations are named
- **WHEN** a reader reads the per-change anatomy section
- **THEN** the document names `proposal.md`, `design.md`, `tasks.md`, and the delta `specs/` directory as the per-change artifacts
- **AND** it names the `## ADDED Requirements`, `## MODIFIED Requirements`, and `## REMOVED Requirements` delta operations

#### Scenario: Live example is cited
- **WHEN** a reader looks for a concrete example of a change
- **THEN** the document references `enhance-openspec-with-workflows` as the live structural example

### Requirement: Guide explains the schema fork and rollback path

`docs/repo-layout.md` SHALL explain the `openspec/schemas/spec-driven/` schema fork, its selection via `config.yaml`, and the rollback path.

#### Scenario: Schema location, selection, and rollback are documented
- **WHEN** a reader reads the schema section
- **THEN** the document references the `openspec/schemas/spec-driven/` directory and `openspec/config.yaml` as the selection mechanism
- **AND** it states the rollback path of deleting the schema directory to revert to the default schema

### Requirement: Guide calls out untracked side-car files

`docs/repo-layout.md` SHALL call out the deliberately untracked side-car files so contributors do not add them to the schema dependency graph.

#### Scenario: Side-car files are named with their exclusion rationale
- **WHEN** a reader reads the side-car callout
- **THEN** the document names `research-brief.md` and `verification-report.md` as side-car files
- **AND** it states they are intentionally outside the schema dependency graph and must not be wired into it

### Requirement: Guide cross-links the canonical workflows README

`docs/repo-layout.md` SHALL cross-link `.claude/workflows/README.md` rather than duplicating its wiring, workflow table, threshold, and executor-boundary content.

#### Scenario: Cross-link present without duplication
- **WHEN** a reader looks for workflow wiring details in `docs/repo-layout.md`
- **THEN** the document contains a link to `.claude/workflows/README.md`
- **AND** it defers to that README for the workflow table and threshold rather than restating them in full
