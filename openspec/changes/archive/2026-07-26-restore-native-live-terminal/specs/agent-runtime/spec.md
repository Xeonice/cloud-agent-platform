## ADDED Requirements

### Requirement: CodexRuntime interactive launch preserves the native terminal mode

For `executionMode = "interactive-pty"`, `CodexRuntime.buildLaunchLine()` SHALL invoke
the interactive Codex CLI without `--no-alt-screen` and without any equivalent
argument, environment variable, or configuration override that forces Codex into the
normal/inline terminal buffer. Codex SHALL be allowed to select and operate its native
terminal mode, including entering and leaving the alternate screen and emitting its
native cursor, style, mouse, focus, clear, and terminal-query control sequences.

This requirement changes only the interactive terminal-mode override. Codex headless
launch, authentication, sandbox/approval policy, model selection, prompt submission,
exit detection, and transcript declaration SHALL remain unchanged.

#### Scenario: Interactive Codex starts in its default terminal mode

- **WHEN** `CodexRuntime.buildLaunchLine()` builds the launch specification for an
  `interactive-pty` task
- **THEN** the Codex argv does not contain `--no-alt-screen`
- **AND** no equivalent runtime-owned override forces the CLI into the normal buffer

#### Scenario: Codex headless execution is unaffected

- **WHEN** `CodexRuntime.buildHeadlessLine()` builds the launch specification for a
  `headless-exec` task
- **THEN** its command, flags, environment, exit handling, model policy, and transcript
  behavior are unchanged by the native interactive-terminal requirement

## MODIFIED Requirements

### Requirement: AgentRuntime port abstracts per-agent execution seams

The system SHALL define an `AgentRuntime` port that encapsulates the agent-specific
execution seams as declarative policy — `buildLaunchLine` (contributing `{ argv, env }`),
`terminalStartup`, `sandboxSetupCommands`, `preStopTrimCommands`, and `detectExit` — with
two implementations, `CodexRuntime` and `ClaudeCodeRuntime`, selected per task by the
task's `runtime` value. The port owns no I/O (see "The runtime is a policy object that
owns no I/O"). The shared execution scaffolding — the per-task provider sandbox, the
detached tmux session, the provider-neutral PTY client, bounded owner failure evidence,
the optional bounded raw-artifact writers, the liveness poller, and boot re-adoption — SHALL remain runtime-agnostic and
SHALL NOT branch on agent identity except through the port.

Against the canonical launch policy produced after the prerequisite
`enable-yolo-agent-launch` change is archived, removing the interactive Codex `--no-alt-screen`
override is this change's single intentional launch-byte delta. The composed launch
SHALL retain Codex's `--dangerously-bypass-approvals-and-sandbox` policy. Codex sandbox
credential/config setup, prompt submit, startup DSR/CPR behavior, exit detection, model
policy, headless launch, and transcript capture SHALL otherwise remain byte-for-byte
unchanged. Provider-specific fallback launch lines SHALL consume the same runtime-owned
interactive argv and SHALL NOT retain either a divergent inline-mode override or the
pre-YOLO approval/sandbox flags.

#### Scenario: Codex extraction preserves behavior outside native terminal mode

- **WHEN** a `codex` task is provisioned and launched after the native-terminal change
- **THEN** its interactive argv differs from the composed YOLO launch baseline only by
  removal of `--no-alt-screen`
- **AND** the composed argv still contains
  `--dangerously-bypass-approvals-and-sandbox`
- **AND** the `auth.json`/`config.toml` sandbox-setup writes, DSR-gated prompt submit,
  `tmux has-session` exit detection, headless command, and transcript behavior remain
  identical to before

#### Scenario: Runtime is selected from the task

- **WHEN** a task with `runtime = claude-code` is admitted
- **THEN** the orchestrator resolves the `ClaudeCodeRuntime` implementation, and a
  task with `runtime = codex` (or absent) resolves `CodexRuntime`

