## MODIFIED Requirements

### Requirement: codex launched in-shell over the terminal channel
The system SHALL launch codex INSIDE the AIO shell over the `/v1/shell/ws` terminal channel (execution model A), preserving the interactive TUI, and SHALL NOT run codex via the request/response `exec`/MCP surfaces for the interactive terminal channel. The launch SHALL carry the task's operator-supplied prompt (`task.prompt`) as codex's positional initial-session prompt so the operator never re-enters the goal. The prompt SHALL be made available to the launch via the provisioning lookup (NOT hard-coded, NOT omitted), written into the sandbox at provision time as a FILE under `/home/gem/.codex` using the SAME base64-decode injection idiom used for `config.toml`/`auth.json` (so arbitrary prompt text — quotes, backticks, `$`, newlines — is shell-injection-safe and is NEVER inlined into the launch argv), and passed to codex as the positional `[PROMPT]` argument via a `"$(cat <promptfile>)"` shell expansion. The launch-argv guard that refuses hook-disabling flags (`-s`/`--yolo`/`bypass-approvals`) SHALL inspect ONLY the fixed launch flags, NOT the operator prompt text, so a prompt mentioning those tokens is not falsely rejected. Because codex's positional prompt PRE-FILLS the composer but does NOT auto-submit, the system SHALL auto-submit the pre-filled prompt by injecting a single carriage return EXACTLY ONCE, AFTER the codex-startup DSR (`\x1b[6n`) has been observed AND the terminal output has quiesced — a condition that guarantees codex's TUI (not the shell) is live and the composer is rendered — so zero operator keystrokes are required to begin the run. If the auto-submit misfires it SHALL degrade to a still-pre-filled composer the operator can submit manually, NEVER to a lost goal, and a prompt-file injection failure SHALL fail the provision CLOSED rather than launching goal-less. When the task prompt is empty the launch SHALL open codex with no positional prompt (a blank composer) rather than failing. The system SHALL NOT use `codex exec` for this path (it is non-interactive and can hang on inherited non-TTY stdin). The derived sandbox image SHALL be baked FROM the pinned AIO image with codex, `~/.codex/hooks.json`, and the compiled `dist/hooks` included. The provisioned codex version SHALL be PINNED via a documented `CODEX_VERSION` build-arg to a release compatible with the account model in use (verified working: codex `0.131.0` with model `gpt-5.5`); the prior `0.42.0` pin SHALL NOT be used because it 400s on `gpt-5`/`gpt-5-codex`/`o4-mini` for ChatGPT accounts and is unusable with `gpt-5.5`. The baked `~/.codex/hooks.json` and the compiled `dist/hooks` SHALL conform to the codex `0.131` hook protocol.

#### Scenario: codex runs over the interactive terminal channel
- **WHEN** a task begins execution
- **THEN** codex is started inside the AIO shell over the `/v1/shell/ws` terminal channel
- **AND** codex is not launched through the request/response `exec` or MCP surfaces for the interactive terminal channel

#### Scenario: Derived image bakes a compatible pinned codex and 0.131-format hooks
- **WHEN** the derived sandbox image is inspected
- **THEN** it is built FROM the pinned AIO image and includes codex, `~/.codex/hooks.json`, and the compiled `dist/hooks`
- **AND** the codex version is set from a documented `CODEX_VERSION` build-arg pinned to a release compatible with the account model (e.g. `0.131.0` for `gpt-5.5`), not `0.42.0`
- **AND** the baked `~/.codex/hooks.json` is in the codex `0.131` hook format

#### Scenario: Task prompt is injected as a shell-safe file and passed positionally
- **WHEN** a task with a non-empty `task.prompt` is provisioned
- **THEN** the orchestrator writes the prompt into the sandbox at `/home/gem/.codex/task-prompt.txt` via the base64-decode injection idiom (the raw text is never inlined into the launch argv)
- **AND** codex is launched with the positional prompt supplied as `"$(cat /home/gem/.codex/task-prompt.txt)"`, pre-filling the composer with the operator goal

#### Scenario: Pre-filled prompt is auto-submitted after the TUI is confirmed started
- **WHEN** codex has been launched with a pre-filled positional prompt, the codex-startup DSR `\x1b[6n` has been observed, and terminal output has quiesced
- **THEN** the orchestrator injects a single carriage return exactly once so the pre-filled goal is submitted and the run begins with zero operator keystrokes
- **AND** the carriage return is never injected while the shell (not codex) holds the terminal, so the goal cannot be silently dropped into the shell

#### Scenario: A prompt mentioning hook-disabling tokens is not rejected
- **WHEN** `task.prompt` contains text such as `-s`, `--yolo`, or `bypass-approvals`
- **THEN** the hook-disabling launch guard inspects only the fixed launch flags and launches codex normally, because the prompt is supplied via the injected file rather than inlined into the argv

#### Scenario: Empty prompt opens a blank composer
- **WHEN** a task has an empty `task.prompt`
- **THEN** codex is launched with no positional prompt and opens a blank composer rather than failing the launch

#### Scenario: Prompt-file injection failure fails the provision closed
- **WHEN** writing the prompt file into the sandbox returns a non-zero exit
- **THEN** the provision fails closed rather than launching codex without the operator goal
