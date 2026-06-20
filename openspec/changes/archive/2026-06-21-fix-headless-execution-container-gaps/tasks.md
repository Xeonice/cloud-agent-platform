# Tasks — fix-headless-execution-container-gaps

## 1. Bug 1 — codex headless argv (codex `exec` flag surface)

- [x] 1.1 In `apps/api/src/agent-runtime/codex-runtime.ts` `buildHeadlessLine`, replace the
  top-level flags `--ask-for-approval never --sandbox danger-full-access --dangerously-bypass-hook-trust`
  (and the redundant `-C <ws>`, since the tmux wrapper's `-c <ws>` already sets cwd) with the
  `codex exec`-accepted bypass: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$P" < /dev/null`.
- [x] 1.2 Update the golden test in `headless-execution.spec.ts` to pin the NEW argv: assert the
  line contains `--dangerously-bypass-approvals-and-sandbox`, and assert it does NOT contain
  `--ask-for-approval` / `--sandbox ` / `--dangerously-bypass-hook-trust`. Keep `< /dev/null` +
  `--skip-git-repo-check` assertions.

## 2. Bug 2 — capture the detached headless exit code (runtime-agnostic mechanism)

- [x] 2.1 In `apps/api/src/terminal/codex-launch.ts`, add `headlessExitFile(taskId)` →
  `/home/gem/.cap-headless-<taskId>.exit` and `wrapHeadlessDetachedSession(taskId, inner, ws)` that
  wraps as `tmux new-session -d -s <name> -c <ws> '<inner>; echo $? > <headlessExitFile>'` (the
  appended `; echo $? > <file>` adds no single quote → the single-quoted-inner invariant holds).
- [x] 2.2 `CodexRuntime.buildHeadlessLine` + `buildResumeLine` call `wrapHeadlessDetachedSession`
  instead of `wrapInDetachedSession`. Interactive `buildLaunchLine` keeps `wrapInDetachedSession`.
- [x] 2.3 `ClaudeCodeRuntime.buildHeadlessLine` + `buildResumeLine` call `wrapHeadlessDetachedSession`
  (same swap). Interactive path unchanged.
- [x] 2.4 In `apps/api/src/terminal/aio-pty-client.ts`, add `resolveViaExitFile()` (POST
  `/v1/shell/exec` `cat <headlessExitFile(this.taskId)>` → `coerceExitCode`). In `resolveExitStatus`,
  when `this.executionMode === 'headless-exec'`, try `resolveViaExitFile()` FIRST → on a parsed code
  return `{ code, abnormal: false }`; only on miss fall back to the existing `resolveViaWait` →
  `resolveViaEcho` → abnormal chain. Interactive tasks never read the sentinel.

## 3. Tests

- [x] 3.1 Unit test (`codex-launch` or `headless-execution` spec): `wrapHeadlessDetachedSession`
  appends `; echo $? > /home/gem/.cap-headless-<id>.exit` to the inner and stays a clean single-quoted
  tmux word; `headlessExitFile` is the documented path.
- [x] 3.2 Characterization guard: both runtimes' INTERACTIVE `buildLaunchLine` still use
  `wrapInDetachedSession` (NOT the headless wrap) — the console path's launch line is unchanged.

## 4. Verify (empirical — the real gate)

- [x] 4.1 `pnpm --filter @cap/api typecheck` green; full `test` suite green (198 baseline + new).
- [ ] 4.2 **Re-run the production MCP smoke** after deploy: create one codex + one claude task via
  MCP `create_task`; BOTH MUST reach `succeeded` and BOTH `get_transcript` MUST return readable turns
  (codex no longer `no-rollout`; claude no longer `failed`). If codex still returns `no-rollout`,
  iterate the exact `codex exec` argv against the container BEFORE declaring done — this is the only
  proof of codex 0.131 flag acceptance (no local binary).
- [ ] 4.3 Update the `docs/external-api-mcp-epic.md` container-smoke caveat to record it is now
  exercised + passing (at archive time).

## Track: verify-reopened (depends: none)

- [x] 5.1 **`resolveViaExitFile` does not unwrap the live AIO `data`-nested response → the sentinel
  is never read on the real server, so D2's "clean headless success reported as failed" defect is
  NOT actually fixed.** In `apps/api/src/terminal/aio-pty-client.ts` `resolveViaExitFile`
  (lines 1007-1026) the `cat <sentinel>` result is read off the TOP level
  (`body.stdout` / `body.output`). The live AIO `/v1/shell/exec` NESTS the command result under a
  `data` object (`{success, message, data:{exit_code, output, stdout, ...}}`) — proven by
  `AioSandboxProvider.parseExecResult` (apps/api/src/sandbox/aio-sandbox.provider.ts:1176-1196,
  whose docstring states reading the fields off the TOP level "yields `undefined` ... even on a
  successful command") and by `runSandboxExec` in this same file (lines 927-931) which already
  unwraps `top.data ?? top`. On the live server `cat` returns `{data:{output:"0\n"}}` → top-level
  `stdout`/`output` are `undefined` → `out = ''` → `coerceExitCode('')` = null → falls through to
  `resolveViaWait` → `resolveViaEcho` (both miss the detached headless session's exit code) →
  `{code:null, abnormal:true}` → `recordFailure` → `failed`. The clean `succeeded` is still
  reported as `failed`. Fix: unwrap the `data`-nested shape in `resolveViaExitFile` (read
  `output`/`stdout` from `body.data ?? body`, mirroring `runSandboxExec` / `parseExecResult`), and
  add a spec that mocks the live `data`-nested exec response for the exit-file read so the suite
  catches this (none currently does — task 3.x only pins launch-line shape). NOTE: the pre-existing
  `resolveViaEcho` (line 1037) and `probeSessionLiveness` (line 1107) share the same top-level-read
  pattern; assess whether they are also affected on the live server while fixing this.
