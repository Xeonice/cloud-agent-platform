## MODIFIED Requirements

### Requirement: codex launched in-shell over the terminal channel

The system SHALL launch codex INSIDE the AIO shell over the `/v1/shell/ws` terminal channel (execution model A), preserving the interactive TUI, and SHALL NOT run codex via the request/response `exec`/MCP surfaces for the interactive terminal channel. The launch SHALL use Codex's documented bypass/YOLO-style mode, `--dangerously-bypass-approvals-and-sandbox`, because the platform's execution boundary is the per-task AIO Sandbox container rather than Codex's inner sandbox or approval loop.

The launch SHALL carry the task's operator-supplied prompt (`task.prompt`) as codex's positional initial-session prompt so the operator never re-enters the goal. The prompt SHALL be made available to the launch via the provisioning lookup (NOT hard-coded, NOT omitted), written into the sandbox at provision time as a FILE under `/home/gem/.codex` using the SAME base64-decode injection idiom used for `config.toml`/`auth.json` (so arbitrary prompt text - quotes, backticks, `$`, newlines - is shell-injection-safe and is NEVER inlined into the launch argv), and passed to codex as the positional `[PROMPT]` argument via a `"$(cat <promptfile>)"` shell expansion. Because codex's positional prompt PRE-FILLS the composer but does NOT auto-submit, the system SHALL auto-submit the pre-filled prompt by injecting a single carriage return EXACTLY ONCE, AFTER the codex-startup DSR (`\x1b[6n`) has been observed AND the terminal output has quiesced - a condition that guarantees codex's TUI (not the shell) is live and the composer is rendered - so zero operator keystrokes are required to begin the run. If the auto-submit misfires it SHALL degrade to a still-pre-filled composer the operator can submit manually, NEVER to a lost goal, and a prompt-file injection failure SHALL fail the provision CLOSED rather than launching goal-less. When the task prompt is empty the launch SHALL open codex with no positional prompt (a blank composer) rather than failing. The system SHALL NOT use `codex exec` for this path (it is non-interactive and can hang on inherited non-TTY stdin).

The derived sandbox image SHALL be baked FROM the pinned AIO image with codex, `~/.codex/hooks.json`, and the compiled `dist/hooks` included. The provisioned codex version SHALL be PINNED via a documented `CODEX_VERSION` build-arg to a release compatible with the account model in use (verified working: codex `0.131.0` with model `gpt-5.5`); the prior `0.42.0` pin SHALL NOT be used because it 400s on `gpt-5`/`gpt-5-codex`/`o4-mini` for ChatGPT accounts and is unusable with `gpt-5.5`. The baked `~/.codex/hooks.json` and the compiled `dist/hooks` SHALL conform to the codex `0.131` hook protocol, but the interactive bypass-mode PTY surface SHALL NOT be treated as a pre-execution approval-gated surface.

The derived image SHALL be SLIMMED: instead of COPYing the whole built `/repo` workspace (so the hooks' pnpm symlink farm resolves at runtime), the build SHALL use `pnpm deploy` (`--prod`; `--legacy` if pnpm 10 requires it) to generate a SELF-CONTAINED `node_modules` tree for `@cap/sandbox-hooks`, and the image SHALL COPY only that self-contained `node_modules` plus the compiled `dist` - dropping the full `/repo` COPY. The slimmed image SHALL still resolve the hook dependencies at runtime: `import zod` and `@cap/contracts` SHALL load without `ERR_MODULE_NOT_FOUND` and the hook SHALL still run.

#### Scenario: codex runs over the interactive terminal channel

- **WHEN** a task begins execution
- **THEN** codex is started inside the AIO shell over the `/v1/shell/ws` terminal channel
- **AND** codex is not launched through the request/response `exec` or MCP surfaces for the interactive terminal channel

#### Scenario: Interactive codex uses bypass mode

- **WHEN** a `codex` task is launched for the interactive terminal channel
- **THEN** the launch argv includes `--dangerously-bypass-approvals-and-sandbox`
- **AND** it does not use the older `--ask-for-approval never --sandbox danger-full-access` launch contract

#### Scenario: Task prompt is injected as a shell-safe file and passed positionally

- **WHEN** a task with a non-empty `task.prompt` is provisioned
- **THEN** the orchestrator writes the prompt into the sandbox at `/home/gem/.codex/task-prompt.txt` via the base64-decode injection idiom (the raw text is never inlined into the launch argv)
- **AND** codex is launched with the positional prompt supplied as `"$(cat /home/gem/.codex/task-prompt.txt)"`, pre-filling the composer with the operator goal

#### Scenario: Prompt text mentioning launch flags is not treated as argv

- **WHEN** `task.prompt` contains text such as `-s`, `--yolo`, or `bypass-approvals`
- **THEN** that text stays only in the injected prompt file and never appears in the shell command or launch argv

#### Scenario: Pre-filled prompt is auto-submitted after the TUI is confirmed started

- **WHEN** codex has been launched with a pre-filled positional prompt, the codex-startup DSR `\x1b[6n` has been observed, and terminal output has quiesced
- **THEN** the orchestrator injects a single carriage return exactly once so the pre-filled goal is submitted and the run begins with zero operator keystrokes
- **AND** the carriage return is never injected while the shell (not codex) holds the terminal, so the goal cannot be silently dropped into the shell
