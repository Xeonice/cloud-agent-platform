# Session Terminal Replay Specification

## Purpose

Faithfully replay a FINISHED codex task's terminal session — as it evolved over time — in the session-replay view's 终端回放 tab, by recording the terminal to a per-task **asciicast v2** file (`session.cast`) and playing it back on its recorded clock in the project's own xterm (the renderer the live terminal already uses), with play/pause/seek/speed. Timing-driven playback is mandatory because codex's TUI is a full-screen alternate-screen-buffer app whose session content does not survive a continuous dump.
## Requirements
### Requirement: Per-task asciicast recording

Complete raw `session.cast` recording SHALL be disabled by default and is explicitly
deferred from the native live-terminal release. When an operator explicitly enables
raw cast recording, CAP SHALL write only eligible task-owner output to a per-task
asciicast v2 artifact, subject to configured byte and pending-write budgets and their
code hard maxima. The writer SHALL keep every accepted line valid JSONL, SHALL remain
independent from `session.log`, bounded failure evidence, structured transcripts, and
live viewer delivery, and SHALL stop without breaking those paths if it fails or
reaches a bound.

#### Scenario: Default policy creates no cast state or file

- **WHEN** an interactive task starts, resizes, and emits output under the default
  recording policy
- **THEN** CAP creates neither a cast writer nor `session.cast`
- **AND** CAP accumulates no pending cast resize event for the task

#### Scenario: Explicit opt-in records a bounded valid cast

- **WHEN** raw cast recording is explicitly enabled and eligible owner output arrives
- **THEN** CAP writes one asciicast v2 header followed by complete output/resize JSONL
  events in accepted order
- **AND** accepted bytes and pending writes never exceed the configured bounds

#### Scenario: Cast failure does not break the terminal lifecycle

- **WHEN** an opted-in cast append fails or reaches a configured bound
- **THEN** CAP logs or marks the bounded failure and stops accepting later cast payloads
- **AND** live streaming, activity, runtime classification, exit settlement,
  `session.log`, and structured transcripts continue independently

### Requirement: Cast read endpoint

The authenticated `GET /tasks/:id/cast` route SHALL expose an explicitly enabled,
within-budget cast as `text/plain`. When raw cast recording is disabled, the endpoint
SHALL return an explicit disabled/unavailable response before opening `session.cast`.
When an enabled or legacy file exceeds the configured safe read budget, it SHALL return
an explicit payload-too-large response before reading payload bytes or allocating a
file-sized buffer. CAP SHALL use one opened file handle for stat and a bounded
positional read rather than whole-file `readFile`.

#### Scenario: Default-disabled cast is explicit

- **WHEN** an authenticated operator requests a known task's cast under the default
  policy
- **THEN** the API returns an explicit disabled/unavailable HTTP error without opening
  `session.cast`

#### Scenario: Oversized cast is rejected before payload read

- **WHEN** an enabled or legacy `session.cast` stat size exceeds the configured safe
  read budget
- **THEN** the API returns an explicit payload-too-large error
- **AND** it performs no file-handle read and allocates no file-sized buffer

#### Scenario: Enabled but missing cast keeps the compatibility empty signal

- **WHEN** raw cast is explicitly enabled for a known task but `session.cast` is absent
  or empty
- **THEN** the route returns the existing empty successful body

#### Scenario: Other file errors are unavailable, not empty

- **WHEN** an enabled cast cannot be opened, stated, or read for a reason other than
  absence
- **THEN** the route returns an explicit unavailable response
- **AND** it does not fabricate an empty successful recording

### Requirement: Honest empty state

The Web finished-session terminal surface SHALL distinguish disabled, too-large,
unavailable, enabled-but-empty, and available cast states. Disabled, too-large, and
unavailable states SHALL NOT be described as “the agent produced no output” and SHALL
NOT mount or feed an xterm. Only an enabled but absent/empty cast SHALL use the honest
empty state. Structured transcript capture and rendering SHALL remain independent and
available under their own lifecycle and retention contract.

#### Scenario: Disabled and oversized records are explained honestly

- **WHEN** the cast endpoint reports disabled or payload-too-large
- **THEN** the Web explains that full raw terminal history is not retained or is beyond
  the safe viewing bound
- **AND** it does not mount a terminal renderer for that response

#### Scenario: Enabled empty remains distinct

- **WHEN** the cast endpoint returns a successful empty body under an enabled policy
- **THEN** the Web renders the honest empty face
- **AND** it does not conflate that state with disabled or failed retrieval

### Requirement: Static all-at-once terminal log

