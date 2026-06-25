## MODIFIED Requirements

### Requirement: ClaudeCodeRuntime launch line and sandbox flags

`ClaudeCodeRuntime.buildLaunchLine()` SHALL launch the interactive Claude Code CLI in a detached tmux session named `task<taskId>` with working directory the cloned workspace, of the form `claude --session-id <uuid> --dangerously-skip-permissions "<prompt>"`, where the prompt is delivered via the codex-style `$(cat <prompt-file>)` shape so the prompt text is never inlined into the command (shell-injection-safe). The launch environment SHALL set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (so the TUI renders inline in the normal buffer for capture), `CLAUDE_CODE_SANDBOXED=1` (so the workspace trust gate is short-circuited), and `CLAUDE_CONFIG_DIR=/home/gem/.claude`. Provisioning SHALL also write user settings at `/home/gem/.claude/settings.json` with `permissions.skipDangerousModePermissionPrompt = true`, so Claude Code's documented bypass mode does not block on the dangerous-mode confirmation prompt. The runtime SHALL NOT use `claude attach`, `claude agents`, `--bare`, or `--no-session-persistence` (each breaks the inline-buffer, auth, or transcript assumptions).

#### Scenario: Claude launches autonomously with no blocking prompt

- **WHEN** a `claude-code` task is launched in a freshly provisioned sandbox
- **THEN** Claude runs the prompt without a trust dialog, theme/onboarding screen, or tool-approval prompt
- **AND** the launch uses Claude Code's documented bypass-permissions mode rather than `acceptEdits`
- **AND** the sandbox user settings skip the dangerous-mode confirmation prompt for that bypass mode

#### Scenario: Inline buffer is pinned for replay

- **WHEN** the Claude TUI byte stream is captured
- **THEN** it contains no alternate-screen enter sequence (`ESC[?1049h`) and replays through the existing asciicast pipeline with no buffer-mode branching

### Requirement: Headless-exec execution mode

For `executionMode = "headless-exec"`, the selected runtime SHALL launch a non-interactive one-shot agent instead of an interactive PTY. A headless run SHALL still use the selected runtime's credential/config setup, prompt-file injection, detached tmux wrapper, transcript artifact declaration, and exit-status resolution. The detached wrapper SHALL record the agent process's real exit code in a per-task sentinel file before the tmux session exits, and task success/failure SHALL be resolved from that sentinel when available.

Codex headless launch SHALL use `codex exec --json` with the documented `exec`-accepted sandbox/approval bypass (`--dangerously-bypass-approvals-and-sandbox`), and SHALL include `--skip-git-repo-check` plus `< /dev/null` to avoid inherited-stdin hangs. Claude Code headless launch SHALL use `claude -p` with `--output-format stream-json`, `--verbose`, `--session-id <uuid>` (or `--resume <id>` for resume), `--dangerously-skip-permissions`, and `< /dev/null`.

#### Scenario: Codex headless exits without stdin hang

- **WHEN** a `codex` task runs in `headless-exec`
- **THEN** the launch line uses `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$P" < /dev/null`
- **AND** the detached wrapper writes the agent exit code to the per-task sentinel

#### Scenario: Claude headless streams JSON and bypasses permissions

- **WHEN** a `claude-code` task runs in `headless-exec`
- **THEN** the launch line uses `claude -p "$P" --output-format stream-json --verbose --dangerously-skip-permissions`
- **AND** it includes the task `--session-id` so the transcript artifact can be retained
