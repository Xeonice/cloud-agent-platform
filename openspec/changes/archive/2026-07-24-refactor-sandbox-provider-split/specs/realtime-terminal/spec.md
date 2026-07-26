## MODIFIED Requirements

### Requirement: Snapshot plus tail-replay reconnect
On client reconnect the orchestrator SHALL restore the live terminal according to the client's acknowledged byte offset. For a fresh browser load (`fromSeq <= 0`), the orchestrator SHALL send the latest headless SerializeAddon snapshot of the current visible frame, or capture one immediately when no periodic snapshot exists, and SHALL NOT replay historical raw `session.log` bytes to rebuild semantic scrollback. Raw TUI logs contain cursor-addressed redraws and status repaint history, so treating them as ordered conversation history can duplicate or misorder old lines after refresh. For an incremental reconnect (`fromSeq > 0`), the orchestrator SHALL first deliver a usable snapshot when needed, then replay only the `session.log` tail appended after that snapshot or after the client's acknowledged offset. Before it reads any snapshot/tail replay frames, the orchestrator SHALL wait for the per-task `session.log` append chain to flush. Live PTY bytes may be emitted to existing operators before the asynchronous append has reached disk; reconnect replay is the durable boundary and SHALL NOT return an empty tail for output that the orchestrator has already observed and sent live. The browser SHALL resize and clear the xterm before applying a fresh snapshot, write reconnect data through xterm flush callbacks, and reveal the terminal only after the replay queue has flushed and the viewport has been synced.

The orchestrator bridge (`AioPtyClient`/gateway) SHALL continue to persist raw PTY output to `workspaces/<id>/session.log` for incremental tail replay and terminal audit sources. The `SnapshotManager` SHALL be backed by a REAL xterm headless terminal whose `serialize()` returns the actual visible frame, not a `NullHeadlessTerminal` whose `serialize()` is empty. Ordered conversation history for refreshed running tasks SHALL come from the structured session-history rollout path, not from raw terminal byte replay.

#### Scenario: Fresh browser refresh restores the current visible frame
- **WHEN** an operator hard-refreshes a running task terminal with no prior acknowledged seq
- **THEN** reconnect replay sends the latest usable SerializeAddon visible-frame snapshot, or captures one immediately
- **AND** it does not replay historical raw `session.log` bytes as terminal scrollback

#### Scenario: Snapshot records its dimensions for size reconciliation
- **WHEN** a SerializeAddon snapshot is produced
- **THEN** it records the cols and rows it was captured at so a reconnecting client of a different size can reconcile the dimensions before applying it

#### Scenario: Incremental reconnect restores snapshot plus tail
- **WHEN** a client reconnects with a positive acknowledged seq
- **THEN** the orchestrator delivers the latest usable SerializeAddon snapshot when needed
- **AND** then replays only the `session.log` bytes appended after the snapshot or acknowledged offset

#### Scenario: session.log is persisted by the orchestrator, not the sandbox
- **WHEN** raw PTY output flows through the orchestrator bridge for an AIO-executed task
- **THEN** the orchestrator appends that output to `workspaces/<id>/session.log` so incremental tail replay and terminal audit sources remain durable even though no in-sandbox runner producer writes it

#### Scenario: Raw terminal history is not used as ordered conversation history
- **WHEN** a refreshed running task needs an ordered record of what the agent said and ran
- **THEN** the console uses the structured session-history rollout path
- **AND** the xterm reconnect path does not synthesize old conversation history by replaying raw TUI bytes

#### Scenario: Reconnect waits for observed output to reach session.log
- **WHEN** a task has emitted PTY output and an operator reconnects immediately afterward
- **THEN** the gateway waits for pending `session.log` appends for that task before calling `buildReconnectFrames`
- **AND** the reconnecting operator receives either a non-empty snapshot or non-empty tail replay for the already-observed output

#### Scenario: Fast reconnect does not lose prior output
- **WHEN** the original operator has already received a marker from live PTY output
- **AND** a second operator reconnects before the next periodic snapshot
- **THEN** the reconnect path still replays the marker from the flushed `session.log` tail rather than returning an empty final tail
