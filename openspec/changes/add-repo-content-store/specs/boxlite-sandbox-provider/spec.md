# boxlite-sandbox-provider Specification (delta)

## ADDED Requirements

### Requirement: BoxLite workspace materialization injects the repo copy via archive upload

The BoxLite provider SHALL materialize the task workspace from the Repo's stored copy by streaming the bare mirror as a tar archive through the existing archive-upload contract (`uploadArchive`) into the box, then performing a local `git clone` from the unpacked mirror into the workspace directory. The archive path SHALL be used because the BoxLite REST create API exposes no volume-mount field (verified against the create schema); if a future BoxLite API version exposes mounts, adoption SHALL go through a new declared capability rather than changing this default. Archive transfer SHALL be streamed (not buffered wholesale in memory) and its failure SHALL surface as a typed materialization failure.

#### Scenario: Copy reaches the box via uploadArchive
- **WHEN** a BoxLite task provisions with a ready copy
- **THEN** the bare mirror is delivered into the box through the archive-upload contract and the workspace is produced by a local clone inside the box
- **AND** no network git clone runs inside the box on this path

#### Scenario: Transfer failure is typed and actionable
- **WHEN** the archive upload fails mid-transfer
- **THEN** provisioning reports a typed workspace-materialization failure identifying the transfer stage
