# realtime-terminal Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Dual-channel WebSocket stream
The orchestrator SHALL stream a task's terminal over a WebSocket carrying two logically distinct channels: a raw byte stream channel reproducing the PTY output and a structured control-frame channel, where every control frame validates against a contracts schema and a raw frame is never parsed as a control frame.

#### Scenario: Raw and control frames are distinguishable
- **WHEN** the orchestrator sends terminal output and a control message over the same WebSocket
- **THEN** the raw byte stream is delivered on the raw channel and the control message is delivered as a structured frame validating against the contracts control-frame schema
- **AND** a raw byte frame is never interpreted as a control frame

### Requirement: Live-frame parity under PTY parity conditions
The terminal rendered in the browser SHALL be byte-identical to the runner PTY's live frame **when** the rendering terminal uses `TERM=xterm-256color` and the same column and row dimensions as the runner PTY. Byte-identity is required only for the live frame; scrollback history is explicitly NOT required to byte-match.

#### Scenario: Live frame matches under matching size and TERM
- **WHEN** the browser terminal is configured with `TERM=xterm-256color` and identical cols and rows to the runner PTY
- **THEN** the live visible frame in the browser is byte-identical to the runner PTY's live frame

#### Scenario: Scrollback divergence is permitted
- **WHEN** the browser terminal's scrollback buffer is compared to the runner PTY's historical output
- **THEN** scrollback is allowed to differ and is not subject to the byte-identity requirement

### Requirement: Server-side backpressure with bounded high-water mark
The orchestrator SHALL apply application-level backpressure to the raw byte stream using a server-side high-water mark not exceeding 500 000 bytes of un-acknowledged output, pausing the PTY via `pty.pause()` when the mark is reached and resuming via `pty.resume()` after the client drains below it, because xterm.js cannot keep pace with a GB/s producer.

#### Scenario: PTY is paused at the high-water mark
- **WHEN** un-acknowledged raw output buffered for a client reaches the 500 000-byte high-water mark
- **THEN** the orchestrator calls `pty.pause()` for that task so no further bytes are produced until drain

#### Scenario: PTY resumes after drain
- **WHEN** the client acknowledges enough output to bring the buffered un-acknowledged total below the low-water mark
- **THEN** the orchestrator calls `pty.resume()` and resumes streaming

### Requirement: ACK-based pause/resume control frames
Because WebSocket provides no native flow control, the control-frame channel SHALL define explicit pause and resume frames, and the client SHALL emit acknowledgement frames the server uses to advance its drained-output counter.

#### Scenario: Client acknowledgement advances the server counter
- **WHEN** the client emits an acknowledgement control frame for received bytes
- **THEN** the server reduces its count of un-acknowledged buffered bytes by the acknowledged amount

#### Scenario: Pause and resume frames are defined in contracts
- **WHEN** the control-frame schema in the contracts package is inspected
- **THEN** it defines explicit pause, resume, and acknowledgement frame variants

### Requirement: requestAnimationFrame write coalescing
The browser client SHALL coalesce incoming raw bytes and flush them to `term.write()` at most once per `requestAnimationFrame` tick rather than once per WebSocket message, to cap `term.write()` invocation frequency.

#### Scenario: Multiple messages within one frame are coalesced
- **WHEN** several raw byte messages arrive within a single animation frame
- **THEN** the client issues at most one `term.write()` call for that animation frame containing the concatenated bytes

### Requirement: Snapshot plus tail-replay reconnect
On client reconnect the orchestrator SHALL restore terminal state by first writing a periodic headless SerializeAddon snapshot that records the cols and rows it was taken at, then replaying the tail of `session.log` appended after the snapshot, reconciling any size difference between the snapshot and the current terminal.

#### Scenario: Reconnect restores from snapshot then tail
- **WHEN** a client reconnects to an active task
- **THEN** the orchestrator first delivers the most recent SerializeAddon snapshot
- **AND** then replays the `session.log` bytes appended after that snapshot was taken

#### Scenario: Snapshot records its dimensions for size reconciliation
- **WHEN** a SerializeAddon snapshot is produced
- **THEN** it records the cols and rows it was captured at so a reconnecting client of a different size can reconcile the dimensions before applying it
