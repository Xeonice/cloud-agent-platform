# aio-sandbox-execution Specification (delta)

## ADDED Requirements

### Requirement: AIO workspace materialization injects the repo copy via read-only subpath mount

The aio-local provider SHALL materialize the task workspace from the Repo's stored copy by mounting only that repo's bare mirror into the sandbox container read-only (docker volume subpath mount of `/repo-store/<repoId>.git`, requiring Docker Engine ≥ 26 semantics) and then performing a local `git clone` from the mounted path into the workspace directory inside the sandbox. The in-sandbox local clone SHALL handle git ownership checks (`safe.directory`) for the mounted path. No network git clone SHALL run inside the sandbox on this path.

#### Scenario: Materialization is a local clone from the mount
- **WHEN** an aio-local task provisions with a ready copy
- **THEN** the container is created with a read-only subpath mount of that repo's bare mirror
- **AND** the workspace is produced by a local clone from the mount, succeeding under the sandbox's non-root user

#### Scenario: Mount grants no write and no cross-repo visibility
- **WHEN** the agent inspects the mount path
- **THEN** it is read-only and contains only the task's repo copy
