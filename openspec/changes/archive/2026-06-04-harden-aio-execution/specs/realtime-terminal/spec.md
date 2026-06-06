## MODIFIED Requirements

### Requirement: Snapshot plus tail-replay reconnect
On client reconnect the orchestrator SHALL restore terminal state by first writing a periodic headless SerializeAddon snapshot that records the cols and rows it was taken at, then replaying the tail of `session.log` appended after the snapshot, reconciling any size difference between the snapshot and the current terminal. This SHALL hold under the connect-in AIO execution model: the orchestrator bridge (`AioPtyClient`/gateway) SHALL persist the raw PTY output to `workspaces/<id>/session.log` (there is no in-sandbox runner producer), and the `SnapshotManager` SHALL be backed by a REAL xterm headless terminal whose `serialize()` returns the actual visible frame — NOT a `NullHeadlessTerminal` whose `serialize()` is empty — so that a periodic snapshot is non-empty and `buildReconnectFrames` replays prior output to a reconnecting operator.

#### Scenario: Reconnect restores from snapshot then tail
- **WHEN** a client reconnects to an active task
- **THEN** the orchestrator first delivers the most recent SerializeAddon snapshot
- **AND** then replays the `session.log` bytes appended after that snapshot was taken

#### Scenario: Snapshot records its dimensions for size reconciliation
- **WHEN** a SerializeAddon snapshot is produced
- **THEN** it records the cols and rows it was captured at so a reconnecting client of a different size can reconcile the dimensions before applying it

#### Scenario: Reconnect replays prior output under connect-in
- **WHEN** an operator reconnects to a task that has been running under the connect-in AIO model and has already produced terminal output
- **THEN** the orchestrator delivers a NON-EMPTY snapshot from the real headless terminal followed by the tail of the persisted `workspaces/<id>/session.log`
- **AND** `buildReconnectFrames` returns the prior output rather than nothing

#### Scenario: session.log is persisted by the orchestrator, not the sandbox
- **WHEN** raw PTY output flows through the orchestrator bridge for an AIO-executed task
- **THEN** the orchestrator appends that output to `workspaces/<id>/session.log` so reconnect tail-replay has a durable source even though no in-sandbox runner producer writes it
