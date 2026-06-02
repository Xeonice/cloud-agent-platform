## ADDED Requirements

### Requirement: Root CONTRIBUTING.md exists and is GitHub-discoverable

The system SHALL provide a `CONTRIBUTING.md` file at the repository root so that GitHub auto-surfaces it as the contribution guide.

#### Scenario: File present at repository root
- **WHEN** an inspector lists the repository root directory
- **THEN** a file named exactly `CONTRIBUTING.md` exists at the root (not under `.github/` or any subdirectory)
- **AND** the file is non-empty (byte size greater than 0)

### Requirement: Guide documents the five-step OpenSpec lifecycle

`CONTRIBUTING.md` SHALL document the contribution lifecycle as the five ordered steps used by this repository: Propose, Create Artifacts, Implement, Verify, Archive.

#### Scenario: All five lifecycle step names appear in order
- **WHEN** a reader reads the lifecycle section of `CONTRIBUTING.md`
- **THEN** the literal step labels `Propose`, `Create Artifacts`, `Implement`, `Verify`, and `Archive` each appear at least once
- **AND** they appear in that relative top-to-bottom order within the document

### Requirement: Guide routes contributors to the actual OpenSpec tooling

`CONTRIBUTING.md` SHALL reference the four OpenSpec slash commands and point to their backing skills so contributors invoke the real tooling rather than a generic PR flow.

#### Scenario: All four slash commands are named
- **WHEN** a reader scans `CONTRIBUTING.md` for tooling entry points
- **THEN** the literal strings `/opsx:propose`, `/opsx:apply`, `/opsx:archive`, and `/opsx:explore` each appear at least once

#### Scenario: Backing command and skill locations are cited
- **WHEN** a reader looks for where the tooling lives
- **THEN** `CONTRIBUTING.md` contains a path reference to `.claude/commands/opsx/` and a path reference to the backing skills under `.claude/skills/`

### Requirement: Guide documents the Track format convention for tasks.md

`CONTRIBUTING.md` SHALL describe the Track authoring convention for `tasks.md` so that apply-time parallelism and resume operate correctly.

#### Scenario: Track header and checkbox syntax are shown
- **WHEN** a reader reads the Track convention section
- **THEN** `CONTRIBUTING.md` shows the track header form `## N. Track: <name>` including the `(depends: ...)` annotation
- **AND** it shows the task checkbox form `- [ ] N.Y`

#### Scenario: Convention defers to canonical sources instead of restating them
- **WHEN** a reader follows the Track convention section
- **THEN** `CONTRIBUTING.md` links to `.claude/workflows/README.md` and to the schema under `openspec/schemas/spec-driven/` rather than duplicating their full contents

### Requirement: Guide includes standard contributor sections and a table of contents

`CONTRIBUTING.md` SHALL include the standard contributor-guide sections (how to propose, conventions, how things run) and a table of contents linking to them.

#### Scenario: Required sections and TOC are present
- **WHEN** a reader opens `CONTRIBUTING.md`
- **THEN** the document contains a table of contents near the top with at least three anchor links
- **AND** it contains a heading covering how to propose a change, a heading covering conventions, and a heading covering how things run
