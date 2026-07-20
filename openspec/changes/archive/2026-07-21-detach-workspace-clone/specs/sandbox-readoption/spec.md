# sandbox-readoption

## ADDED Requirements

### Requirement: Boot recovery scan ownership is split between marker probe and tmux re-adoption

Boot recovery SHALL assign each recovering task to exactly one scan owner,
written down once: tasks parked or in pre-agent provisioning are owned by the
admission claim/processor path, which probes detached-job markers (alive keeps
the task parked, an exit marker settles the stage from its recorded code, an
unprovable job fails the attempt); tasks at agent-launch or later remain owned
by the existing tmux-session re-adoption scan, unchanged. The split SHALL NOT
depend on NestJS `onApplicationBootstrap` (or any framework hook) ordering
between providers: recovery SHALL be correct regardless of which scan runs
first, and a pre-agent sandbox with no tmux session SHALL never be treated as
a legacy orphan by the re-adoption scan.

#### Scenario: Parked task is recovered by the marker probe only

- **WHEN** the API boots while a task is parked behind a live detached transfer
- **THEN** the admission claim/processor path probes the markers and keeps the task parked
- **AND** the tmux re-adoption scan neither adopts nor fails that task

#### Scenario: Agent-phase task is recovered by tmux re-adoption only

- **WHEN** the API boots while a task is at agent-launch or later with a detached tmux session
- **THEN** the existing re-adoption scan recovers it exactly as before this change
- **AND** the marker probe does not settle or fail it

#### Scenario: Recovery is correct in either scan order

- **WHEN** the marker-probe recovery and the tmux re-adoption scan execute in either relative order at boot
- **THEN** every recovering task is handled by exactly one owner with the same outcome in both orders
- **AND** no pre-agent sandbox is reaped as a legacy orphan for lacking a tmux session

#### Scenario: Exited-while-down job settles from its marker

- **WHEN** the API boots after the detached clone finished (success or failure) during the downtime
- **THEN** the marker probe settles the transfer stage from the exit marker's recorded code and admission proceeds or fails accordingly
- **AND** success is never inferred from progress-file contents or silence
