## ADDED Requirements

### Requirement: Detached tmux terminal sessions are UTF-8 aware
The shared terminal launch and attach path SHALL run tmux in UTF-8 mode for interactive detached sessions so multibyte terminal output is preserved even when the sandbox login environment does not expose a UTF-8 locale. This SHALL apply to fresh detached session creation and to attaching or re-attaching the provider terminal bridge to the task's named tmux session.

#### Scenario: Fresh detached session uses UTF-8 tmux mode
- **WHEN** the orchestrator builds the detached tmux launch command for an interactive task
- **THEN** the command invokes tmux in UTF-8 mode before creating the named session

#### Scenario: Re-attach uses UTF-8 tmux mode
- **WHEN** the terminal bridge attaches to an existing task tmux session
- **THEN** the attach command invokes tmux in UTF-8 mode so non-ASCII output is not rendered as underscores

### Requirement: Browser resize reaches the detached tmux window
The shared `AioPtyClient` resize path SHALL propagate browser terminal geometry to both the provider PTY transport and the task's detached tmux window. Resizing the detached tmux window SHALL use the task's named session and the browser cols/rows, and SHALL be best-effort so stale-session races do not fail the task.

#### Scenario: Resize updates provider PTY and tmux window
- **WHEN** the browser sends terminal geometry `{cols, rows}` for a running interactive task
- **THEN** the provider PTY receives the resize frame
- **AND** the detached tmux session receives a matching `resize-window` operation for the task session

#### Scenario: Resize failure does not fail the task
- **WHEN** the provider PTY resize succeeds but the detached tmux resize command cannot find the named session
- **THEN** the task remains running and the bridge continues normal liveness polling and output streaming
