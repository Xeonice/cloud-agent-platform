## MODIFIED Requirements

### Requirement: Live-frame parity under PTY parity conditions
The terminal rendered in the browser SHALL be byte-identical to the sandbox PTY's live frame **when** the rendering terminal uses `TERM=xterm-256color` and the same column and row dimensions as the sandbox PTY. The `TerminalSession.pty` backend SHALL be `AioPtyClient` — an OUTBOUND connect-in WebSocket client into the AIO Sandbox `/v1/shell/ws` terminal — rather than a dial-back `RunnerPtyProxy` wrapping an inbound runner socket. The full-screen TUI ANSI passed verbatim through AIO `output` frames SHALL reproduce the live frame byte-faithfully. Byte-identity is required only for the live frame; scrollback history is explicitly NOT required to byte-match.

#### Scenario: Live frame matches under matching size and TERM
- **WHEN** the browser terminal is configured with `TERM=xterm-256color` and identical cols and rows to the sandbox PTY
- **THEN** the live visible frame in the browser is byte-identical to the sandbox PTY's live frame

#### Scenario: AioPtyClient is the pty backend
- **WHEN** the `TerminalSession.pty` backend is inspected
- **THEN** it is an `AioPtyClient` that connects OUT into the AIO Sandbox `/v1/shell/ws` terminal as a WebSocket client
- **AND** it is not a dial-back `RunnerPtyProxy` wrapping an inbound runner connection

#### Scenario: Scrollback divergence is permitted
- **WHEN** the browser terminal's scrollback buffer is compared to the sandbox PTY's historical output
- **THEN** scrollback is allowed to differ and is not subject to the byte-identity requirement

### Requirement: Dual-channel WebSocket stream
The orchestrator SHALL stream a task's terminal over a WebSocket carrying two logically distinct channels: a raw byte stream channel reproducing the PTY output and a structured control-frame channel, where every control frame validates against a contracts schema and a raw frame is never parsed as a control frame. The front-end-facing two-channel protocol (base64 raw + control frames) SHALL be UNCHANGED by the migration; the `AioPtyClient` SHALL translate the sandbox AIO JSON frames into this same two-channel browser protocol so that everything above the `TerminalPty` seam is unaffected.

#### Scenario: Raw and control frames are distinguishable
- **WHEN** the orchestrator sends terminal output and a control message over the same WebSocket
- **THEN** the raw byte stream is delivered on the raw channel and the control message is delivered as a structured frame validating against the contracts control-frame schema
- **AND** a raw byte frame is never interpreted as a control frame

#### Scenario: Browser protocol is unchanged across the seam
- **WHEN** the front-end xterm receives terminal output and control frames after the AIO migration
- **THEN** it receives the same base64 raw + control-frame protocol as before
- **AND** the `AioPtyClient` performs the AIO-JSON-to-browser-protocol translation entirely below the `TerminalPty` seam, leaving the web ws-client unchanged
