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

### Requirement: Timing-driven terminal replay in the project's own xterm

The system SHALL replay the cast frame-by-frame on its recorded clock, in a read-only xterm (the renderer the live terminal uses), so the alternate-screen session evolution is visible over time — NOT a single continuous dump, NOT asciinema-player.

#### Scenario: Playback reconstructs the session over time

- **WHEN** an operator plays the 终端回放 tab of a finished task with an available cast
- **THEN** the front-end parses the header, sizes the terminal to its `width`/`height`, and schedules each event on its recorded `time`
- **AND** writes `o` event data and applies `r` resizes into a read-only `@cap/ui <Terminal>` (no `onData`)
- **AND** the codex TUI画面 (including alternate-screen content) is shown evolving over time with ANSI colors intact, with no keystroke input, live connection, or write-lease takeover possible

#### Scenario: Player controls

- **WHEN** the cast is playing
- **THEN** the operator can play/pause, see and drag a progress bar (current/total time), and change speed (1×/2×/4×)

#### Scenario: Seek rebuilds terminal state

- **WHEN** the operator seeks to time T
- **THEN** the terminal is cleared and all events with `time ≤ T` are fast-replayed in order, then timed playback may resume from T
- **AND** the画面 at T is correct (not a partial frame)

#### Scenario: Theme parity with the live terminal

- **WHEN** the replay terminal mounts
- **THEN** it resolves the same `--terminal-*` theme variables the live terminal uses

### Requirement: Honest empty state

The system SHALL show an honest empty face when there is no cast to replay, never a fabricated terminal frame.

#### Scenario: No cast to replay

- **WHEN** a task's `session.cast` is absent or empty
- **THEN** the 终端回放 tab renders an honest empty face

## Notes

- **Hard constraint (measured)**: codex's TUI is a full-screen alternate-screen-buffer app; a continuous dump lands on a near-empty banner (session content lives in the alt-buffer, which has no scrollback). Hence timing-driven playback is mandatory.
- **Verified format (asciicast v2)**: header `{version:2,width,height,...}` + `[time,code,data]`; `time`=cumulative seconds; `o`=output, `r`=resize `"COLSxROWS"`; `data`=valid-UTF-8 JSON string (not base64).
- **对话记录 = rollout**: the existing conversation tab already renders the structured rollout transcript; this capability does not touch it. asciicast has no structured-conversation slot.
- **Untouched**: `session.log` and the live WebSocket / PTY / write-lease path.
