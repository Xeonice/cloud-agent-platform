<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: provider-prompt-injection (depends: none)

- [x] 1.1 Extend the provisioning lookup so the prompt is available without a new DB call: have `PrismaProvisionLookup` (the seam that already loads the task row for the clone spec) also return `task.prompt`; expose it on the `ProvisionLookup` port and thread it to `AioSandboxProvider.provision` (extend `ProvisionContext` with an optional `prompt?: string`, or return it from the lookup the provider already calls). — Added `getTaskPrompt(taskId)` to the `ProvisionLookup` port + `PrismaProvisionLookup` (DB access stays in the lookup; provider remains a pure port consumer).
- [x] 1.2 In `AioSandboxProvider`, add an `injectCodexAuth` sibling step (runs AFTER readiness, alongside auth/config injection) that base64-encodes the prompt in Node (`Buffer.from(prompt,'utf8').toString('base64')`) and writes it via `printf %s '<b64>' | base64 -d > /home/gem/.codex/task-prompt.txt && chmod 600 …`. — Added `injectTaskPrompt()` called right after `injectCodexAuth`; path shared via `CODEX_PROMPT_FILE_PATH`. (Refinement: writes only when the prompt is non-empty; an empty prompt writes no file → the bridge's `cat 2>/dev/null` degrades to a blank composer, behaviourally identical.)
- [x] 1.3 Fail the provision CLOSED on a non-zero `/v1/shell/exec` exit for the prompt-file write (mirror the existing auth/config injection assertions) — never silently continue to a goal-less launch.
- [x] 1.4 Update `docker/aio-sandbox.Dockerfile` `CODEX_LAUNCH_ARGV` documentation (single source of truth) to note the positional `"$(cat /home/gem/.codex/task-prompt.txt)"` suffix is appended by the bridge at launch.

## 2. Track: bridge-launch-and-autosubmit (depends: provider-prompt-injection)

- [x] 2.1 In `AioPtyClient.launchCodex`, append the positional prompt as a shell expansion: the launched command becomes `<base-argv> "$(cat /home/gem/.codex/task-prompt.txt)"`. Keep the shell launch line terminated by `\n`. — Implemented via `buildCodexLaunchLine` (a `P="$(cat … 2>/dev/null)"; if [ -n "$P" ]; then <argv> "$P"; else <argv>; fi` shell line).
- [x] 2.2 Ensure the hook-disabling guard regex inspects ONLY the fixed base argv (flags), NOT the positional prompt expansion. — Extracted `argvDisablesHooks(argv)`; guard runs on the base argv only (prompt rides the file, never the argv).
- [x] 2.3 Handle the empty-prompt path: when no prompt was injected, launch without the positional suffix (blank composer) rather than failing. — The `[ -n "$P" ]` else-branch launches the bare base argv.
- [x] 2.4 Implement the DSR-gated quiescence auto-submit: track that the codex-startup DSR (`\x1b[6n`) has been observed, then after `output` frames quiesce for a tuned window, inject a single `\r` exactly once. Best-effort; gated behind `autoLaunchCodex`; timer cleared on WS close.
- [x] 2.5 Update the `DEFAULT_CODEX_LAUNCH_ARGV` doc comment in `aio-pty-client.ts` to reflect the appended positional prompt + the auto-submit behavior, keeping it consistent with the Dockerfile note.

## 3. Track: tests (depends: bridge-launch-and-autosubmit)

- [x] 3.1 Unit-cover the provider prompt-file injection: asserts the `printf … | base64 -d > task-prompt.txt` command shape and fail-closed on non-zero exit (mirror existing `injectCodexAuth` test style). — Added to `aio-sandbox.provider.test.mjs` (+ empty-prompt no-write + base64-safety + teardown-on-fail). 39/39 pass.
- [x] 3.2 Unit-cover `launchCodex`/`buildCodexLaunchLine` with a prompt containing quotes/backticks/`$`/newlines: the produced argv does NOT inline the raw text and does NOT trip the hook-disabling guard; empty prompt produces the no-positional launch. — `codex-launch.test.mjs` (10/10).
- [x] 3.3 Unit-cover the auto-submit trigger: a single `\r` is sent once, only after a DSR has been observed and output has quiesced; no `\r` when `autoLaunchCodex` is false. — `codex-autostart.test.mjs` drives the real `AioPtyClient` against a fake WS (9/9).

## 4. Track: live-verify (depends: bridge-launch-and-autosubmit)

<!-- BLOCKED on operator action: requires a real ChatGPT auth.json injected into a
     live sandbox + a deploy. Cannot be completed without the user's credential. -->

- [ ] 4.1 With real ChatGPT `auth.json`, run a task end-to-end and confirm the multi-line `task.prompt` pre-fills the composer verbatim and the auto-Enter submits it as ONE message (watch for codex newline-handling regressions #8673/#20580).
- [ ] 4.2 Confirm the base64 prompt round-trips byte-exact through `/v1/shell/exec` into the file for UTF-8 multibyte (CJK/emoji), and tune the output-quiescence window (`CODEX_AUTOSUBMIT_QUIESCE_MS`, default 800ms) for reliable auto-submit.
