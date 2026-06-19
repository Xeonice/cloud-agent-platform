<!-- Track-annotated. Core = claude resident (codex parity); secondary = idle→completed.
     The live residency check (3.3) is the load-bearing verification. -->

## 1. Track: claude-resident-runtime (depends: none)

- [x] 1.1 `apps/api/src/agent-runtime/claude-code-runtime.ts`: change `detectExit()` so it no longer tails the `--session-id` JSONL for `end_turn` and no longer `tmux kill-session`s on a finished turn. It SHALL resolve from `tmux has-session` liveness (present → `running`, gone → `done`), mirroring `CodexRuntime.detectExit()`.
- [x] 1.2 `apps/api/src/terminal/aio-pty-client.ts`: route `claude-code` through the SAME shared liveness poll codex uses (the `livenessTimer` → `hasSession()` → `resolveExitStatus()` on GONE). Remove the claude-specific `pollRuntimeExit` `{done:true}` → `resolveExitStatus()` branch that runs on a still-alive session (the `abnormal_exit` misfire), keeping the abnormal-death watchdog for a session that is GONE without a stop/idle.
- [x] 1.3 Remove or demote the now-unused claude `end_turn` transcript-scan helper (e.g. in `claude-transcript.ts`) and any wiring that fed it; ensure transcript retention still captures the JSONL on session-gone (unchanged, shared path).
- [x] 1.4 Confirm codex is byte-for-byte unaffected (its `detectExit`/liveness path unchanged) and the claude launch line + HOME-root onboarding seed + auth injection are untouched.

## 2. Track: idle-completed (depends: none)

- [x] 2.1 `apps/api/src/guardrails/*` (idle tracker + the integration that turns its callback into a status transition): when a configured idle ceiling trips, transition the task to `completed` instead of force-`failed`. Preserve OFF-BY-DEFAULT (no per-task `idleTimeoutMs` + no `MAX_IDLE_MS` → not tracked) and the STOP-ONLY teardown + slot release.

## 3. Track: tests-and-verify (depends: claude-resident-runtime, idle-completed)

- [x] 3.1 Update/adjust the agent-runtime golden/unit tests: `ClaudeCodeRuntime.detectExit()` now resolves from `tmux has-session` (assert it does NOT emit `kill-session` and does NOT depend on `end_turn`); pin that a finished turn keeps the task `running`.
- [x] 3.2 Guardrails test: a configured idle ceiling trip transitions to `completed` (not `failed`); a task with no ceiling is never tracked.
- [ ] 3.3 **LIVE residency verify (load-bearing):** on a fresh sandbox, a `claude-code` task (a) stays `running` after the first turn finishes (NOT marked completed/failed, session alive), (b) a follow-up typed into the live xterm continues the SAME session, (c) the task ends only on explicit stop, resolving cleanly (never `abnormal_exit`). If Claude instead self-exits after the turn, STOP and capture it — the residency assumption (design risk) is then false and the launch must hold an interactive session open (follow-up).
- [x] 3.4 Run the api gate green: `pnpm --filter @cap/api typecheck && pnpm --filter @cap/api test`.
