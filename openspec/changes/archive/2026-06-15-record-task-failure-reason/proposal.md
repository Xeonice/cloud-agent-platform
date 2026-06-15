## Why

When a task fails, the console records only a generic `task.failed` audit event ("任务失败",
result code 422) with NO cause detail. A real production failure (`ddba5929`, ran 6h42m then
failed) was un-diagnosable after the fact: the `tasks` table has no exit-code/error column, the
`audit_events` row is generic, the cap-aio sandbox was torn down on failure, and the api logs had
rotated. The information that WOULD explain it already exists at failure time but is discarded:

- The terminal bridge resolves an **exit code** (`AioExitStatus.code`, via the AIO
  `/v1/shell/exec`+`/v1/shell/wait` resolution) and hands it to `GuardrailsService.recordExit` —
  which currently only `logger.debug`s it before driving a plain `task.failed`/`force_failed`
  transition. The numeric code is never persisted.
- The full PTY transcript is captured API-side into `session.log`
  (`resolveWorkspaceDir(taskId)/session.log`, written by the gateway's SnapshotManager) and
  SURVIVES sandbox teardown — but is never sampled into the failure record.

The AIO sandbox DOES expose the data at runtime (`exit_code` on exec/wait; a terminal snapshot on
`/v1/shell/view`), but those HTTP endpoints only answer while the sandbox container is alive — a
failed task is torn down (with retention it is merely STOPPED, whose HTTP API is still
unreachable). So a post-mortem AIO query is unreliable; the durable capture must happen at the
exit seam, from sources that outlive the sandbox (the resolved exit code + the API-side
`session.log`). Codex itself compounds this: it suppresses sub-command stdout/stderr on non-zero
exit (openai/codex#1367) and can hang indefinitely when out of credits (openai/codex#6512) — the
latter matches `ddba`'s long idle-then-fail shape — so the exit code alone is not enough; the
transcript tail is what distinguishes credits/rate-limit vs crash vs operator error.

## What Changes

- **Persist the exit code on every non-success terminal exit.** `recordExit` SHALL thread
  `status.code` + `status.abnormal` into the audit so the failure record carries the numeric exit
  code and a human-readable mapping (e.g. `137`→被 SIGKILL/疑似 OOM, `143`→SIGTERM/被终止,
  `130`→SIGINT, `124`→超时, other non-zero→codex 自身错误/任务提交失败). Mirrors the existing
  `force_failed:<cause>` detail-event pattern with an `exited:<code>` detail event (the central
  generic `task.failed` stays).
- **Sample the transcript tail into the failure record.** At the exit seam (BEFORE teardown),
  read the tail of the API-side `session.log` (last ~2–4 KB, ANSI-stripped, last N non-empty
  lines) and store it on the failure audit so an operator sees codex's actual last output
  ("rate limit"/"out of credits"/"error: …") without the sandbox.
- **Apply to both failure paths**: the non-zero clean exit (`recordExit` → plain `failed`) AND
  the abnormal exit (`force_failed:abnormal_exit`). A clean `completed` exit is unaffected.
- **NON-GOAL (explicitly out of scope):** depending on a post-mortem AIO `/v1/shell/view` call;
  full structured codex `rollout` replay (that is the separate `session-sandbox-retention`
  change — this change is the lightweight, always-on complement that needs no retention window).

## Capabilities

### New Capabilities
<!-- No new capability — extends the existing audit + guardrails/terminal exit handling. -->

### Modified Capabilities
- `audit-history`: MODIFY the lifecycle audit taxonomy so a failure carries diagnostic detail —
  an `exited:<code>` event kind (code + human reason) and a transcript-tail excerpt on the
  failure record, rather than a bare generic "任务失败".
- `terminal-execution` (or `guardrails`): MODIFY the exit-handling seam (`onSessionExit` →
  `recordExit`) to forward the resolved exit code and a sampled `session.log` tail into the audit
  on non-success exits.

## Impact

- **Backend:** `guardrails.service.ts` (`recordExit` non-zero + abnormal branches thread code +
  tail into the audit; `forceFail` cause carries them), `audit-mapping.ts` (add `exited:<code>`
  kind → 422/error), `audit` recorder + port (accept an optional `description`/detail payload),
  `terminal.gateway.ts` / `snapshot.ts` (expose a `readSessionLogTail(taskId)` helper reading the
  API-side `session.log`). No contract/frontend change is strictly required, though the console
  audit view will render the richer description for free.
- **Data:** new `audit_events` rows of kind `exited:<code>`; the existing `description` column
  carries the reason + tail excerpt (no schema migration needed if reusing `description`; a
  dedicated column is optional).
- **No dependency on sandbox liveness:** capture is from the resolved exit code + API-side
  `session.log`, so it works even though failed sandboxes are torn down.
- **Verification:** force a non-zero codex exit and an abnormal exit in a real/stubbed sandbox and
  confirm the audit row shows the code + mapped reason + transcript tail; confirm a clean
  `completed` task records no `exited:*` noise.