### Requirement: ClaudeCodeRuntime launch line and sandbox flags

`ClaudeCodeRuntime.buildLaunchLine()` SHALL launch the interactive Claude Code CLI in
a detached tmux session named `task<taskId>` with working directory the cloned
workspace, of the form `claude --session-id <uuid> --dangerously-skip-permissions "<prompt>"`,
where the prompt is delivered via the codex-style `$(cat <prompt-file>)` shape so the
prompt text is never inlined into the command (shell-injection-safe). The launch
environment SHALL set `CLAUDE_CODE_SANDBOXED=1` (so the workspace trust gate is
short-circuited) and `CLAUDE_CONFIG_DIR=/home/gem/.claude`. For an `interactive-pty`
launch it SHALL NOT set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, nor apply an
equivalent override that forces Claude Code into the normal/inline buffer; Claude Code
SHALL use its default native terminal mode.

The final launch SHALL retain the prerequisite `enable-yolo-agent-launch` policy:
provisioning SHALL write
`/home/gem/.claude/settings.json` with
`permissions.skipDangerousModePermissionPrompt = true`. The runtime SHALL NOT use
`claude attach`, `claude agents`, `--bare`, or `--no-session-persistence`. This
terminal-mode change SHALL NOT otherwise alter authentication, model,
session-persistence, transcript, or exit behavior; headless Claude SHALL retain the
same bypass-permissions policy selected by `enable-yolo-agent-launch` without gaining
an interactive alternate-screen override.

#### Scenario: Claude launches autonomously with no blocking prompt

- **WHEN** a `claude-code` task is launched in a freshly provisioned sandbox
- **THEN** Claude runs the prompt without a trust dialog, theme/onboarding screen, or
  tool-approval prompt, and executes Bash and edit tools without asking
- **AND** the launch uses `--dangerously-skip-permissions`, not `acceptEdits`, and the
  user settings skip its dangerous-mode confirmation prompt

#### Scenario: Claude interactive mode is not pinned to the normal buffer

- **WHEN** a Claude Code task is launched with `executionMode = "interactive-pty"`
- **THEN** its environment does not contain a truthy
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`
- **AND** the CLI may emit its native alternate-screen and terminal-control sequences
  without a runtime override converting it to inline rendering

#### Scenario: Claude headless execution is unaffected

- **WHEN** `ClaudeCodeRuntime.buildHeadlessLine()` builds the launch specification for
  a `headless-exec` task
- **THEN** it retains the headless `--dangerously-skip-permissions` policy and its
  existing exit, model, session, and transcript behavior
- **AND** no interactive terminal-mode environment override is added to that headless
  path

### Requirement: Codex observable outputs are byte-identical and characterization-tested

Characterization/golden tests SHALL pin Codex's deterministic runtime outputs against
the baseline composed with `enable-yolo-agent-launch` and SHALL permit exactly one
terminal-specific difference for this change: the interactive detached launch-line
string no longer contains `--no-alt-screen` while retaining
`--dangerously-bypass-approvals-and-sandbox`. The remaining pinned surfaces
SHALL stay byte-identical: the DSR→CPR injection sequence, sandbox-setup
(`auth.json`/`config.toml`/prompt) exec command strings, pre-stop trim command strings,
headless command, model arguments, and transcript declaration. The compose and real
provider E2E gates are final integration confirmation and SHALL NOT be replaced by a
golden test that merely accepts arbitrary launch-line changes.

#### Scenario: Golden tests isolate the native-terminal argv delta

- **WHEN** the runtime implementation and all duplicate provider/image fallbacks are
  updated
- **THEN** relative to the composed `enable-yolo-agent-launch` baseline, the interactive
  Codex launch expectation changes only by removing `--no-alt-screen` while retaining
  `--dangerously-bypass-approvals-and-sandbox`
- **AND** golden expectations for startup input, setup commands, trim commands,
  headless execution, model policy, and transcript behavior remain byte-for-byte
  unchanged
