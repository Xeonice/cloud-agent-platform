## ADDED Requirements

### Requirement: Execution mode is a declarative, consumer-selected runtime capability
The `AgentRuntime` port SHALL declare which execution modes it supports via
`executionModes: ReadonlySet<'interactive-pty' | 'headless-exec'>`, and SHALL provide
`buildHeadlessLine(ctx)` — a one-shot, exit-on-completion launch line — for any runtime that
supports `headless-exec`. The shared task path SHALL select the execution mode by CONSUMER: a
console-created task uses `interactive-pty`; a programmatic (MCP / `/v1` API) task uses
`headless-exec`. The selected mode SHALL be persisted on the task and read back by provisioning,
exit detection, and transcript read. A runtime MUST NOT branch on the consumer — it only declares
capability and emits the requested mode's launch line; the shared scaffolding reads the declared mode.

#### Scenario: Console task runs interactive-pty
- **WHEN** a task is created from the console
- **THEN** its execution mode is `interactive-pty` and it is launched via the interactive launch line

#### Scenario: Programmatic task runs headless-exec
- **WHEN** a task is created via MCP `create_task` or `POST /v1/tasks`
- **THEN** its execution mode is `headless-exec` and it is launched via `buildHeadlessLine`

#### Scenario: A runtime without headless-exec rejects programmatic creation
- **WHEN** a programmatic task selects a runtime whose `executionModes` excludes `headless-exec`
- **THEN** creation fails closed with a distinct reason rather than launching an interactive session

### Requirement: Headless-exec resolves a task to terminal on process exit
For a `headless-exec` task the launched agent process SHALL run non-interactively and EXIT when the
turn completes. The shared session-gone path SHALL then resolve the task to a terminal status —
`succeeded` on a clean (zero) exit, `failed` on a non-zero exit — WITHOUT operator interaction, idle
reclamation, or a write-lease. No crossterm DSR-reply / cr-on-quiesce terminal-startup handshake
SHALL be applied to a headless-exec launch (`terminalStartup` is inert for that mode).

#### Scenario: A finished headless turn reaches terminal autonomously
- **WHEN** a headless-exec agent finishes its turn and the process exits 0
- **THEN** the task transitions to `succeeded` via the session-gone path, with no operator input

#### Scenario: A non-zero headless exit fails the task
- **WHEN** a headless-exec agent process exits non-zero
- **THEN** the task transitions to `failed`

### Requirement: Transcript artifact location and format are declarative per-runtime capabilities
The `AgentRuntime` port SHALL declare, per runtime, the on-container transcript artifact via
`transcriptArtifact(ctx) → { dir, filenameGlob }` and a `transcriptFormat: 'codex-rollout' | 'claude-jsonl'`
tag. The port MUST NOT own the parser implementation — keeping it a dependency-light LEAF module that
never imports the sandbox parsers or `@cap/contracts`. The shared transcript read + durable-capture
mechanism (in the sandbox layer, which already owns the parsers) SHALL resolve the directory and
filename glob FROM the task's runtime and dispatch to the parser keyed by the declared
`transcriptFormat` — never hardcoding a single runtime's layout. Each parser SHALL be defensive:
unknown record types are skipped and missing fields degrade to honest omissions, mapping into the
shared `SessionTurn[]` render contract.

#### Scenario: Codex declares its rollout layout + format
- **WHEN** the mechanism resolves the artifact for a `codex` task
- **THEN** it receives `{ dir: ~/.codex/sessions, filenameGlob: rollout-*.jsonl }` + `transcriptFormat: 'codex-rollout'`, and dispatches to the codex parser

#### Scenario: Claude declares its projects-JSONL layout + format
- **WHEN** the mechanism resolves the artifact for a `claude-code` task
- **THEN** it receives `{ dir: ~/.claude/projects/<canonicalized-workspace-slug>, filenameGlob: <session-id>.jsonl }` + `transcriptFormat: 'claude-jsonl'`, and dispatches to the claude parser

#### Scenario: Parser skips unknown record types
- **WHEN** a runtime's JSONL contains record types the parser does not recognize (e.g. claude `queue-operation`/`attachment`/`last-prompt`)
- **THEN** those lines are skipped and the conversational `user`/`assistant` turns are still extracted into `SessionTurn[]`

## MODIFIED Requirements

### Requirement: ClaudeCodeRuntime turn-completion exit detection
Under the `interactive-pty` execution mode, `ClaudeCodeRuntime` SHALL be a RESIDENT
continuous-conversation session, behaviorally identical to codex: a finished turn does NOT terminate
the task. After answering, Claude idles at its interactive TUI for the next input, which the operator
supplies by typing into the live xterm (the same write-lease-gated keystroke path codex uses), driving
multi-turn conversation in the SAME session. `ClaudeCodeRuntime.detectExit()` SHALL resolve completion
from session liveness — `tmux has-session` over the exec handle (present → `running`, GONE → `done`) —
exactly like `CodexRuntime.detectExit()`. It SHALL NOT tail the transcript for `end_turn`, SHALL NOT
proactively kill the session on a finished turn, and a task is `done` ONLY when the session is gone
(operator stop, or configured idle/deadline reclamation). A session that disappears WITHOUT a
stop/idle in flight is an abnormal death (`failed`).

Under the `headless-exec` execution mode, the agent runs non-interactively (`claude -p`) and the
process EXITS on turn completion; completion is resolved by the SAME session-gone path (process exit →
session gone → terminal), with no residency, no live-xterm input, and no write-lease, consistent with
"Headless-exec resolves a task to terminal on process exit".

#### Scenario: A finished interactive turn keeps the session resident
- **WHEN** an `interactive-pty` Claude turn finishes and the process idles for the next input
- **THEN** the task remains `running`, the tmux session is NOT killed, and no exit-status resolution runs

#### Scenario: Interactive follow-up continues the same conversation
- **WHEN** the operator types a follow-up into the live xterm while an `interactive-pty` task is resident
- **THEN** Claude processes it as the next turn in the same session, with no new task created

#### Scenario: A finished headless turn exits to terminal
- **WHEN** a `headless-exec` Claude task finishes its turn
- **THEN** the `claude -p` process exits and the session-gone path resolves the task to a terminal status with no operator input
