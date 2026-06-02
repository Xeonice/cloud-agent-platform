# terminal-execution Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Spawn the real interactive Codex CLI under a PTY
The runner SHALL spawn the **interactive** `codex` CLI as a child process attached to a pseudo-terminal via node-pty, and SHALL NOT substitute a headless transport (`codex exec --json`, `codex app-server`, or the Agent SDK) for the terminal channel, because only the interactive path emits the TUI byte stream.

#### Scenario: Interactive codex is spawned under a PTY
- **WHEN** the runner starts a task
- **THEN** it spawns the interactive `codex` binary as a child process attached to a node-pty pseudo-terminal
- **AND** the spawn arguments do not include the headless `exec --json` or `app-server` subcommands for the terminal channel

#### Scenario: PTY environment is set for TUI rendering
- **WHEN** the runner spawns the interactive `codex` under the PTY
- **THEN** the child process environment has `TERM` set to `xterm-256color`

### Requirement: Isolated per-task workspace
The runner SHALL run each task inside its own `workspaces/<id>` directory, isolated from other tasks' workspaces, and SHALL set the spawned `codex` process working directory to that workspace.

#### Scenario: Each task gets a dedicated workspace directory
- **WHEN** two tasks with distinct ids are started
- **THEN** each task's `codex` process is launched with its working directory set to its own `workspaces/<id>` path
- **AND** the two workspace paths are different

### Requirement: session.log is the byte source of truth
The runner SHALL append every raw byte emitted by the PTY to an append-only `workspaces/<id>/session.log` file, and this file SHALL be treated as the authoritative record of the terminal output stream for replay.

#### Scenario: PTY output is appended to session.log
- **WHEN** the spawned `codex` process writes output to the PTY
- **THEN** those raw bytes are appended to `workspaces/<id>/session.log` in emission order

#### Scenario: session.log is append-only
- **WHEN** new PTY output arrives for a task that already has a `session.log`
- **THEN** the new bytes are appended to the end of the existing file rather than overwriting prior content

### Requirement: Agent-failed-to-start surfaces distinctly without hanging
When the spawned `codex` process exits or fails to reach an interactive state within a bounded startup window, the runner SHALL report a distinct agent-failed-to-start condition to the orchestrator rather than leaving the task hanging.

#### Scenario: Early process exit reports failed-to-start
- **WHEN** the spawned `codex` process exits with a non-zero status before producing its first interactive frame
- **THEN** the runner reports an agent-failed-to-start condition for the task
- **AND** the task does not remain in a running or pending state indefinitely

#### Scenario: Startup window is bounded
- **WHEN** the spawned `codex` process produces no output within the bounded startup window
- **THEN** the runner reports an agent-failed-to-start condition rather than waiting unbounded
