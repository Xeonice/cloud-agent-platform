## ADDED Requirements

### Requirement: session.log records task output, not attach bootstrap repaint

The `session.log` history SHALL contain recordable task terminal output in emission
order, but SHALL NOT include output emitted solely by CAP attaching a new provider
terminal transport to an already-running detached session during readoption. The file
SHALL remain append-only for recordable output; excluding non-recordable attach
bootstrap bytes is not considered overwriting or mutating history.

#### Scenario: Attach bootstrap is excluded from session.log

- **WHEN** CAP reattaches to an already-running detached session during API readoption
- **AND** the provider terminal emits shell command echo, duplicate-session output, tmux
  attach setup output, or current-screen repaint bytes caused by the attach
- **THEN** those bytes are not appended to `workspaces/<id>/session.log`

#### Scenario: Real task output remains append-only

- **WHEN** the agent emits new recordable terminal output after readoption bootstrap
  completes
- **THEN** those bytes are appended to the end of `workspaces/<id>/session.log` in
  emission order
- **AND** existing `session.log` content is not rewritten
