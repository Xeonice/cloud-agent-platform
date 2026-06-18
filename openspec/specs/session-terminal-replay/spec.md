# Session Terminal Replay Specification

## Purpose

Faithfully replay a FINISHED codex task's terminal session — as it evolved over time — in the session-replay view's 终端回放 tab, by recording the terminal to a per-task **asciicast v2** file (`session.cast`) and playing it back on its recorded clock in the project's own xterm (the renderer the live terminal already uses), with play/pause/seek/speed. Timing-driven playback is mandatory because codex's TUI is a full-screen alternate-screen-buffer app whose session content does not survive a continuous dump.
## Requirements
### Requirement: Per-task asciicast recording

The system SHALL record a task's terminal output to a per-task asciicast v2 file `session.cast`, without altering `session.log`, best-effort.

#### Scenario: Header and output events are written

- **WHEN** a task's terminal session starts and produces PTY output
- **THEN** the gateway writes an asciicast v2 header `{ "version": 2, "width": <cols>, "height": <rows>, "timestamp": <epoch s> }` once at start
- **AND** for each PTY-output chunk appends `[<cumulative seconds>, "o", <JSON-escaped UTF-8 data>]`
- **AND** the existing `session.log` append is unchanged

#### Scenario: Resize is recorded

- **WHEN** the terminal is resized during the session
- **THEN** the gateway appends `[<time s>, "r", "<cols>x<rows>"]`

#### Scenario: Output data is valid UTF-8

- **WHEN** terminal output containing multibyte UTF-8 characters is recorded
- **THEN** each `data` field is valid UTF-8 (the gateway receives already-decoded strings) and round-trips byte-for-byte through a JSON parse

#### Scenario: Recording never breaks streaming

- **WHEN** the `session.cast` write fails
- **THEN** the failure is logged and swallowed, and live streaming + the `session.log` write proceed unaffected

### Requirement: Cast read endpoint

The system SHALL expose a read endpoint returning a finished task's `session.cast`, behind the same authentication guard as `/tasks/:id`.

#### Scenario: Authenticated read of an available cast

- **WHEN** an authenticated operator requests the cast endpoint for a task whose `session.cast` exists and is non-empty
- **THEN** the response returns the cast text as `text/plain`

#### Scenario: Unauthenticated request is rejected

- **WHEN** an unauthenticated or de-allowlisted request hits the endpoint
- **THEN** it is rejected `401` before the file is read

#### Scenario: Unknown task

- **WHEN** the requested task id does not exist
- **THEN** the endpoint responds `404`, consistent with `GET /tasks/:id`

#### Scenario: No recording

- **WHEN** a task's `session.cast` is absent or empty
- **THEN** the endpoint returns an empty body (the honest "nothing to replay" signal), never a 500

### Requirement: Honest empty state

The system SHALL show an honest face when there is no cast to show OR the cast
cannot be read, never a fabricated terminal frame.

#### Scenario: No cast to show

- **WHEN** a task's `session.cast` is absent or empty
- **THEN** the 终端记录 tab renders an honest empty face

#### Scenario: Cast cannot be read

- **WHEN** the cast fetch fails (a non-404 error reading the endpoint)
- **THEN** the 终端记录 tab renders an honest error face (not a blank or fabricated
  terminal), distinct from the empty face

### Requirement: Static all-at-once terminal log

The system SHALL present a finished task's recorded terminal session as a single,
read-only, scrollable log shown in full on open — NOT a timed player — by feeding the
cast into the project's own xterm with the alternate-screen switch suppressed so the
session content lands in the normal-buffer scrollback. This replaces timing-driven
playback.

#### Scenario: The full history is shown at once

- **WHEN** an operator opens the 终端记录 tab of a finished task with an available cast
- **THEN** the front-end fetches the cast, parses the header, and processes events in
  recorded order: applying `r` resize events to the terminal and writing `o` output data
- **AND** it suppresses the alternate-screen switch (`?1049h/l`, `?1047h/l`, `?47h/l`)
  while preserving all other control sequences (scroll regions, cursor addressing,
  clears, scroll-up)
- **AND** writes into a read-only `@cap/ui <Terminal>` with a large scrollback, with no
  per-event timing delay
- **AND** the operator sees the entire recorded terminal history laid out top-to-bottom,
  scrollable via the native scrollbar, with ANSI colors intact

#### Scenario: All-at-once recovers more than the final frame

- **WHEN** the cast is an alternate-screen TUI recording (codex), whose content would
  collapse to only the final frame under a naïve continuous dump
- **THEN** suppressing the alternate-screen switch makes the scrolled-off content
  accumulate in the normal-buffer scrollback
- **AND** the reconstructed log contains materially more content than the final frame —
  the session's earlier output (reasoning, tool calls, results) is present, in order

#### Scenario: Read-only, no playback or live affordances

- **WHEN** the 终端记录 tab is shown
- **THEN** there is no play/pause, no progress bar/seek, and no speed control
- **AND** there is no keystroke input (`onData`), no live WebSocket connection, and no
  write-lease takeover

#### Scenario: Theme parity with the live terminal

- **WHEN** the log terminal mounts
- **THEN** it resolves the same `--terminal-*` theme variables the live terminal uses

## Notes

- **Hard constraint (measured)**: codex's TUI is a full-screen alternate-screen-buffer app; a continuous dump lands on a near-empty banner (session content lives in the alt-buffer, which has no scrollback). Hence timing-driven playback is mandatory.
- **Verified format (asciicast v2)**: header `{version:2,width,height,...}` + `[time,code,data]`; `time`=cumulative seconds; `o`=output, `r`=resize `"COLSxROWS"`; `data`=valid-UTF-8 JSON string (not base64).
- **对话记录 = rollout**: the existing conversation tab already renders the structured rollout transcript; this capability does not touch it. asciicast has no structured-conversation slot.
- **Untouched**: `session.log` and the live WebSocket / PTY / write-lease path.
