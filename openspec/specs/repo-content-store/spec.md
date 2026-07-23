# repo-content-store Specification

## Purpose
TBD - created by archiving change add-repo-content-store. Update Purpose after archive.
## Requirements
### Requirement: Every importable Repo owns a bare-mirror content copy in the shared repo-store volume

The system SHALL maintain, for each imported Repo, a bare git mirror (produced by `git clone --mirror` or an equivalent that yields all refs) stored in a shared docker named volume (the repo-store) under a per-repo path keyed by the Repo id (`/repo-store/<repoId>.git`). The repo-store volume SHALL be mounted into the api service and be mountable into sandbox containers, following the existing workspaces named-volume sharing pattern. The copy SHALL be the single content source consumed by all downstream paths: manual refresh (`git fetch`), volume-mount injection, and archive (tar) injection.

#### Scenario: Import produces a bare mirror keyed by repo id
- **WHEN** a Repo import completes successfully
- **THEN** a bare git repository exists in the repo-store at the per-repo path containing the source's refs
- **AND** the same copy layout is produced regardless of import mode (forge picker, URL, or local path)

#### Scenario: One copy serves mount and archive consumers
- **WHEN** a task is provisioned on a provider that injects via volume mount, and another task on a provider that injects via archive upload
- **THEN** both consume the same bare-mirror copy without converting it to a different stored format

### Requirement: Import acquires the content copy with progress and atomic completion

Import flows SHALL perform content acquisition at import time on the API host, SHALL report acquisition progress and typed failure causes to the caller, and SHALL complete atomically: a copy is either fully materialized at its final path or absent. A failed acquisition SHALL NOT leave a partially-written copy at the final path (staging + atomic rename or equivalent), and a failed import SHALL be retryable without manual cleanup.

#### Scenario: Failed acquisition leaves no half-written copy
- **WHEN** content acquisition fails partway (network error, invalid source)
- **THEN** the final per-repo path does not contain a partial copy
- **AND** retrying the import can succeed without operator cleanup of the repo-store

#### Scenario: Acquisition progress is observable
- **WHEN** an operator imports a repository whose clone takes noticeable time
- **THEN** the import surface reports progress until the copy is ready or a typed failure is reported

### Requirement: Copy freshness is user-managed via explicit refresh only

The system SHALL NOT fetch or otherwise update a Repo's content copy at task start. The system SHALL provide an explicit per-repo refresh operation that updates the existing bare mirror from its recorded source (`git fetch` semantics, including ref updates). A failed refresh SHALL keep the last-good copy usable and report a typed failure.

#### Scenario: Task start does not refresh
- **WHEN** a task starts for a Repo whose copy is stale relative to its remote
- **THEN** the task workspace is materialized from the stored copy as-is, with no network fetch on the task-start path

#### Scenario: Failed refresh preserves the last-good copy
- **WHEN** a refresh fails (remote unreachable, auth revoked)
- **THEN** the previous copy remains ready and usable for new tasks
- **AND** the failure cause is reported to the operator

### Requirement: Copy lifecycle follows the Repo

Deleting a Repo SHALL delete its content copy from the repo-store. The system SHALL NOT automatically mass-backfill copies for pre-existing Repos on upgrade; backfill is per-repo and operator-triggered (via refresh/re-import).

#### Scenario: Repo deletion removes the copy
- **WHEN** an operator deletes a Repo
- **THEN** its per-repo path in the repo-store is removed

#### Scenario: Upgrade does not trigger bulk cloning
- **WHEN** the system starts after upgrading with N pre-existing Repos
- **THEN** no automatic content acquisition runs for those Repos

### Requirement: Copies are exposed to sandboxes read-only and per-task scoped

When a copy is exposed to a sandbox via volume mount, the mount SHALL be read-only and SHALL be scoped to the single Repo the task uses (volume subpath or equivalent), so a sandboxed agent can neither modify the stored copy nor enumerate other Repos' copies.

#### Scenario: Sandbox cannot write to the copy
- **WHEN** a task workspace was materialized from a mounted copy and the agent attempts to write to the mount path
- **THEN** the write fails and the stored copy is unchanged

#### Scenario: Sandbox sees only its own repo's copy
- **WHEN** the repo-store contains copies for multiple Repos and a task is provisioned with mount injection
- **THEN** only the copy for the task's Repo is visible inside the sandbox

