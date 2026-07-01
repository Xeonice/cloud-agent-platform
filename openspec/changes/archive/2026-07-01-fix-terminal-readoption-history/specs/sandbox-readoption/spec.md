## ADDED Requirements

### Requirement: Readoption attach does not record bootstrap output as task history

When CAP re-adopts a running task whose detached session is alive, the attach phase SHALL
restore the live viewer without appending attach bootstrap output to durable task
history. Bootstrap output includes shell command echo, duplicate-session messages, tmux
attach setup output, and the initial current-screen repaint emitted solely because CAP
attached a new provider terminal transport. After the attach bootstrap completes, new
agent output SHALL be recordable again.

#### Scenario: Re-adopted alive session does not duplicate launch history

- **WHEN** the API restarts and re-adopts a running task whose detached session is alive
- **THEN** CAP attaches to the existing session rather than launching a second agent
- **AND** the attach bootstrap bytes are not appended to `session.log`
- **AND** the attach bootstrap bytes are not appended to `session.cast`

#### Scenario: Later output remains recordable after readoption

- **WHEN** CAP has completed the attach bootstrap for a re-adopted running task
- **AND** the live agent later emits new terminal output
- **THEN** the new terminal output is appended to the task's durable history normally

#### Scenario: Operator still sees the re-adopted live frame

- **WHEN** an operator reconnects to a re-adopted running task during or after attach
  bootstrap
- **THEN** the operator's live terminal can still be restored to the current visible
  frame
- **AND** suppressing durable recording of bootstrap output does not make the task
  appear disconnected or blank
