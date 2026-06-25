## MODIFIED Requirements

### Requirement: Snapshot plus tail-replay reconnect
On reconnect, the orchestrator SHALL wait for the per-task `session.log` append chain to flush before it reads snapshot/tail replay frames. Live PTY bytes may be emitted to existing operators before the asynchronous append has reached disk; reconnect replay is the durable boundary and SHALL NOT return an empty tail for output that the orchestrator has already observed and sent live.

#### Scenario: Reconnect waits for observed output to reach session.log
- **WHEN** a task has emitted PTY output and an operator reconnects immediately afterward
- **THEN** the gateway waits for pending `session.log` appends for that task before calling `buildReconnectFrames`
- **AND** the reconnecting operator receives either a non-empty snapshot or non-empty tail replay for the already-observed output

#### Scenario: Fast reconnect does not lose prior output
- **WHEN** the original operator has already received a marker from live PTY output
- **AND** a second operator reconnects before the next periodic snapshot
- **THEN** the reconnect path still replays the marker from the flushed `session.log` tail rather than returning an empty final tail
