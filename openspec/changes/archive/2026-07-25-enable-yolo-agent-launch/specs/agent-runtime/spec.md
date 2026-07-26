## MODIFIED Requirements

### Requirement: ClaudeCodeRuntime launch line and sandbox flags

For `executionMode = "interactive-pty"`, the resolved Claude Code runtime policy SHALL
contribute an invocation of the form
`claude --session-id <uuid> --dangerously-skip-permissions "<prompt>"`. The shared
terminal mechanism SHALL deliver the prompt through the file-backed `$(cat
<prompt-file>)` shape, place the resulting invocation in the detached tmux session
`task<taskId>`, and run it with the cloned workspace as cwd. Prompt text SHALL never be
inlined into launch syntax.

At this change's archive boundary, the interactive launch environment SHALL retain
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` as the transitional inline-terminal baseline,
plus `CLAUDE_CODE_SANDBOXED=1` and
`CLAUDE_CONFIG_DIR=/home/gem/.claude`. Provisioning SHALL additionally write
`/home/gem/.claude/settings.json` with
`permissions.skipDangerousModePermissionPrompt = true`; this setting is additive to,
and SHALL NOT replace, the identical onboarding/project-trust pre-seed written to both
`$HOME/.claude.json` and `$CLAUDE_CONFIG_DIR/.claude.json`.

The runtime SHALL NOT use `claude attach`, `claude agents`, `--bare`, or
`--no-session-persistence`. The immediately following `restore-native-live-terminal`
change MAY remove only the interactive alternate-screen override; it SHALL preserve the
bypass-permissions, onboarding, auth, model, session, exit, and transcript policy defined
here.

#### Scenario: Claude launches autonomously with no blocking prompt

- **WHEN** a `claude-code` task is launched in a freshly provisioned sandbox
- **THEN** Claude runs the prompt without a trust dialog, theme/onboarding screen,
  dangerous-mode confirmation, or tool-approval prompt
- **AND** the launch uses `--dangerously-skip-permissions` rather than `acceptEdits`
- **AND** the three pre-seed files have distinct responsibilities and are all present

#### Scenario: Transitional inline buffer remains composed until native-terminal apply

- **WHEN** this prerequisite is archived before `restore-native-live-terminal` is applied
- **THEN** the interactive Claude environment still contains
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`
- **AND** this is a temporary composition baseline, not a long-term reconnect contract

### Requirement: Execution mode is a declarative, consumer-selected runtime capability

The `AgentRuntime` port SHALL declare which execution modes it supports via
`executionModes: ReadonlySet<'interactive-pty' | 'headless-exec'>`, and SHALL provide
`buildHeadlessLine(ctx)` - a one-shot, exit-on-completion launch line - for any runtime
that supports `headless-exec`. The headless launch line SHALL be a valid invocation of
the runtime's non-interactive subcommand and MUST use that subcommand's accepted flag
surface, not interactive-only flags, so the agent runs to completion and writes its
transcript artifact.

For Codex, a new headless run SHALL use `codex exec` with
`--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, and
`< /dev/null`. It SHALL NOT pass `--ask-for-approval`, `--sandbox`, or
`--dangerously-bypass-hook-trust` to `codex exec`. A Codex headless resume SHALL repeat
the same explicit bypass, validate the prior runtime session identifier as a safe shell
token, and use `--skip-git-repo-check` without `--sandbox`. For Claude Code, a new headless run
SHALL use `claude -p` with `--output-format stream-json`, `--verbose`,
`--session-id <uuid>`, `--dangerously-skip-permissions`, and `< /dev/null`; a Claude
headless resume SHALL use `--resume <id>` with the same bypass-permissions policy.
Validated explicit per-task model material MAY add its runtime-specific `--model`
argument without weakening any required or forbidden permission flag.

The shared task path SHALL select execution mode by consumer: a console-created task
uses `interactive-pty`; a programmatic MCP/`/v1` task uses `headless-exec`. The selected
mode SHALL be persisted and read back by provisioning, exit detection, and transcript
read. A runtime MUST NOT branch on consumer identity; it declares capability and emits
the requested mode's policy while shared scaffolding owns selection and lifecycle.

#### Scenario: Console task runs interactive-pty

- **WHEN** a task is created from the console
- **THEN** its execution mode is `interactive-pty` and it uses the interactive runtime
  policy

#### Scenario: Programmatic task runs headless-exec

- **WHEN** a task is created via MCP `create_task` or `POST /v1/tasks`
- **THEN** its execution mode is `headless-exec` and it is launched through
  `buildHeadlessLine`

#### Scenario: A runtime without headless-exec rejects programmatic creation

- **WHEN** a programmatic task selects a runtime whose capabilities exclude
  `headless-exec`
- **THEN** creation fails closed with a distinct reason instead of launching an
  interactive session

#### Scenario: Codex headless uses the exec-accepted bypass surface

- **WHEN** a runtime-default Codex headless task starts
- **THEN** its command contains
  `codex exec --json --dangerously-bypass-approvals-and-sandbox`
- **AND** it contains `--skip-git-repo-check`, reads the file-backed prompt, redirects
  stdin from `/dev/null`, and writes the detached exit sentinel
- **AND** it does not contain the forbidden interactive-only flags

#### Scenario: Claude headless new and resume both bypass permissions

- **WHEN** a Claude headless task starts or resumes a previous session
- **THEN** the invocation contains `--dangerously-skip-permissions`, stream JSON, and
  verbose output
- **AND** a new run has `--session-id <uuid>` while a resume has `--resume <id>`

#### Scenario: Codex headless resume remains autonomous

- **WHEN** a Codex headless task resumes a transcript-derived session
- **THEN** its `codex exec resume` invocation contains
  `--dangerously-bypass-approvals-and-sandbox` and `--skip-git-repo-check`
- **AND** it omits `--sandbox` and rejects a session identifier containing shell syntax

#### Scenario: Explicit model composes with required permission policy

- **WHEN** validated explicit model material is present for a fresh interactive or fresh
  headless launch
- **THEN** the runtime adds its safe `--model` argument while retaining every required
  bypass flag and every forbidden-flag invariant
- **AND** a resumed headless session keeps the model recorded by that session rather
  than applying a newly selected task model
