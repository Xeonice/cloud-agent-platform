## MODIFIED Requirements

### Requirement: Static all-at-once terminal log

The system SHALL present a finished task's recorded terminal session as a single, read-only, scrollable
log shown in full on open — NOT a timed player — by feeding the cast into the project's own xterm with
the alternate-screen switch suppressed so the session content lands in the normal-buffer scrollback.
The replay SHALL use FLOW CONTROL (write backpressure) so that NO data is silently discarded regardless
of cast size: the cast SHALL be written to xterm in bounded chunks paced by xterm's write-flush
callback (a high/low watermark), never letting xterm's write buffer approach its hard discard limit.
The tab SHALL show a loading state until the replay is fully fed, revealing the complete scrollable log
only on the final flush. An excessively large cast MAY be capped to its most-recent portion with a
clear truncation notice. This replaces timing-driven playback.

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

#### Scenario: Large cast replays losslessly via flow control

- **WHEN** the cast is large (a long session whose post-strip output is multiple MB, up to the legacy hundred-MB alt-screen recordings)
- **THEN** the front-end writes it to xterm in bounded chunks paced by the write-flush callback (high/low watermark backpressure), so xterm never reaches its write-buffer discard limit (no "write data discarded, use flow control" error)
- **AND** the rendered log contains the full recorded output (or the capped most-recent portion, see below) with no silently dropped data

#### Scenario: Loading state until the replay is complete

- **WHEN** the 终端记录 tab is opening and the cast is still being fed to xterm
- **THEN** a loading affordance is shown rather than a partially-filled terminal
- **AND** only once the entire cast has been flushed does the complete log appear, scrolled to the top — never an intermediate "one screen now, more fills in later" state

#### Scenario: Oversized cast is capped with a notice

- **WHEN** a cast exceeds the replay size cap (a pathologically large recording, typically a legacy alt-screen dump)
- **THEN** replay shows only the most-recent portion within the cap
- **AND** a clear notice indicates earlier output was omitted because the record is too large

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
