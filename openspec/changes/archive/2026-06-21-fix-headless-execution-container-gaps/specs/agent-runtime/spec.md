## MODIFIED Requirements

### Requirement: Execution mode is a declarative, consumer-selected runtime capability
The `AgentRuntime` port SHALL declare which execution modes it supports via
`executionModes: ReadonlySet<'interactive-pty' | 'headless-exec'>`, and SHALL provide
`buildHeadlessLine(ctx)` — a one-shot, exit-on-completion launch line — for any runtime that
supports `headless-exec`. The headless launch line SHALL be a VALID invocation of the runtime's
NON-INTERACTIVE subcommand and MUST use that subcommand's accepted flag surface — NOT the
interactive top-level flags — so the agent actually runs to completion and writes its transcript
artifact. For codex specifically the headless line SHALL use `codex exec` with the
`exec`-accepted sandbox/approval bypass (`--dangerously-bypass-approvals-and-sandbox`), and SHALL
NOT pass the interactive top-level flags `--ask-for-approval` / `--sandbox` /
`--dangerously-bypass-hook-trust` (which `codex exec` rejects, aborting the run before any
`rollout-*.jsonl` is written). The shared task path SHALL select the execution mode by CONSUMER: a
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

#### Scenario: The codex headless line actually runs and writes a rollout
- **WHEN** a headless-exec codex task launches `buildHeadlessLine`
- **THEN** the line invokes `codex exec` with `exec`-accepted flags so codex runs to completion and writes a `rollout-*.jsonl`, and `get_transcript` returns readable turns rather than `no-rollout`

### Requirement: Headless-exec resolves a task to terminal on process exit
For a `headless-exec` task the launched agent process SHALL run non-interactively and EXIT when the
turn completes. Because the agent runs as the DETACHED tmux session's command, its exit code is NOT
recoverable from the AIO main shell once the session ends (neither `/v1/shell/wait` on the main shell
nor `echo $?` in a fresh shell observes it). The detached headless wrapper SHALL therefore CAPTURE the
agent's real exit code — writing `$?` to a per-task sentinel file immediately after the agent command,
inside the same single-quoted inner so the existing no-single-quote invariant holds — and exit
resolution SHALL read that sentinel FIRST for a headless task. The shared session-gone path SHALL then
resolve the task to a terminal status — `succeeded` on a clean (zero) exit, `failed` on a non-zero exit
— WITHOUT operator interaction, idle reclamation, or a write-lease, and SHALL NOT mis-classify a clean
headless exit as an abnormal death. Only when the sentinel is missing/unreadable SHALL it fall back to
the existing wait/echo resolution. No crossterm DSR-reply / cr-on-quiesce terminal-startup handshake
SHALL be applied to a headless-exec launch (`terminalStartup` is inert for that mode).

#### Scenario: A finished headless turn reaches terminal autonomously
- **WHEN** a headless-exec agent finishes its turn and the process exits 0
- **THEN** the task transitions to `succeeded` via the session-gone path, with no operator input

#### Scenario: A non-zero headless exit fails the task
- **WHEN** a headless-exec agent process exits non-zero
- **THEN** exit resolution reads the captured sentinel and the task transitions to `failed`

#### Scenario: A clean exit is not mis-read as abnormal
- **WHEN** a headless-exec agent exits 0 inside the detached session and `tmux has-session` then reports the session gone
- **THEN** exit resolution reads the captured sentinel exit code `0` and resolves `succeeded` — NOT `failed` via the abnormal-death watchdog
