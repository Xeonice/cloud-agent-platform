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

For each running interactive task, the system SHALL maintain exactly one task-scoped
owner as the lifecycle, activity, bounded failure-evidence, and runtime-classification
source. Owner output eligibility SHALL distinguish real agent output from
attach-bootstrap and resize-repaint bytes. Every eligible owner chunk SHALL update a
per-task rolling failure-evidence buffer with a configurable byte limit and code hard
maximum, SHALL remain eligible for runtime failure classification, and SHALL record
activity regardless of whether any raw terminal artifact is enabled.

When an operator explicitly enables `session.log`, the file SHALL be a byte-ordered,
append-only, bounded diagnostic artifact for eligible owner output. It SHALL NOT be
required for live reconnect, runtime classification, exit mapping, or structured
transcript capture, and it SHALL NOT be described as complete history after it reaches
its configured bound. With the default policy, CAP SHALL create no `session.log`
writer or file.

The full raw `session.log` and `session.cast` writers SHALL be separate policies from
owner eligibility and from each other. Both SHALL be disabled by default and SHALL
require an explicit valid deployment opt-in. Setting producer metadata
`recordable=false` SHALL continue to exclude bootstrap/repaint bytes; CAP SHALL NOT use
that metadata or the artifact policy to disable classification of eligible agent
output. Viewer output SHALL enter neither bounded evidence nor an opt-in artifact.

The Guardrails failure-detail seam MAY retain its compatibility name
`readSessionLogTail`, but with raw logging disabled it SHALL return the sanitized,
bounded owner evidence and SHALL NOT require or create a full `session.log`.

#### Scenario: Default raw-off still classifies a runtime auth failure

- **WHEN** both raw artifact policies are at their default disabled value
- **AND** eligible owner output contains a selected-runtime authentication failure
- **THEN** CAP records activity and invokes runtime failure classification exactly as it
  would with raw artifacts enabled
- **AND** it does not create a `session.log` or `session.cast` writer/file

#### Scenario: Bootstrap repaint remains ineligible without becoming a global gate

- **WHEN** owner attach bootstrap emits output marked `recordable=false`
- **THEN** that output enters neither bounded failure evidence nor either raw artifact
- **AND** a later eligible agent chunk is still classified even while raw recording is
  disabled

#### Scenario: Exit mapping remains independent from terminal artifacts

- **WHEN** the owner reports a zero, non-zero, unresolved, or abnormal exit while raw
  recording is disabled
- **THEN** the existing success/failure exit mapping and activity lifecycle remain
  unchanged
- **AND** a non-zero failure may enrich its reason from bounded owner evidence

#### Scenario: Viewer redraw never contaminates owner evidence

- **WHEN** one or more fresh viewers receive attach bootstrap, current-screen redraw,
  resize repaint, terminal query, or duplicate live bytes
- **THEN** those viewer bytes remain presentation-only
- **AND** they do not advance bounded owner evidence or either opt-in artifact

### Requirement: Agent-failed-to-start surfaces distinctly without hanging
When the spawned `codex` process exits or fails to reach an interactive state within a bounded startup window, the runner SHALL report a distinct agent-failed-to-start condition to the orchestrator rather than leaving the task hanging.

#### Scenario: Early process exit reports failed-to-start
- **WHEN** the spawned `codex` process exits with a non-zero status before producing its first interactive frame
- **THEN** the runner reports an agent-failed-to-start condition for the task
- **AND** the task does not remain in a running or pending state indefinitely

#### Scenario: Startup window is bounded
- **WHEN** the spawned `codex` process produces no output within the bounded startup window
- **THEN** the runner reports an agent-failed-to-start condition rather than waiting unbounded

### Requirement: session.log records task output, not attach bootstrap repaint

When `session.log` is explicitly enabled, CAP SHALL append only eligible task-owner
output in emission order and SHALL NOT append output emitted solely by attaching or
resizing a provider terminal. Excluding ineligible bootstrap/repaint bytes and stopping
at the configured capacity bound SHALL NOT rewrite existing artifact bytes. These
eligibility rules SHALL continue to feed bounded owner evidence and classification even
when the raw log writer itself is disabled.

#### Scenario: Attach bootstrap remains excluded from an opted-in log

- **WHEN** CAP attaches to an already-running detached session and the provider emits
  command echo, duplicate-session output, setup output, or current-screen repaint
- **THEN** those bytes are not appended to `session.log`
- **AND** later eligible task-owner output remains independently classifiable

#### Scenario: Enabled log remains append-only within its bound

- **WHEN** eligible owner output arrives while `session.log` is enabled and has
  remaining capacity
- **THEN** CAP appends it after existing accepted bytes in emission order
- **AND** CAP does not rewrite existing artifact content

### Requirement: Opt-in raw terminal writers are hard bounded before enqueue

If an operator explicitly enables `session.log` or `session.cast`, each writer SHALL
enforce its configured total UTF-8 byte budget and a configured maximum count of
pending writes, both subject to code hard maxima. Budget reservation SHALL occur
synchronously before the writer captures a payload in its serialized promise chain.
Once accepting another payload would exceed either budget, the writer SHALL stop,
append at most one bounded human-readable truncation marker when space remains, and
SHALL enqueue no later payload. The cast writer SHALL keep every written line valid
asciicast JSONL and SHALL never write a partial event.

`session.log` and `session.cast` SHALL have independent enabled states, byte counters,
append chains, and failures. A cast-disabled task SHALL not accumulate pending cast
resize events. Live viewer rendering, runtime classification, activity, and exit
settlement SHALL not wait for or fail because of an opt-in writer.

#### Scenario: Disabled policies allocate no artifact state

- **WHEN** an interactive task starts under the default recording policy and later
  resizes or emits sustained owner output
- **THEN** CAP creates no log/cast append state and no raw files
- **AND** the cast pending-resize map does not grow for that task

#### Scenario: Byte budget stops a large chunk before unbounded capture

- **WHEN** an enabled raw writer receives a chunk that would cross its configured byte
  budget
- **THEN** it reserves and writes only a bounded truncation marker when possible,
  marks the artifact truncated, and captures no later chunk closure
- **AND** the resulting file size does not exceed the configured budget

#### Scenario: Pending-write budget bounds a slow filesystem backlog

- **WHEN** small owner chunks arrive faster than an enabled raw writer can flush them
- **THEN** synchronous pending-write accounting stops the writer at its configured
  limit without growing the promise chain further
- **AND** activity, classification, and the live terminal continue independently

#### Scenario: Raw log and cast can be enabled separately

- **WHEN** a deployment explicitly enables `session.log` but leaves `session.cast`
  disabled, or vice versa
- **THEN** only the selected artifact creates state and receives eligible owner output
- **AND** failure or truncation of that artifact does not activate or affect the other

#### Scenario: Live reconnect never consumes an opt-in artifact

- **WHEN** a browser first connects or reconnects while either raw artifact is enabled
- **THEN** the initial live frame still comes only from a fresh provider PTY attaching
  to the existing detached tmux session
- **AND** neither artifact is read for snapshot, tail replay, scrollback restoration,
  or sequence recovery
