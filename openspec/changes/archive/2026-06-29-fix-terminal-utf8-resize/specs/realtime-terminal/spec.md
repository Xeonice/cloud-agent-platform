## MODIFIED Requirements

### Requirement: Live-frame parity under PTY parity conditions
The terminal rendered in the browser SHALL be byte-identical to the sandbox PTY's live frame **when** the rendering terminal uses `TERM=xterm-256color` and the same column and row dimensions as the sandbox PTY. The `TerminalSession.pty` backend SHALL be `AioPtyClient` — an OUTBOUND connect-in WebSocket client into the AIO Sandbox `/v1/shell/ws` terminal or a provider transport behind the same terminal seam — rather than a dial-back `RunnerPtyProxy` wrapping an inbound runner socket. Full-screen TUI ANSI passed verbatim through provider output frames SHALL reproduce the live frame byte-faithfully, including multibyte UTF-8 text split across provider frame boundaries. Byte-identity is required only for the live frame; scrollback history is explicitly NOT required to byte-match.

#### Scenario: Live frame matches under matching size and TERM
- **WHEN** the browser terminal is configured with `TERM=xterm-256color` and identical cols and rows to the sandbox PTY
- **THEN** the live visible frame in the browser is byte-identical to the sandbox PTY's live frame

#### Scenario: AioPtyClient is the pty backend
- **WHEN** the `TerminalSession.pty` backend is inspected
- **THEN** it is an `AioPtyClient` that connects OUT into the provider terminal as a WebSocket client
- **AND** it is not a dial-back `RunnerPtyProxy` wrapping an inbound runner connection

#### Scenario: UTF-8 output survives provider frame boundaries
- **WHEN** provider terminal output splits a multibyte UTF-8 character across two transport frames
- **THEN** the browser terminal receives and renders the original character rather than replacement characters or underscores

#### Scenario: Scrollback divergence is permitted
- **WHEN** the browser terminal's scrollback buffer is compared to the sandbox PTY's historical output
- **THEN** scrollback is allowed to differ and is not subject to the byte-identity requirement

### Requirement: Terminal geometry synced to the sandbox PTY on connect
The orchestrator SHALL size the sandbox PTY, the authoritative detached tmux session, and the snapshot headless terminal to the operator's browser terminal geometry on every connect AND reconnect, so codex renders at the client's cols/rows rather than the AIO sandbox or tmux default (80×24). The browser SHALL send its current geometry once the terminal WebSocket is OPEN — NOT only from the xterm resize event, which fires at mount and races the socket open and is silently dropped when the socket is not yet OPEN. On receiving a (re)connecting client's geometry, the orchestrator SHALL resize the sandbox PTY, best-effort resize the detached tmux window, and resize the snapshot headless terminal to that geometry. This makes the "identical cols and rows" live-frame parity precondition reachable at runtime; without it the authoritative tmux session can stay at 80×24 while the browser auto-fits wider, so codex's cursor-addressed full-screen redraws and scrollback history misalign in the wider browser grid.

#### Scenario: Browser sends its geometry once the socket is open
- **WHEN** the terminal WebSocket transitions to OPEN
- **THEN** the client sends its current terminal cols/rows so the sandbox PTY and detached tmux session can be sized to the browser even when the initial xterm resize event fired before the socket was OPEN and was dropped (`sendFrame` only transmits when OPEN)

#### Scenario: Reconnect geometry resizes the sandbox PTY and detached tmux session
- **WHEN** a reconnecting operator's geometry (cols/rows) reaches the orchestrator on the reconnect frame
- **THEN** the orchestrator resizes the sandbox PTY, the detached tmux window, and the snapshot headless terminal to that geometry rather than leaving the PTY or tmux session at the sandbox default

#### Scenario: codex renders at the browser size, not the sandbox default
- **WHEN** an operator opens a task whose codex was launched at the sandbox default 80×24
- **THEN** after the operator's terminal connects, the sandbox PTY and detached tmux session are resized to the operator's cols/rows so codex re-renders at the browser width and the cursor-addressed history aligns

#### Scenario: Detached tmux resize is best-effort
- **WHEN** a browser resize arrives before the detached tmux session exists or after it has exited
- **THEN** the orchestrator does not fail the task solely because the tmux resize command could not be applied
- **AND** later connect/reconnect/resize events may apply the geometry when the session is alive
