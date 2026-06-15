<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: audit-taxonomy (depends: none)

- [x] 1.1 In `apps/api/src/audit/audit-mapping.ts`, add a failure-detail event kind for a process exit (single `task.exited` kind carrying the code in the payload, NOT an unbounded `exited:<code>` enum) → `resultCode: 422`, `level: error`, title e.g. "进程退出码". Keep the existing `task.failed` / `force_failed:*` kinds untouched.
- [x] 1.2 In `apps/api/src/audit/audit-mapping.ts` (pure, no I/O), add `reasonForExit(code: number | null, abnormal: boolean): string` mapping: `124`→超时, `130`→SIGINT(中断), `137`→SIGKILL(疑似 OOM/容器被杀), `143`→SIGTERM(被终止), `abnormal||code===null`→沙箱异常断开, other non-zero→"codex 自身错误或任务提交失败(见输出末尾)". Unit-test the table.
- [x] 1.3 In `apps/api/src/audit/audit-recorder.port.ts` (+ recorder impl), allow the failure-detail event to carry a caller-supplied `description` (code + reason + transcript tail) instead of only the static descriptor title. Keep the central `recordTransition` path unchanged.

## 2. Track: transcript-tail (depends: none)

- [x] 2.1 In `apps/api/src/terminal/snapshot.ts` (or alongside the gateway that owns the `session.log` path), add `readSessionLogTail(taskId): Promise<string>`: seek ~4 KB from the end of `resolveWorkspaceDir(taskId)/session.log`, strip ANSI/control sequences, return the last ~20 non-empty lines capped to a stored-size budget. Return `''` when the file is absent. Pure fs read, no sandbox call.
- [x] 2.2 Expose `readSessionLogTail` to the guardrails seam via the existing narrow gateway-slice interface guardrails already depends on (do NOT couple guardrails to terminal internals); add the method to that port + its implementation.
- [x] 2.3 Unit-test the tail helper: ANSI stripping, non-empty-line selection, size cap, and the absent-file → `''` path.

## 3. Track: wire-exit-capture (depends: audit-taxonomy, transcript-tail)

- [x] 3.1 In `apps/api/src/guardrails/guardrails.service.ts` `recordExit` non-zero branch (line ~421), before/around `safeTransition(taskId, 'failed')`, read the transcript tail and emit the `task.exited` detail event with `description = "退出码 N · <reason> · …<tail>"`. Best-effort: wrap in the swallow-and-log path so it never blocks the transition.
- [x] 3.2 In `recordExit` abnormal branch / `forceFail('abnormal_exit')`, emit the same detail event with the abnormal reason + tail. Leave the existing `force_failed:abnormal_exit` event in place (or fold the code/tail into its description — pick one, document it).
- [x] 3.3 Confirm the clean-exit (`recordSuccess` → `completed`) path emits NO `task.exited` event.
- [x] 3.4 Remove the now-redundant `logger.debug` exit-code line in `onSessionExit` only if its info is fully captured by the audit (otherwise keep for live debugging).

## 4. Track: verify (depends: wire-exit-capture)

- [x] 4.1 Build/typecheck `apps/api` + run the audit-mapping and tail-helper unit tests green.
- [x] 4.2 Drive a NON-ZERO codex exit in a real or faithfully-stubbed sandbox; confirm the audit row carries the exit code + mapped reason + transcript tail, alongside the unchanged `task.failed`.
- [x] 4.3 Drive an ABNORMAL exit (kill the sandbox / drop the WS pre-session); confirm the abnormal reason + tail are recorded.
- [x] 4.4 Confirm a clean `completed` task records no `task.exited` noise, and that a forced tail-read error does NOT block the transition (inject a read failure).
