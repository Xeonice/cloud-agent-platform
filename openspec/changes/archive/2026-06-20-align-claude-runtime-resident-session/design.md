## Context

Both runtimes launch their agent as an interactive TUI in a detached tmux session inside the AIO sandbox; the operator attaches over `/v1/shell/ws` and types into the live xterm (write-lease gated). **codex** is resident: `CodexRuntime.detectExit()` is `tmux has-session` (present → `running`, gone → `done`), so a codex task stays alive across turns until the session is killed (stop / configured idle). **claude** was given a different `detectExit()` that tails the `--session-id` JSONL for the last `assistant` `end_turn`, then `tmux kill-session`s and resolves the exit — making it one-shot. Live diagnosis (task `d04f`, v0.10.0) showed a cleanly-completed turn (`end_turn`) misclassified `abnormal_exit` because, after the deliberate kill, `resolveExitStatus()` (`/v1/shell/wait` + `echo $?`) returned nothing → `abnormal` → force-fail → sandbox reaped (137). See the explore thread for the full timeline.

## Goals / Non-Goals

**Goals:**
- A `claude-code` task is a resident continuous-conversation session, behaviorally identical to codex: stays alive across turns, the operator keeps chatting in the live xterm, the task ends only on session-gone (stop / configured idle / deadline).
- A completed turn is never misclassified as `abnormal_exit`.
- Idle reclamation (when configured) ends a task as `completed`, not `failed`.

**Non-Goals:**
- No change to codex, the launch lines, auth/token injection, the HOME-root onboarding seed, asciicast replay, or transcript retention.
- Not adding the `awaiting_input` status for claude (kept at codex-parity `running`; a later UX refinement).
- Not building conversation resume after reclamation.
- Not adding a default idle ceiling or a default deadline (residency stays until explicit stop).

## Decisions

**D1 — Claude rides codex's session-gone liveness path; drop the `end_turn` completion.**
`ClaudeCodeRuntime.detectExit()` stops tailing `end_turn` and stops `tmux kill-session`-ing. Claude uses the SAME `tmux has-session` liveness poll codex uses (present → running, gone → done). The simplest implementation: claude's `detectExit` returns `running` unless the session is gone (mirroring codex), and the `pollRuntimeExit` `{done:true}`→`resolveExitStatus` branch no longer runs for a still-alive claude. The abnormal-death watchdog (session GONE without a stop) is retained for both.
- Alternative (keep `end_turn` only to set a status, never to kill) — rejected for this change: it re-introduces the transcript-tail machinery and diverges from codex; deferred with the `awaiting_input` refinement.

**D2 — Idle reclamation resolves `completed`, default off.**
When a configured idle ceiling trips, the integration transitions the task to `completed` (graceful end of a resident session), replacing the current force-`failed`. With NO per-task `idleTimeoutMs` and NO operator default, the idle tracker does not arm at all (today's behavior) — so the default is no reclamation; a task runs until explicitly stopped.

**D3 — A genuinely dead session is still `failed`.**
The liveness watchdog must distinguish "claude alive, idling for input" (session present → keep running) from "claude/tmux died unexpectedly" (session gone with no stop/idle in flight → `abnormal` → `failed`). Only the latter is a failure; a clean idling turn is never probed for an exit code.

## Risks / Trade-offs

- **[KEY] Does claude actually stay resident when not killed?** The design assumes interactive `claude "<prompt>"` in the detached tmux PTY idles at the REPL after a turn (like codex), so simply not killing it yields residency. If claude instead self-exits after the positional-prompt turn, the session would go gone on its own → resolved as a (clean) `done` rather than residing. MUST be verified live before relying on it (verification task). Fallback if claude self-exits: adjust the launch to hold an interactive session open (keep stdin attached / interactive flag) — captured as a follow-up, not pre-built here.
- **[Resource] Residency holds the sandbox until explicit stop.** No idle default + no end_turn auto-complete means forgotten tasks pin sandboxes. Mitigation available (operator idle default, or per-task `deadline_ms`); intentionally not defaulted per decision 2.
- **[Completion semantics] "completed" now mostly means stop/idle, not "the work finished".** A resident session has no automatic "done when the work is done" signal; this is the accepted model (same as codex today).

## Migration Plan

API-only; no DB migration; no aio-sandbox rebuild. Ships in the next release. Rollback = revert the runtime/guardrails changes (restores the prior one-shot claude). Existing codex tasks are unaffected.
