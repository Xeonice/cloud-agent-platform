## ADDED Requirements

### Requirement: Reconnect replay remains aligned after API readoption

When CAP re-adopts a running task after API restart, reconnect replay SHALL remain
aligned with the durable `session.log`. The snapshot manager SHALL initialize or rebase
its durable byte offset from the existing `session.log` size before recordable output is
appended. Non-recordable readoption attach bootstrap bytes SHALL NOT advance the durable
replay offset and SHALL NOT be returned as `tail_replay` history.

#### Scenario: Re-adopted snapshot offset starts at existing log size

- **WHEN** the API starts and re-adopts a running task with an existing non-empty
  `session.log`
- **THEN** reconnect bookkeeping treats the existing file size as the durable replay
  offset baseline
- **AND** later recordable output advances from that baseline rather than from zero

#### Scenario: Attach bootstrap is not replayed as historical tail

- **WHEN** a running task is re-adopted and CAP attaches to the existing detached
  session
- **AND** the attach phase emits command echo, duplicate-session output, or current-screen
  repaint bytes
- **THEN** a later browser reconnect does not receive those bytes as historical
  `tail_replay` data

#### Scenario: Reconnect still restores current frame after readoption

- **WHEN** an operator reconnects to a re-adopted running task
- **THEN** the terminal restores prior recordable history from `session.log`
- **AND** the live terminal resumes receiving new output from the still-running session
- **AND** the restored terminal does not show a duplicated attach bootstrap segment
