# self-update-action Delta

## ADDED Requirements

### Requirement: Sandbox asset extraction is portable across shared-mount hosts

The updater's BoxLite rootfs extraction SHALL NOT attempt to restore archive-recorded file ownership, so staging succeeds on hosts whose Docker bind mounts forbid `chown` (macOS/colima and equivalent VM file-sharing stacks) as well as on plain Linux hosts. Before extracting, staging SHALL remove stale temporary extraction directories left at the target rootfs path by previously failed attempts. Extraction failures SHALL continue to abort staging before any CAP service is recreated.

#### Scenario: Extraction succeeds on a chown-restricted shared mount

- **WHEN** the updater stages a BoxLite rootfs asset onto a bind mount that rejects `chown` operations
- **THEN** the archive extracts without attempting ownership restore
- **AND** the staged rootfs is moved into place and `BOXLITE_ROOTFS_PATH` is persisted as on any other host

#### Scenario: Stale temp directories from failed attempts are swept

- **WHEN** a prior staging attempt aborted and left a temporary extraction directory beside the target rootfs path
- **THEN** the next staging run removes such stale temporary directories before creating its own
- **AND** the live rootfs directories of other versions are untouched

#### Scenario: The generated staging script pins both properties

- **WHEN** the self-update unit suite inspects the generated BoxLite staging script
- **THEN** it asserts the extraction pipeline disables ownership restore with a flag accepted by both busybox tar and GNU tar
- **AND** it asserts the stale-temp sweep precedes the creation of the new temporary extraction directory
