## Why

A backend redeploy currently force-fails EVERY running task: the api container is recreated, codex (a foreground child of the per-task WS-spawned tmux session) dies the instant the api's `/v1/shell/ws` closes, and the rebooted api's startup reap removes the orphaned RUNNING sandbox and transitions the task to `failed`. This was observed live (task `b3ee3f63` killed mid-work by a routine push → Dokploy redeploy). Operators cannot ship ANY backend change without sacrificing in-flight work. We want to update the running Agent (frontend + backend) WITHOUT affecting executing sandboxes.

> Side-car: `research-brief.md` records the investigation + two live empirical spikes that de-risk this change; it is NOT a tracked OpenSpec artifact.

## What Changes

- **Launch codex DETACHED in a named tmux session so it outlives the api's WS.** Instead of running codex in-shell as a foreground child of the WS-spawned tmux session, launch it as `tmux new-session -d -s task<id> '<codex launch line>'` over the sandbox shell, so codex becomes a child of the container's tmux DAEMON and SURVIVES the WS closing. **Empirically verified end-to-end** (spike #2: a detached session created over a real `/v1/shell/ws` survived that WS closing and kept running, visible from a fresh WS). No upstream/image change required beyond guaranteeing tmux is present.
- **(Re)connect by ATTACHING to the named session, with fresh-session fallback.** On opening a session for a task, the gateway `tmux attach -t task<id>` to a still-running session if it exists; if the named session is absent/dead, fall back to creating a fresh one. This is what lets a freshly-booted api re-attach to a still-running codex.
- **Re-adopt running sandboxes on api boot instead of reaping + failing them.** Replace the `onApplicationBootstrap` "remove RUNNING orphans" + `reclaimOrphanedOnStartup` "transition running → failed" with a RE-ADOPTION pass: discover RUNNING `cap-aio-*` whose DB task is still `running`/`awaiting_input`, re-register the provider/connection maps, re-attach the terminal, and re-arm guardrail timers + re-account the concurrency slot from the DB. Force-fail ONLY truly-dead/unknown sandboxes. **BREAKING** for anything assuming a terminal-or-failed task after an api restart.
- **Detect task termination by codex/tmux LIVENESS, not by WS-close.** Today task-end is inferred from the WS closing (`aio-pty-client.ts`). Once the session is detached, WS-close no longer means the task is done — termination MUST be re-anchored on polling the named tmux session / codex process liveness (and resolving the real exit status). This is the core behavioral change and the main regression surface (exit-status correctness).
- **Make api shutdown non-destructive to sandboxes.** On SIGTERM/`onModuleDestroy`, do NOT stop/teardown provisioned sandboxes — just release in-memory handles so the next process re-adopts them. (Credential zeroing on the durable side is unaffected.)
- **Single-writer policy for concurrent attach.** Because attach shares one tmux pane, multiple operators attaching the same session all SEE output but only the write-lease holder may inject input (the existing `WriteLockService` gates input).
- **KEEP `SnapshotManager` + `session-sandbox-retention` untouched.** They recover conversation context on ABNORMAL exit (when there is no live session to attach); this change is the orthogonal LIVE-takeover path and does not replace them.

## Capabilities

### New Capabilities
- `sandbox-readoption`: A running task survives an api restart/redeploy — codex runs in a detached named tmux session that outlives the WS; the api re-adopts still-running sandboxes on boot (re-attach + rebuild guardrail/slot state from the DB) rather than reaping and failing them; task termination is detected by codex/tmux liveness rather than WS-close; api shutdown does not tear down sandboxes; and concurrent attach is single-writer.

### Modified Capabilities
- `aio-sandbox-execution`: the "Exit detection mapped to guardrails" requirement changes from "detect task termination by observing the terminal WebSocket close" to liveness-based detection — once codex runs detached, a WS close no longer means the task ended, so termination is detected by polling the named tmux session / codex process and only then resolving the exit status. (The existing in-shell launch + prompt-injection requirement is NOT rewritten: a detached session is still launched over the terminal channel; the new detachment behavior is added in `sandbox-readoption`.)
- `guardrails`: "Startup recovery reclaims orphaned tasks and re-offers queued tasks" gains a Phase 0 re-adoption — still-running tasks whose detached session is alive are KEPT running (timers re-armed, slot re-accounted) and the bootstrap reap spares their containers; only tasks with no live session are force-failed. The queued re-offer + ceiling phases are unchanged.

> Note: the detached-tmux launch, attach-on-(re)connect with fallback, non-destructive shutdown, single-writer concurrent attach, and the liveness termination contract are stated in the NEW `sandbox-readoption` capability; the two modified specs above adjust only the existing requirements that directly conflict. `realtime-terminal` is NOT modified — the operator WS already auto-reconnects and replays from `session.log` unchanged; attach semantics belong to `sandbox-readoption`.

## Impact

- **Backend hot files:**
  - `apps/api/src/terminal/aio-pty-client.ts` — wrap the codex launch in `tmux new-session -d -s task<id>`; add an attach-to-named-session path; re-scope exit detection off WS-close onto liveness.
  - `apps/api/src/terminal/codex-launch.ts` — the launch-line builder feeds the tmux wrapper.
  - `apps/api/src/terminal/terminal.gateway.ts` — `openSession` picks create-vs-attach; single-writer wiring for multi-attach; WS-close handling no longer terminal.
  - `apps/api/src/sandbox/aio-sandbox.provider.ts` — `onApplicationBootstrap` reap → re-adopt; `onModuleDestroy` non-destructive.
  - `apps/api/src/guardrails/guardrails.service.ts` + `apps/api/src/tasks/tasks.service.ts` — startup recovery re-adopts running tasks (skip force-fail); add a `readopt(taskId, …)` path that re-arms timers + re-accounts the slot; liveness-based termination.
  - Possibly a small liveness poller (tmux `has-session` / codex pid) — new, modeled on existing watchers.
- **Image:** `docker/aio-sandbox.Dockerfile` — only IF needed, a one-line `command -v tmux || apt-get install -y tmux` guarantee (tmux 3.2a is already present in the pinned base, verified).
- **Dependencies:** none new (tmux + the gem-server already in the image; dockerode, ws already used).
- **Frontend:** none required — the WS client already auto-reconnects after an api restart (`ws-client.ts`); the operator terminal resumes via snapshot/tail-replay. (An optional "new version, refresh" banner is OUT OF SCOPE.)
- **Operational:** the FIRST deploy of this change still interrupts any then-running task (it lands under the old behavior); only subsequent deploys are protected. Single-instance assumption is preserved (this is NOT blue-green).
- **Specs:** 1 new (`sandbox-readoption`) + 2 modified (`aio-sandbox-execution` "Exit detection", `guardrails` "Startup recovery"). `realtime-terminal`, `session-sandbox-retention`, and `session-history-replay` are deliberately NOT modified (operator reconnect + abnormal-exit recovery are orthogonal and untouched).
