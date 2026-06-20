# Design — fix-headless-execution-container-gaps

## Context

Two defects in the v0.12.0 headless path, both found by a production MCP smoke and both
invisible to unit tests (golden tests pinned our own argv; exit resolution needs real
detached-tmux behaviour). The interactive-pty path is unaffected and must stay byte-identical.

## D1 — codex headless argv: use the `codex exec` flag surface, not the top-level one

`CodexRuntime.buildHeadlessLine` (codex-runtime.ts:238) currently emits:

```
codex exec --json -C <ws> --ask-for-approval never --sandbox danger-full-access \
  --dangerously-bypass-hook-trust --skip-git-repo-check "$P" < /dev/null
```

`--ask-for-approval`, `--sandbox`, and `--dangerously-bypass-hook-trust` are top-level `codex`
flags (the interactive resident, codex-runtime.ts:57, and `scripts/aio-hook-firetest.sh`). The
`codex exec` SUBCOMMAND rejects them → exec aborts → no rollout → `failed` + `no-rollout`. The
spike ([[headless-execution-spike-findings]]) verified the `codex exec` bypass is the single
flag `--dangerously-bypass-approvals-and-sandbox`. New form (drop `-C`; the tmux wrapper's
`-c <ws>` already sets cwd, matching the working resume line which has no `-C`):

```
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$P" < /dev/null
```

`buildResumeLine` (line 252, `codex exec resume <sid> "$P" --json --skip-git-repo-check < /dev/null`)
is already correct — resume inherits the sandbox and rejects `-s`/`--sandbox` — and is unchanged
except for the wrapper swap in D2.

**Empirical gate (non-negotiable):** there is no local codex 0.131 binary, so the exact argv
is confirmed by the production MCP smoke (V1), not by a unit test. The golden test is updated
to pin the NEW argv, but the golden test is a regression guard, not proof of codex acceptance.

## D2 — capture the detached headless exit code via a sentinel file

`wrapInDetachedSession` (codex-launch.ts:130) runs the agent as the tmux session's command:

```
tmux new-session -d -s task<id> -c <ws> '<inner>'
```

When the headless process exits, the session ends and the exit code is gone.
`resolveExitStatus` → `resolveViaWait` (`/v1/shell/wait` waits on the AIO MAIN shell, not this
tmux session) and `resolveViaEcho` (`echo $?` in a FRESH shell) both miss it → `{ code: null,
abnormal: true }` → `recordFailure` → `failed`. This is why claude `d402642c` ran to a clean
final answer yet reported `failed`.

**Mechanism (runtime-agnostic, lives in the shared launch layer — not in a runtime policy):**

- New `headlessExitFile(taskId)` constant → `/home/gem/.cap-headless-<taskId>.exit`.
- New `wrapHeadlessDetachedSession(taskId, inner, ws)` in codex-launch.ts:
  ```
  tmux new-session -d -s task<id> -c <ws> '<inner>; echo $? > /home/gem/.cap-headless-<id>.exit'
  ```
  The `; echo $? > <file>` is appended INSIDE the single-quoted inner — it adds no single quote,
  so the existing "inner carries no single quote" invariant holds. `$?` is codex/claude's exit
  because the echo is the next command after the agent. The write completes BEFORE the shell
  exits and the session ends, so by the time `tmux has-session` reports gone the file exists (no
  race).
- Both runtimes' `buildHeadlessLine` + `buildResumeLine` call `wrapHeadlessDetachedSession`
  instead of `wrapInDetachedSession`. (Interactive `buildLaunchLine` keeps `wrapInDetachedSession`
  unchanged → console path byte-identical.)
- `resolveExitStatus`: when `this.executionMode === 'headless-exec'`, try a new
  `resolveViaExitFile()` FIRST (`/v1/shell/exec` → `cat <sentinel>` → parse int). On a parsed
  code, return `{ code, abnormal: false }`. Only if the sentinel is missing/unreadable fall back
  to the existing `resolveViaWait` → `resolveViaEcho` → abnormal chain. Interactive tasks never
  read the sentinel (path unchanged).

Exit-code mapping is unchanged downstream: `0 → recordSuccess` (succeeded), non-zero →
`recordFailure` (failed). The sentinel file is small and per-task; teardown already removes the
container, so no extra cleanup is required.

## D3 — what stays untouched (regression surface)

- Interactive-pty launch line, `terminalStartup`, DSR/CR handshake, `selectLaunch` interactive
  branch — byte-identical (existing 174-test characterization must stay green).
- Runtime→executionMode routing, the claude-jsonl parser, `readRolloutFromContainer`,
  `parseTranscript` dispatch — all confirmed working by the smoke; not touched.

## Risks

- **codex argv still wrong after the change.** Mitigation: the MCP smoke (V1) is the gate; if
  codex still returns `no-rollout`, iterate the argv against the container before re-release.
- **Sentinel race / quoting.** Mitigated by appending after the agent command inside the same
  single-quoted inner (no new quotes; write precedes session end).
