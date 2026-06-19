## Why

`claude-code` tasks are accidentally **one-shot** and, worse, a **successfully-completed turn is misclassified as `abnormal_exit` and force-failed**. Root cause (diagnosed on a live v0.10.0 sandbox, task `d04f`): `ClaudeCodeRuntime.detectExit()` tails the transcript for the last `assistant` `end_turn`, then proactively `tmux kill-session`s and runs the codex-style `resolveExitStatus()` (`/v1/shell/wait` + `echo $?`). After the deliberate kill, that resolution returns nothing → `abnormal` → the completed task is force-failed and its sandbox reaped (exit 137). The transcript shows Claude had finished the doc-update turn cleanly (`stop_reason == end_turn`).

This diverges from **codex, which is already a resident continuous-conversation session**: codex's `detectExit()` is purely `tmux has-session` (present → `running`, gone → `done`), so codex stays alive across turns and the operator keeps chatting in the live xterm until the session is explicitly stopped. The product intent is resident continuous conversation for BOTH runtimes; Claude was made one-shot by an `end_turn`-driven completion that codex never had.

## What Changes

- **Align `claude-code` to codex's resident session-gone model.** `ClaudeCodeRuntime.detectExit()` no longer treats `end_turn` as task completion and no longer `tmux kill-session`s. Claude stays resident (interactive TUI idling for the next input); the operator types follow-ups into the live xterm → continuous multi-turn conversation. The task is `done` ONLY when the session is gone — exactly like codex — via explicit stop or (when configured) idle/deadline reclamation.
- **Remove the `end_turn` → kill-session → `resolveExitStatus()` path** that misfires `abnormal` on a clean turn. Claude rides the SAME shared `tmux has-session` liveness poll codex uses; the abnormal-death watchdog still catches a genuinely crashed session.
- **Idle reclamation terminal status → `completed`** (decision 1): when an idle ceiling IS configured and trips, the task ends gracefully as `completed`, not force-`failed`.
- **Default = no reclamation** (decision 2): keep today's behavior — with no per-task `idleTimeoutMs` and no operator default, a task is NOT idle-tracked and runs until explicitly stopped. Documented, not newly added.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `agent-runtime`: the "ClaudeCodeRuntime turn-completion exit detection" requirement is replaced — Claude is a resident continuous-conversation session resolved by `tmux has-session` (codex parity), not by an `end_turn` one-shot completion.
- `guardrails`: idle-reclamation terminal status becomes `completed` (graceful) rather than a force-`failed`; the default-off (no-reclamation) posture is affirmed.

## Impact

- **Code**: `apps/api/src/terminal/aio-pty-client.ts` (claude no longer uses the `pollRuntimeExit`/`detectExit`-end_turn branch + the `{done:true}`→`resolveExitStatus` path; claude uses the shared liveness poll like codex); `apps/api/src/agent-runtime/claude-code-runtime.ts` (`detectExit` no longer tails `end_turn`/kills the session); the claude `end_turn` transcript-scan helper is removed or demoted; `apps/api/src/guardrails/*` (idle terminal status → `completed`).
- **Unaffected**: claude launch line + auth/token injection + `CLAUDE_CONFIG_DIR`/HOME-root seed (the just-shipped onboarding fix), codex behavior, the byte-stream asciicast replay, transcript retention (capture still fires on session-gone, like codex).
- **Verification (key risk)**: confirm Claude actually STAYS ALIVE (resident, idling) after a turn in the detached tmux when not killed — a follow-up typed into the live xterm must continue the same session; the task stays `running`; only stop/idle ends it; an idle-reaped task resolves `completed`, never `abnormal_exit`.
- **Resource note**: with default no-reclamation + no end_turn auto-complete, a resident task holds its sandbox until explicitly stopped. `deadline_ms` remains available as an optional wall-clock backstop (no default added here).
- **Out of scope**: resuming a conversation after sandbox reclamation (`claude --resume` + retained transcript); the `awaiting_input` UX refinement (kept at codex-parity `running` for now).
- **Deploy note**: api-only; ships in the next release; no migration; no aio-sandbox rebuild.
