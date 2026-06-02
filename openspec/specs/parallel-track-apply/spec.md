# parallel-track-apply Specification

## Purpose
TBD - created by archiving change enhance-openspec-with-workflows. Update Purpose after archive.
## Requirements
### Requirement: Track correction before parallel execution
The apply flow SHALL, before executing any task, run a correction step that reads the draft Track metadata in `tasks.md`, scans the codebase for real cross-track file coupling (shared routers, export tables, config), rebalances oversized or undersized tracks, and writes the corrected Track partition back into `tasks.md`.

#### Scenario: Draft tracks are corrected against real coupling
- **WHEN** apply begins for a change whose `tasks.md` has draft tracks
- **THEN** a correction agent runs before any implementation agent
- **AND** the corrected Track partition is persisted back into `tasks.md`

#### Scenario: Shared-file tasks are isolated
- **WHEN** the correction step detects a file written by tasks in more than one track
- **THEN** those tasks are either consolidated into one track or scheduled to a serial integration track, not left in parallel tracks

### Requirement: Worktree-isolated parallel implementation
The apply flow SHALL execute independent tracks in parallel, each in its own git worktree, with concurrency not exceeding the platform cap of 16. Tasks within a track SHALL run sequentially in track order.

#### Scenario: Tracks run in isolated worktrees
- **WHEN** N independent tracks are implemented
- **THEN** each track's agent operates in a separate git worktree
- **AND** no more than 16 track agents run concurrently

#### Scenario: Intra-track order preserved
- **WHEN** a track contains ordered tasks
- **THEN** those tasks are implemented in declared order within the same worktree

### Requirement: Integration merge with build verification and repair
After parallel tracks complete, the apply flow SHALL merge worktrees back to the working tree, resolve shared-file conflicts, run the project's build and test command, and on failure dispatch repair agents until the build passes or a repair budget is exhausted.

#### Scenario: Build is verified after merge
- **WHEN** all tracks have merged
- **THEN** the project build/test command is executed
- **AND** the apply step does not report success while the build is failing

#### Scenario: Failures trigger repair loop
- **WHEN** the post-merge build fails
- **THEN** repair agents are dispatched to fix the failures
- **AND** the build is re-run after each repair round

### Requirement: Idempotent resume
The apply flow SHALL be resumable. On re-run it MUST read the `[x]` checkboxes in `tasks.md` and schedule only tasks that are not yet complete.

#### Scenario: Completed tasks are not re-run
- **WHEN** apply is re-run after a partial completion
- **THEN** tasks already marked `[x]` are skipped
- **AND** only incomplete tracks are dispatched

### Requirement: Serial fallback for small changes
The apply flow SHALL fall back to the existing serial implementation when the number of tasks is below a configured threshold, avoiding workflow overhead for small changes.

#### Scenario: Small change uses serial path
- **WHEN** a change has fewer tasks than the threshold
- **THEN** apply implements them serially without spawning the track workflow

