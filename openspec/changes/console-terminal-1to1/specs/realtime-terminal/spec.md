## ADDED Requirements

### Requirement: Terminal geometry synced to the sandbox PTY on connect
The orchestrator SHALL size the sandbox PTY (and the snapshot headless terminal) to the operator's browser terminal geometry on every connect AND reconnect, so codex renders at the client's cols/rows rather than the AIO sandbox default (80×24). The browser SHALL send its current geometry once the terminal WebSocket is OPEN — NOT only from the xterm resize event, which fires at mount and races the socket open and is silently dropped when the socket is not yet OPEN. On receiving a (re)connecting client's geometry, the orchestrator SHALL resize the sandbox PTY and the snapshot headless terminal to that geometry. This makes the "identical cols and rows" live-frame parity precondition reachable at runtime; without it the sandbox PTY stays at the default 80×24 while the browser auto-fits wider, so codex's cursor-addressed full-screen redraws and scrollback history misalign in the wider browser grid.

#### Scenario: Browser sends its geometry once the socket is open
- **WHEN** the terminal WebSocket transitions to OPEN
- **THEN** the client sends its current terminal cols/rows so the sandbox PTY is sized to the browser even when the initial xterm resize event fired before the socket was OPEN and was dropped (`sendFrame` only transmits when OPEN)

#### Scenario: Reconnect geometry resizes the sandbox PTY
- **WHEN** a reconnecting operator's geometry (cols/rows) reaches the orchestrator on the reconnect frame
- **THEN** the orchestrator resizes the sandbox PTY and the snapshot headless terminal to that geometry rather than leaving the PTY at the sandbox default

#### Scenario: codex renders at the browser size, not the sandbox default
- **WHEN** an operator opens a task whose codex was launched at the sandbox default 80×24
- **THEN** after the operator's terminal connects, the sandbox PTY is resized to the operator's cols/rows so codex re-renders at the browser width and the cursor-addressed history aligns
