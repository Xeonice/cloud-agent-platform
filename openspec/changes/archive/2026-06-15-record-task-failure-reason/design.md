# Design — record-task-failure-reason

## Investigation grounding (production case `ddba5929`)

- Audit chain was exactly `task.created` → `task.running` → `task.failed` (422), NO
  `force_failed:*` event, and it failed ALONE at its timestamp (not a restart batch). Per
  `recordExit` (`guardrails.service.ts:396`) the only path producing a plain `task.failed` with no
  `force_failed` is the **non-zero clean exit** branch (line 422): the codex process exited with a
  non-zero code. The code was available (`AioExitStatus.code`) but only `logger.debug`'d.
- `session.log` is written API-side by the gateway/SnapshotManager at
  `resolveWorkspaceDir(taskId)/session.log` (`snapshot.ts:105`, `terminal.gateway.ts:700/725`) —
  it is NOT inside the sandbox, so it survives teardown.
- AIO exposes `exit_code` (exec/wait) and `/v1/shell/view` (terminal snapshot), but only while the
  container is alive; failed tasks are torn down (retention only STOPS the container, whose HTTP
  API is then unreachable). So post-mortem AIO querying is rejected as a primary source.

## Where the data comes from (decision table)

| Datum | Source | Survives teardown? | Decision |
|-------|--------|--------------------|----------|
| exit code | `AioExitStatus.code` at `onSessionExit`→`recordExit` | yes (already resolved) | **persist it** |
| abnormal flag | `AioExitStatus.abnormal` | yes | persist as cause |
| last output / reason | API-side `session.log` tail | **yes** | **sample tail at exit** |
| live last screen | AIO `/v1/shell/view` | no (race vs teardown) | rejected (unreliable) |
| structured codex turn.failed | codex `rollout` file | only with retention | defer to `session-sandbox-retention` |

## Exit-code → human reason mapping

A pure helper (no I/O) maps the numeric code to a label, reusing Unix `128+signal` convention:

```
0            -> (success — not a failure, never recorded here)
124          -> 超时 (timeout)
130          -> SIGINT (Ctrl-C / 中断)
137          -> SIGKILL (被强杀,疑似 OOM / 容器被杀)
143          -> SIGTERM (被终止,常见部署/重启)
null/abnormal-> 沙箱异常断开 (WS 在会话建立前关闭 / 退出码未解析)
other non-0  -> codex 自身错误或任务提交失败 (见 transcript 末尾)
```

Codex suppresses sub-command stderr on non-zero (openai/codex#1367) and hangs when out of credits
(openai/codex#6512), so the code is a HINT only — the transcript tail is the authoritative reason.

## Audit shape

Mirror the existing `force_failed:<cause>` detail-event pattern (`audit-mapping.ts:36-40`):

- Add kind `exited:<code>` (or a single `task.exited` kind carrying the code in `description`) →
  `422` / `error`, title e.g. "进程退出码 N".
- The detail event's `description` carries: the mapped reason + an ANSI-stripped, length-capped
  (~2–4 KB) tail of `session.log` (last N non-empty lines). The central generic `task.failed`
  transition stays untouched (single chokepoint invariant in `tasks.service.ts:transition`).
- Both `recordExit` non-zero AND `forceFail('abnormal_exit')` emit this detail before/around the
  `failed` transition. Best-effort: a tail-read failure must never block the transition (same
  fail-soft posture as `recordAudit`).

## `readSessionLogTail(taskId)` helper

Lives next to the gateway/snapshot (owns the `session.log` path). Reads the last ~4 KB of the file
(seek from end), strips ANSI/control sequences, returns the last N (~20) non-empty lines, capped to
a stored-size budget. Pure-ish (fs read only), returns `''` if the log is absent (e.g. a task that
failed before any PTY output). Called at the exit seam, where the file is already flushed.

## Risk / fail-soft

- Capture is additive and best-effort: it must NEVER change the transition outcome or block
  teardown/slot-release. Wrap reads + the extra audit write in the existing swallow-and-log path.
- No sandbox dependency, no new network call, no contract change → low blast radius.
- Privacy: the transcript tail may contain repo content; it is operator-only audit data (same
  trust boundary as the existing session.log + audit), so no new exposure.

## Open questions

- Store the tail in `audit_events.description` (no migration) vs a dedicated column? Default:
  reuse `description` to avoid a migration; revisit if the console wants a structured field.
- Single `task.exited` kind vs per-code `exited:<code>` kinds? Default: a single kind with the code
  in the payload (avoids an unbounded enum), unless the console filters by code.
