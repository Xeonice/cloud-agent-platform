## MODIFIED Requirements

### Requirement: Snapshot plus tail-replay reconnect

On client reconnect the orchestrator SHALL restore terminal state by replaying persisted terminal bytes in a way that matches the reconnect type. For an incremental reconnect (`fromSeq > 0`), the orchestrator SHALL first deliver a periodic headless SerializeAddon snapshot when usable, then replay the `session.log` tail appended after that snapshot or after the client's acknowledged offset. For a fresh browser load (`fromSeq <= 0`), the orchestrator SHALL replay a bounded suffix of `session.log` rather than relying on a SerializeAddon snapshot alone, because a snapshot restores the visible frame but not scrollback. The browser SHALL write reconnect replay data through xterm flush callbacks and SHALL NOT reveal intermediate replay-fill frames; it SHALL reveal the terminal only after the replay queue has flushed, the viewport has been synced, and the terminal has been scrolled to the latest frame.

#### Scenario: Fresh browser refresh rebuilds scrollback from session.log

- **WHEN** an operator hard-refreshes a running task terminal with no prior acknowledged seq
- **THEN** reconnect replay uses a bounded suffix of `session.log`
- **AND** the browser xterm rebuilds useful scrollback from those bytes instead of receiving only the latest SerializeAddon visible frame

#### Scenario: Incremental reconnect keeps snapshot plus tail

- **WHEN** an operator reconnects with a positive acknowledged seq
- **THEN** the orchestrator uses the latest usable SerializeAddon snapshot followed by the `session.log` tail after the snapshot or client offset

#### Scenario: Reconnect reveal skips intermediate replay flashes

- **WHEN** reconnect replay contains a large snapshot or tail
- **THEN** the browser queues replay writes and keeps the terminal hidden until the final replay chunk has flushed
- **AND** the revealed terminal is synced and positioned at the latest frame rather than visibly flashing through older replay frames

### Requirement: The live terminal preserves a scrollable history

The live session terminal SHALL let the operator scroll up to earlier output WHILE THE TASK IS RUNNING. The live output SHALL accrue in xterm scrollback, the viewport SHALL remain synced to that buffer as output arrives, and user-initiated scrolling SHALL render the corresponding historical rows even while new output continues. Local viewport sync SHALL NOT force a user who has scrolled into history back to the bottom.

#### Scenario: Operator scrolls up through earlier output while running

- **WHEN** a RUNNING task has produced more than one screen of output and the operator scrolls up in the live terminal
- **THEN** earlier output is visible and the visible rows change according to the scroll position

#### Scenario: Live output does not snap a history reader to the bottom

- **WHEN** the operator is scrolled away from the bottom and more live output arrives
- **THEN** viewport synchronization preserves the operator's history position instead of snapping to the latest frame

#### Scenario: Infinite output remains scrollable

- **WHEN** a running task continuously emits output
- **THEN** the operator can scroll while output continues, and the terminal keeps repainting historical rows for the current viewport

### Requirement: Browser input excludes terminal-generated responses

The browser SHALL forward only operator input through the live terminal keystroke path. Terminal-generated device-attribute, cursor-position, or device-status replies emitted by xterm during replay or terminal interrogation SHALL be dropped before takeover/keystroke frames are sent. Filtering SHALL NOT drop normal printable input, cursor-key escape sequences, or bracketed paste payload markers.

#### Scenario: Device attribute replies are not sent as keystrokes

- **WHEN** xterm emits DA or secondary-DA response data such as `ESC[?1;2c` or `ESC[>0;276;0c`
- **THEN** the browser does not send takeover or keystroke frames for that data
- **AND** the response text is not echoed into the task terminal as operator input

#### Scenario: Human input is preserved

- **WHEN** the operator types text, uses cursor keys, or pastes bracketed content
- **THEN** that input is not classified as terminal-generated response data and remains eligible for the write-lease keystroke path

### Requirement: Stale sandbox terminal bridges recover on operator input

The AIO PTY bridge SHALL treat the detached tmux session as authoritative and the sandbox terminal WebSocket as a replaceable attach bridge. If operator input arrives while the current sandbox terminal WebSocket is not open, the bridge SHALL queue the input, open a replacement WebSocket, re-attach to the task's detached tmux session, and drain queued input once the replacement is ready. Events from superseded WebSockets SHALL NOT affect the active bridge.

#### Scenario: Input after bridge close reaches tmux

- **WHEN** the browser sends operator input for a running task after the API-to-sandbox terminal WebSocket has closed
- **THEN** the API queues that input, reopens the sandbox terminal WebSocket, re-attaches to the detached tmux session, and forwards the queued input

#### Scenario: Superseded socket events are ignored

- **WHEN** a replacement sandbox terminal WebSocket has become the active bridge
- **THEN** late message, close, or error events from the superseded socket do not close or corrupt the active bridge
