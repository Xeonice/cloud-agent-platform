# realtime-terminal Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
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
On client reconnect the orchestrator SHALL restore terminal state by first writing a periodic headless SerializeAddon snapshot that records the cols and rows it was taken at, then replaying the tail of `session.log` appended after the snapshot, reconciling any size difference between the snapshot and the current terminal. This SHALL hold under the connect-in AIO execution model: the orchestrator bridge (`AioPtyClient`/gateway) SHALL persist the raw PTY output to `workspaces/<id>/session.log` (there is no in-sandbox runner producer), and the `SnapshotManager` SHALL be backed by a REAL xterm headless terminal whose `serialize()` returns the actual visible frame — NOT a `NullHeadlessTerminal` whose `serialize()` is empty — so that a periodic snapshot is non-empty and `buildReconnectFrames` replays prior output to a reconnecting operator.

This reconnect replay SHALL be VERIFIED END-TO-END on a live compose stack (not merely unit-tested), as a fossilized black-box regression scenario in the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`): after a task running under the connect-in AIO model has produced terminal output, a reconnecting operator SHALL be observed to replay that prior output from the REAL `@xterm/headless` `SerializeAddon` snapshot followed by the tail of the persisted `workspaces/<id>/session.log`, and the suite SHALL assert the replayed frames are non-empty rather than nothing.

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

#### Scenario: Reconnect replay is verified end-to-end on a live compose stack
- **WHEN** the compose e2e suite (`apps/api/test/aio-e2e.mjs` + `scripts/aio-e2e.sh`) runs a task under the connect-in AIO model on a live stack, lets it produce terminal output, and reconnects an operator
- **THEN** the reconnecting operator replays the prior output sourced from the real `@xterm/headless` `SerializeAddon` snapshot plus the tail of `workspaces/<id>/session.log`
- **AND** the suite asserts the replayed reconnect frames are non-empty rather than nothing

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

### Requirement: A ready xterm always replaces the read-only fallback

The live session terminal SHALL render the real xterm whenever xterm successfully initializes —
including on WIDE viewports where initialization is slower. The readiness watchdog SHALL NOT
permanently strand the terminal on the read-only fallback when xterm is merely slow: a late `onReady`
(arriving AFTER the watchdog fired) SHALL recover the live terminal (clear the failed state) so the
ready xterm replaces the fallback. The fallback SHALL be shown ONLY for a GENUINE xterm failure (e.g.
the dynamic import threw / the canvas never mounts within a tolerant budget), not for slow
initialization.

#### Scenario: Slow (wide-viewport) xterm init still renders the real terminal

- **WHEN** the terminal page loads on a wide viewport and xterm takes longer than the readiness budget to initialize, then finishes
- **THEN** the real xterm replaces the fallback (the terminal is NOT permanently stuck on the read-only text view) and typing works

#### Scenario: A late onReady recovers from a fired watchdog

- **WHEN** the readiness watchdog has already flipped the failed state and xterm then becomes ready (a late `onReady`)
- **THEN** the failed state is cleared and the real xterm replaces the fallback

#### Scenario: Fallback only for a genuine failure

- **WHEN** xterm genuinely fails to initialize (the dynamic import throws / the canvas never mounts within the tolerant budget)
- **THEN** the read-only fallback is shown (the honest degraded state)

#### Scenario: Wide viewport renders the real terminal across reloads

- **WHEN** the operator reloads the terminal page repeatedly on a wide (≈1728px) viewport
- **THEN** each reload renders the real xterm (not 「降级为文本视图」) and accepts keyboard input

### Requirement: The live terminal preserves a scrollable history

The live session terminal SHALL let the operator scroll up to earlier output WHILE THE TASK IS
RUNNING. The agent (codex) SHALL run inline (`--no-alt-screen`, normal buffer) AND, because codex runs
inside a detached tmux session, the tmux attached client SHALL also render the pane in the NORMAL
buffer (NOT the alternate screen) — otherwise tmux's alternate screen overrides codex's inline mode and
the live xterm enters its alternate buffer (no scrollback). The live stream's output SHALL accrue in
the xterm scrollback, and the viewport SHALL be synced to that buffer so the accumulated history is
ACTUALLY scrollable (the `.xterm-viewport` height reflects the buffer, not a single screen), updating
as live output arrives.

#### Scenario: Operator scrolls up through earlier output while running

- **WHEN** a RUNNING task's codex has produced more than one screen of output and the operator scrolls up in the live terminal
- **THEN** earlier output is visible — the live xterm accumulated scrollback (it is not pinned to the current screen), and scrolling reaches the top of the history

#### Scenario: codex launches in inline (non-alt-screen) mode

- **WHEN** a task launches codex
- **THEN** the codex launch argv includes `--no-alt-screen` so codex itself does not switch to the alternate screen

#### Scenario: tmux does not pin the pane to the alternate screen

- **WHEN** codex runs inside the detached tmux session and the pty client attaches
- **THEN** the PTY stream reaching the browser is normal-buffer (tmux is not rendering the pane in the alternate screen), so the live xterm accumulates scrollback rather than entering its non-scrollable alternate buffer

#### Scenario: The live viewport reflects accumulated scrollback

- **WHEN** the live buffer has accumulated more than one screen of scrollback
- **THEN** the `.xterm-viewport` is synced so it is scrollable (its scrollHeight reflects the full buffer), updating as new live output arrives — the operator never sees a buffer that has scrollback but a viewport stuck at one non-scrollable screen

