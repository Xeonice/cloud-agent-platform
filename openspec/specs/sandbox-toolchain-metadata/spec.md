# sandbox-toolchain-metadata Specification

## Purpose
TBD - created by archiving change add-sandbox-toolchain-metadata. Update Purpose after archive.
## Requirements
### Requirement: Sandbox images declare builder-selected toolchain metadata

Every supported newly built sandbox image SHALL contain `/etc/cap/sandbox-metadata.json` with `schemaVersion: 1`, a non-empty exact `sandboxVersion`, and a `dependencies` map of non-empty dependency ids to non-empty exact version strings. The map SHALL contain only dependencies the image builder chooses to expose. Moving selectors such as `latest` SHALL NOT be valid metadata values. CAP SHALL NOT scan or infer undeclared dependencies.

#### Scenario: Official image declares the official toolchain
- **WHEN** an official CAP sandbox image is built
- **THEN** its metadata declares the exact sandbox version and the installed Codex, Claude Code, and OpenSpec versions
- **AND** it does not enumerate unrelated operating-system or package-manager dependencies

#### Scenario: Custom image declares only relevant custom dependencies
- **WHEN** a custom image builder supplies additional dependency key/version pairs to the supported metadata build helper
- **THEN** the generated metadata contains those pairs without requiring CAP to know their package type
- **AND** dependencies the builder did not declare are absent

#### Scenario: Moving version selector is rejected
- **WHEN** image metadata declares a dependency or sandbox version using `latest`
- **THEN** metadata validation fails with a concrete non-exact-version reason

### Requirement: Metadata is read before the Agent runtime launches

CAP SHALL read and validate the metadata file from the actually provisioned sandbox through the provider-neutral command executor before runtime credential setup and before launching Codex or Claude Code. A missing, unreadable, malformed, or unsupported metadata document SHALL fail runtime preflight and SHALL prevent Agent launch.

#### Scenario: Valid metadata permits runtime setup
- **WHEN** an AIO or BoxLite sandbox is provisioned with valid schema-version-1 metadata
- **THEN** CAP parses the metadata before runtime setup
- **AND** the selected Agent runtime may proceed only after that read succeeds

#### Scenario: Missing metadata blocks launch
- **WHEN** a newly built sandbox does not contain `/etc/cap/sandbox-metadata.json`
- **THEN** preflight fails with a distinct sandbox-metadata error
- **AND** Codex and Claude Code are not launched

#### Scenario: Selected runtime version is absent
- **WHEN** a task selects Codex or Claude Code but the official image metadata omits that selected runtime dependency key
- **THEN** preflight fails before credentials or task prompts are injected

### Requirement: Effective metadata is persisted as an immutable run snapshot

After successful preflight, CAP SHALL persist the parsed metadata with the effective sandbox run and SHALL expose an additive non-secret sandbox metadata summary on task read responses. Historical task reads SHALL use the persisted effective snapshot and SHALL NOT substitute metadata from the current environment record, current image tag, or current CAP release.

#### Scenario: Task read returns the metadata that actually launched
- **WHEN** a task successfully starts from a sandbox containing valid metadata
- **THEN** its effective sandbox run stores that exact parsed metadata
- **AND** subsequent task reads return the same sandbox version and dependency map

#### Scenario: Environment is rebuilt after a task starts
- **WHEN** a custom environment tag later resolves to a rebuilt image with different dependency versions
- **THEN** an existing task continues to report its original persisted metadata snapshot
- **AND** a newly provisioned task reports the new image's metadata

#### Scenario: Runtime-installed packages do not mutate the snapshot
- **WHEN** an Agent installs or upgrades packages after launch
- **THEN** the task's base sandbox metadata snapshot remains unchanged