When a bounded cast is available, the Web SHALL continue to render it as a read-only
static terminal diagnostic using the shared terminal renderer and paced writes. It
SHALL NOT claim that this optional, potentially truncated artifact is complete task
history or use it to implement live reconnect. If the artifact is unavailable under
the states above, the Web SHALL render the corresponding honest status instead of an
xterm. Structured transcripts SHALL remain the primary finished-task review surface.

#### Scenario: Available bounded artifact remains inspectable

- **WHEN** the endpoint returns a non-empty, valid, within-budget cast
- **THEN** the Web feeds complete events in order to the read-only shared terminal
  renderer with write backpressure
- **AND** it presents the surface as bounded diagnostic evidence, not guaranteed full
  session history

#### Scenario: Optional history never participates in live reconnect

- **WHEN** a running browser connects or reconnects
- **THEN** CAP obtains the initial terminal frame from a fresh provider PTY attached to
  the detached tmux session
- **AND** it does not read or replay `session.cast`

### Requirement: Headless tasks have no terminal record

A headless task (`executionMode = headless-exec`) SHALL NOT create a raw terminal cast,
even when the deployment enables cast recording for interactive tasks. The console
SHALL NOT show the terminal-record tab for a headless task. If its cast route is called,
the route SHALL report the deployment-disabled state or the enabled-but-absent
compatibility result without fabricating a JSON stream.

#### Scenario: Headless task never creates a cast

- **WHEN** a headless task runs while raw cast recording is enabled or disabled
- **THEN** CAP creates no `session.cast` for it
- **AND** its structured conversation remains the review surface

#### Scenario: Console hides the raw terminal tab for headless tasks

- **WHEN** the console views a headless task
- **THEN** the terminal-record tab is absent
- **AND** an interactive task may still show the honest raw-record status surface

### Requirement: Asciicast recording is continuous across readoption

When raw cast recording is explicitly enabled, CAP SHALL maintain at most one valid
asciicast v2 header and a monotonic append timeline across readoption, subject to the
configured byte and pending-write budgets. CAP SHALL append only complete JSONL events.
When the next complete event cannot fit while reserving a truncation marker, CAP SHALL
write at most one complete output marker and stop. The resulting cast SHALL be treated
as partial diagnostic evidence rather than complete terminal history or a byte audit.

#### Scenario: Existing bounded cast resumes without a second header

- **WHEN** an opted-in running task is re-adopted and its within-budget cast has a valid
  header
- **THEN** CAP appends later complete owner events without adding another header
- **AND** their timestamps remain monotonic relative to existing events

#### Scenario: Missing cast starts with one header

- **WHEN** an opted-in running task is adopted without an existing cast
- **THEN** CAP reserves and writes exactly one asciicast v2 header before any accepted
  event

#### Scenario: Truncation preserves valid JSONL

- **WHEN** a complete cast event would exceed the configured byte or pending-write
  budget
- **THEN** CAP writes no partial JSON value and does not rotate a headerless tail
- **AND** it writes at most one complete truncation output event and stops recording

### Requirement: Terminal record view tolerates legacy multi-header casts

The terminal record parser/rendering path SHALL detect legacy polluted cast files that
contain a mid-file asciicast header or event time regression. It SHALL NOT present a
time-reset readoption bootstrap segment as ordinary chronological history. The raw file
SHALL remain unchanged.

#### Scenario: Mid-file header is detected

- **WHEN** the terminal record view reads a `session.cast` whose first line is a valid
  header and a later line is another asciicast header
- **THEN** the later header is detected as a segment boundary or corruption marker
- **AND** events after it are not blindly merged as same-timeline history with reset
  timestamps

#### Scenario: Time regression is not rendered as normal order

- **WHEN** parsed cast events regress from a later timestamp to an earlier timestamp
- **THEN** the terminal record view prevents that regression from producing an
  out-of-order visible history

#### Scenario: Raw legacy cast is not rewritten

- **WHEN** the terminal record view handles a legacy polluted cast
- **THEN** it performs compatibility handling in memory
- **AND** it does not rewrite, truncate, or delete the original `session.cast`

## Notes

- **Hard constraint (measured)**: codex's TUI is a full-screen alternate-screen-buffer app; a continuous dump lands on a near-empty banner (session content lives in the alt-buffer, which has no scrollback). Hence timing-driven playback is mandatory.
- **Verified format (asciicast v2)**: header `{version:2,width,height,...}` + `[time,code,data]`; `time`=cumulative seconds; `o`=output, `r`=resize `"COLSxROWS"`; `data`=valid-UTF-8 JSON string (not base64).
- **对话记录 = rollout**: the existing conversation tab already renders the structured rollout transcript; this capability does not touch it. asciicast has no structured-conversation slot.
- **Untouched**: `session.log` and the live WebSocket / PTY / write-lease path.
