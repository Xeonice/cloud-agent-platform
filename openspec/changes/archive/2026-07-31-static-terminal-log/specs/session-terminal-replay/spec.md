## REMOVED Requirements

### Requirement: Timing-driven terminal replay in the project's own xterm

**Reason**: Operators want to read the whole terminal history at once, not watch it
evolve. Replaced by a static all-at-once scrollable log (below), which is achievable
without timing playback by running the cast in xterm's normal-buffer scrollback.

**Migration**: The 终端回放 tab is renamed 终端记录 and now renders the static log
instead of the frame-by-frame player; the cast format and `GET /tasks/:id/cast`
endpoint are unchanged, so existing recordings render under the new view with no data
migration.

## ADDED Requirements

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

## MODIFIED Requirements

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
