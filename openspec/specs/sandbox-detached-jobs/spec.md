# sandbox-detached-jobs Specification

## Purpose
TBD - created by archiving change detach-workspace-clone. Update Purpose after archive.
## Requirements
### Requirement: Detached jobs survive the launching exec session

The sandbox detached-job primitive SHALL launch a job in its own session via
`setsid` (not bare `nohup`) so the job survives teardown of the short-lived
exec shell/HTTP connection that spawned it. The primitive SHALL live in
`packages/sandbox-core` behind the shared sandbox stage-executor seam so every
provider (BoxLite, AIO) and every agent runtime consumes one identical
implementation; provider packages SHALL NOT reimplement their own detach
mechanics.

#### Scenario: Job outlives the launching exec

- **WHEN** a detached job is launched through a sandbox exec whose shell session and HTTP connection terminate immediately after launch
- **THEN** the job process continues running in the sandbox
- **AND** it later writes its exit marker with the child's real exit code

#### Scenario: Both providers share one launch implementation

- **WHEN** BoxLite and AIO each execute a detached workspace job
- **THEN** both route through the same sandbox-core primitive behind the shared stage-executor seam
- **AND** neither provider package contains its own detach/marker implementation

### Requirement: A wrapper waits on the job child and writes the exit marker

Every detached job SHALL be started under a wrapper process that waits on the
job child and, after the child terminates, writes the child's numeric exit code
to the exit marker exactly once. Because the wrapper reaps its own child, no
zombie process SHALL remain after job termination regardless of whether the
sandbox image's PID 1 reaps orphans. Job success or failure SHALL only ever be
concluded from the exit marker contents — never inferred from progress-file
silence, progress-file contents, or the absence of the process.

#### Scenario: Exit code is captured for success and failure

- **WHEN** a detached job child exits with code 0, and separately when one exits with a nonzero code
- **THEN** in each case the exit marker exists afterward and contains that exact exit code
- **AND** the marker is written exactly once per job

#### Scenario: No zombie survives job exit

- **WHEN** a detached job child terminates in a sandbox whose PID 1 does not reap orphans
- **THEN** the wrapper has waited on the child, so no zombie (defunct) process for the job remains in the sandbox process table

#### Scenario: Success is never inferred without an exit marker

- **WHEN** a job's progress file has stopped growing but no exit marker exists
- **THEN** the job is treated as not settled (still running or unprovable)
- **AND** no caller records the stage as succeeded

### Requirement: Jobs expose a pid/progress/exit marker layout

Each detached job SHALL own a per-job marker directory
(`/tmp/cap-jobs/<jobId>/`) containing a `pid` marker written at launch, a
`progress` marker that receives the job's redirected output stream while it
runs, and an `exit` marker written only at termination. The `pid` marker SHALL
be readable before the launch exec returns so a caller that loses the launch
response can still find the job. Marker probes and reads SHALL be cheap,
short-lived operations independent of the job's own duration.

#### Scenario: Pid marker exists before the launch call returns

- **WHEN** the detached-job launch exec completes
- **THEN** the job's `pid` marker already contains the wrapper/child process identity
- **AND** a subsequent independent exec can locate the job from the marker directory alone

#### Scenario: Progress stream is readable mid-flight

- **WHEN** a running job writes output while a caller polls the marker directory
- **THEN** the poll observes the `progress` marker's current size/mtime and content without blocking on the job
- **AND** no `exit` marker exists yet

### Requirement: Marker probe triages a job three ways

A marker probe SHALL classify a job into exactly one of three states: alive
(pid refers to a live process and no exit marker), exited (exit marker present
— settle from its recorded exit code), or unknown (neither liveness nor an
exit marker can be proven). Unknown SHALL be treated as failure of the probed
stage; the probe SHALL NOT translate unknown into success or into continued
waiting beyond the configured liveness gates.

#### Scenario: Alive job keeps waiting

- **WHEN** a probe finds the pid alive and no exit marker
- **THEN** the job is classified alive and the caller continues polling under its liveness gates

#### Scenario: Exited job settles from the exit marker

- **WHEN** a probe finds an exit marker containing code 0, and separately one containing a nonzero code
- **THEN** the stage settles as success or as a typed failure respectively, using the recorded code
- **AND** settlement does not depend on the launch-time HTTP response having survived

#### Scenario: Unprovable job fails closed

- **WHEN** a probe can prove neither process liveness nor an exit marker (e.g. marker directory missing after a sandbox wipe)
- **THEN** the stage is settled as a typed failure
- **AND** it is not recorded as succeeded or left parked indefinitely

### Requirement: Workspace-producing jobs publish atomically

A detached job that materializes a workspace tree SHALL publish it atomically
(work in a staging location, then a single atomic rename/flip into the final
workspace path) so no consumer or boot-time triage can ever observe a
partially written tree at the final path. The exit marker SHALL be written
only after publish, so an exit-marker success implies the published tree is
complete.

#### Scenario: Killed mid-transfer leaves no half-published workspace

- **WHEN** a workspace-producing job is killed while its transfer is incomplete
- **THEN** the final workspace path contains either nothing or a previously complete tree — never a partial one
- **AND** no exit marker reporting success exists

#### Scenario: Success marker implies a complete tree

- **WHEN** a job's exit marker records success
- **THEN** the final workspace path contains the fully published tree

### Requirement: Jobs are killable through the pid marker with no resurrection

Stopping a detached job SHALL kill its process group using the identity in the
pid marker and SHALL be idempotent: killing an already-exited job is a safe
no-op that settles from the existing exit marker. The stop-vs-exit race SHALL
be resolved with the fence/compare-and-set discipline: once a stop has won and
terminal cleanup has settled, a late exit marker or late job output SHALL NOT
resurrect the stage as succeeded or re-establish ownership.

#### Scenario: Kill via pid marker terminates the job

- **WHEN** a stop request kills a running detached job through its pid marker
- **THEN** the job's process group terminates
- **AND** the standard fence/cleanup chain runs afterward

#### Scenario: Killing an exited job is idempotent

- **WHEN** a stop request targets a job whose exit marker was already written
- **THEN** the kill is a safe no-op
- **AND** settlement uses the already-recorded exit marker

#### Scenario: Late exit cannot resurrect a stopped task

- **WHEN** a job writes a success exit marker after the task's stop path has already won and completed terminal cleanup
- **THEN** the task remains in its stop-determined terminal state
- **AND** the late marker does not restore ownership or flip the stage to succeeded

### Requirement: In-sandbox network clone is no longer the primary workspace materialization consumer

The detached-job primitive SHALL remain available for long-running in-sandbox work, but workspace materialization SHALL NOT depend on a detached in-sandbox network `git clone` by default; that consumer survives only behind the explicitly gated `git` fallback variant of the workspace source. The detached-job contracts (setsid survival, exit markers, atomic publish, killability) SHALL be preserved unchanged for their remaining consumers and for the gated fallback.

#### Scenario: Default materialization spawns no detached clone job
- **WHEN** a task provisions with default configuration on a provider supporting copy injection
- **THEN** no detached in-sandbox clone job is launched for workspace materialization

#### Scenario: Gated fallback still honors detached-job contracts
- **WHEN** the git fallback gate is enabled and materialization uses the legacy path
- **THEN** the detached clone job behaves per the existing detached-job requirements

