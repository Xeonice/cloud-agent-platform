# Fix headless execution container gaps

## Why

`add-headless-execution-track` (v0.12.0) shipped headless execution for programmatic
consumers (MCP / `/v1`). A deploy-time MCP smoke against production v0.12.0 caught two
container-level bugs that the unit tests could not — the golden tests only pinned our own
argv, and exit resolution depends on real detached-tmux behaviour:

- **codex task `967246ff`** → `status: failed`, `get_transcript` → `no-rollout` (no rollout
  was written → `codex exec` never ran).
- **claude task `d402642c`** → `get_transcript` returns a COMPLETE, correct answer (turns +
  final answer, `claude-sonnet-4-6`) — proving the execution and the claude-jsonl transcript
  read both work (the headline `no-rollout` fix is real) — yet `status: failed`.

So: the console interactive-pty path is unaffected; both defects live ONLY in the new
headless path, and they make the v0.12.0 headless feature unusable (codex headless does not
run; claude headless mis-reports success as failure to programmatic consumers).

## What Changes

- **Bug 1 — codex headless argv.** `CodexRuntime.buildHeadlessLine` passes the
  interactive top-level `codex` flags (`--ask-for-approval never --sandbox danger-full-access
  --dangerously-bypass-hook-trust`) to the `codex exec` SUBCOMMAND, which rejects them. Replace
  them with the spike-verified `codex exec` form (`--dangerously-bypass-approvals-and-sandbox`),
  so `codex exec --json` actually runs and writes a rollout. The exact argv MUST be confirmed
  against real codex 0.131 (container smoke) before re-release — no local binary exists.
- **Bug 2 — headless exit code is lost.** `wrapInDetachedSession` runs the headless process as
  the detached tmux session's command; when it exits the session ends and its exit code is
  unrecoverable. `resolveExitStatus` (via `/v1/shell/wait` on the AIO main shell, and `echo $?`
  in a fresh shell) cannot read it → `{ code: null, abnormal: true }` → `failed`. Add a
  headless wrap that appends `; echo $? > <sentinel>` to the inner line, and have
  `resolveExitStatus` read that sentinel first for headless tasks (0 → succeeded, non-zero →
  failed), falling back to the existing wait/echo path.
- **Acceptance is empirical.** Re-run the same production MCP smoke (one codex + one claude
  task): both MUST reach `succeeded` and both `get_transcript` MUST return readable turns.

## Impact

- **Code:** `apps/api/src/agent-runtime/codex-runtime.ts` (Bug 1),
  `apps/api/src/terminal/codex-launch.ts` + `apps/api/src/terminal/aio-pty-client.ts` (Bug 2,
  shared launch mechanism + exit resolution).
- **Specs (MODIFIED):** `aio-sandbox-execution` (the codex headless one-shot argv),
  `agent-runtime` (headless completion → terminal status via captured exit code).
- **Out of scope / unchanged:** the interactive-pty (console) path is byte-identical; the
  runtime→executionMode routing, the claude-jsonl parser, and the transcript read path are all
  confirmed working and untouched. No programmatic multi-turn / resume changes.
- **Constraint:** bound by [[headless-execution-spike-findings]] — codex 0.131 is pinned for
  gpt-5.5 compatibility and MUST NOT be bumped; the fix only changes how we INVOKE it.
