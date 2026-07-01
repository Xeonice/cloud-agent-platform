## ADDED Requirements

### Requirement: Asciicast recording is continuous across readoption

The system SHALL maintain a single continuous per-task asciicast recording across API
restart/readoption. A task's `session.cast` SHALL contain one asciicast v2 header. If a
running task is re-adopted and its cast file already exists, CAP SHALL resume appending
events without writing another header, and appended event times SHALL remain monotonic
relative to the existing recording.

#### Scenario: Existing cast is resumed without a second header

- **WHEN** CAP re-adopts a running interactive task whose `session.cast` already has a
  valid asciicast header
- **THEN** CAP does not append another header to that file
- **AND** future output and resize events are appended after the existing events

#### Scenario: Resumed cast event times are monotonic

- **WHEN** a resumed cast has a last valid event time
- **THEN** newly appended event times are greater than or equal to that prior time
- **AND** the recording does not reset event time to zero after readoption

#### Scenario: Missing cast still starts normally

- **WHEN** an interactive task has no existing `session.cast` or the file is empty
- **THEN** CAP writes exactly one asciicast v2 header before recording output events

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
