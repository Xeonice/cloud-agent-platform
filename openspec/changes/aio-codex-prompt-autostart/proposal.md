## Why

The operator-supplied goal (`task.prompt`) is persisted in the DB but never reaches codex: `AioPtyClient.launchCodex()` runs a hard-coded argv with NO prompt, so every task opens codex on a blank composer and the operator must re-type the goal by hand. This defeats the "create a task → it runs" promise of the console.

## What Changes

- **Thread the task prompt to the launch.** Make `task.prompt` available to the codex launch via the provisioning lookup — `PrismaProvisionLookup` already loads the task row, so it returns the prompt with NO new DB call and the provider stays a pure port consumer.
- **Inject the prompt as a shell-injection-safe FILE, not an inline argv.** At provision time write the prompt to `/home/gem/.codex/task-prompt.txt` using the SAME `printf %s '<base64>' | base64 -d > file` idiom already proven for `config.toml`/`auth.json` injection. The base64 alphabet has no shell metacharacters, so arbitrary prompt text (quotes, backticks, `$`, newlines) is provably safe and is never inlined into the launch argv.
- **Launch with the positional prompt, keeping the interactive TUI.** `codex -C /home/gem/workspace … "$(cat /home/gem/.codex/task-prompt.txt)"` PRE-FILLS the composer with the goal. Because the prompt lives in a file, the existing `-s`/`--yolo`/`bypass-approvals` launch guard inspects only the fixed flags and no longer false-positives on prompt content.
- **Auto-submit the pre-filled goal (zero-touch).** codex's positional `[PROMPT]` PRE-FILLS but does NOT auto-submit (confirmed against OpenAI docs + live capture). So cap injects a single carriage return AFTER the codex-startup DSR (`\x1b[6n`, already intercepted for CPR) is observed AND output has quiesced — a signal that guarantees codex's TUI (not the shell) is up and the composer is rendered. If the auto-submit misfires it degrades to a still-pre-filled composer the operator can submit manually — never to a lost goal.
- **Empty prompt** → codex opens a blank composer rather than failing.
- **NOT `codex exec`.** exec is non-interactive (no TUI to watch/intervene) and can hang forever on an inherited non-TTY stdin (codex#20919); interactive TUI + positional prompt is the correct mode.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `aio-sandbox-execution`: the **codex launched in-shell over the terminal channel** requirement gains prompt auto-injection + auto-submit — the launch carries `task.prompt` as codex's positional initial prompt via a shell-safe injected file, and the pre-filled goal is auto-submitted once the codex TUI is confirmed started, so the operator never re-enters the goal.

## Impact

- **Code:** `apps/api/src/terminal/aio-pty-client.ts` (`launchCodex` appends the `"$(cat …)"` positional; new DSR-gated quiescence auto-Enter; guard inspects only flags), `apps/api/src/sandbox/aio-sandbox.provider.ts` (an `injectCodexAuth` sibling step writes the base64 prompt file, fail-closed), the provisioning lookup (`PrismaProvisionLookup` returns `task.prompt`), `docker/aio-sandbox.Dockerfile` (`CODEX_LAUNCH_ARGV` single-source-of-truth note).
- **Behavior:** codex starts with the operator goal pre-filled AND auto-run; zero re-typing.
- **Specs:** `openspec/specs/aio-sandbox-execution/spec.md` (one MODIFIED delta).
- **External:** relies on codex `0.131` positional `[PROMPT]` (verified live in the pinned image). No upstream dependency.
- **Live verification (requires real ChatGPT `auth.json`):** multi-line prompt pre-fills verbatim; the auto-Enter submits it as ONE message (codex newline-handling regressions #8673/#20580); base64 round-trips byte-exact through `/v1/shell/exec` (CJK/emoji); the output-quiescence window is tuned. These are observable only past the Sign-in screen, so they cannot be closed without auth.
