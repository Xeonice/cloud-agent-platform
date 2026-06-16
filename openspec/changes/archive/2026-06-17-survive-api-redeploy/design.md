## Context

A backend redeploy recreates the api container; codex — launched in-shell as a foreground child of the per-task tmux session that the AIO gem-server spawns per `/v1/shell/ws` connection — dies the instant that WS closes; the rebooted api then force-removes the orphaned RUNNING `cap-aio-*` container and transitions the task to `failed`. Observed live (task `b3ee3f63`). The sandbox is already a separate container; the only thing welding the task's life to the api process is (1) codex being a foreground child of the WS-tied shell, and (2) the boot reap treating any RUNNING `cap-aio-*` as an orphan.

Two mechanisms could let a running task survive: fixing the AIO `?session_id=` rejoin (rejected — upstream third-party gem-server in the pinned base image, not ours), or the **tmux-attach sidestep** (a detached named tmux session lives on the container's tmux daemon, survives the WS close, and is re-attachable from a fresh WS). The sidestep is **empirically verified end-to-end** by two live spikes (see `research-brief.md`): a detached session created over a real `/v1/shell/ws` survived that WS closing, kept running, and was visible/attachable from a fresh WS; the gem-server does NOT reap detached sessions on WS close and the tmux socket is shared across connections.

This is cross-cutting (terminal PTY layer + sandbox provider + guardrails recovery) with a BREAKING behavioral shift (a running task is preserved, not failed, across an api restart), so a design doc is warranted.

## Goals / Non-Goals

**Goals:**
- A running task's codex keeps executing UNINTERRUPTED through an api redeploy; the sandbox is unaffected.
- On boot, the api RE-ADOPTS still-running sandboxes (re-attach + rebuild state) instead of reaping + failing them.
- The operator terminal resumes automatically (existing WS auto-reconnect + snapshot/tail-replay).
- Client-side only; no upstream gem-server change; image change minimal-to-none.
- Abnormal-exit conversation recovery (`SnapshotManager` + `session-sandbox-retention`) is preserved unchanged.

**Non-Goals:**
- Zero api CONTROL-PLANE downtime (REST may blip for seconds during the container swap — acceptable; the sandbox/codex does not stop). True zero-downtime (blue-green/multi-instance) is explicitly NOT pursued.
- Fixing the upstream AIO `?session_id=` rejoin.
- Resume-run (commit stopped container → relaunch with rollout replay) — stays the deferred fallback for abnormal-exit recovery, which this change does NOT address.
- Frontend "new version, refresh" banner.

## Decisions

### D1 — Detached named tmux session (the verified sidestep), not the upstream rejoin
Launch codex as `tmux new-session -d -s task<id> -c /home/gem/workspace '<codex launch line>'` over the sandbox shell. It becomes a child of the container tmux daemon and survives the WS close (spike #2). Create-vs-attach is decided by whether the named session already exists.
- *Alternative — fix AIO `?session_id=` rejoin:* rejected; upstream third-party binary in the pinned base image (`research-brief.md`).
- *Alternative — connection-supervisor process (route 甲) / blue-green (route C):* rejected as very-high effort; the sidestep achieves the goal client-side.

### D2 — Attach on (re)connect, with dead-session fallback
`openSession` checks the named session: if alive → `tmux attach -t task<id>` (re-adopt the live codex); if absent/dead → create fresh (D1). This is what makes a freshly-booted api re-attach to a still-running task, and also handles operator reconnect.

### D3 — Boot RE-ADOPTION replaces reap + force-fail
`onApplicationBootstrap` (provider) changes from "force-remove RUNNING `cap-aio-*`" to: list RUNNING `cap-aio-*`, parse `taskId`, validate against the DB (`running`/`awaiting_input`), and for matches re-register the provider/connection maps + re-attach; force-remove ONLY containers with no matching live task (truly orphaned/unknown). `tasks.service.reclaimOrphanedOnStartup` is scoped to SKIP re-adopted tasks (they stay `running`) and force-fail only the truly-dead. A new `guardrails.readopt(taskId, …)` re-inserts the task into the semaphore running set (slot accounting) and re-arms deadline/idle timers from `Task.deadlineMs`/`idleTimeoutMs`.

### D4 — Termination detection re-anchored on liveness (the hard part)
Today task-end is inferred from the WS/session close (`aio-pty-client.ts`). With a detached session, WS-close ≠ task-done. Termination MUST be detected by polling the named tmux session existence / codex process liveness, and the real exit status resolved (the existing `/v1/shell/exec echo $?` / `wait` path). This is the primary regression surface — exit-status correctness, idle/deadline interplay, and avoiding zombie `running` tasks that hold a slot forever.
- Mitigation: a dedicated liveness poller modeled on the existing deadline/idle watchers; on "session gone" resolve exit and drive the normal terminal path.

### D5 — Non-destructive shutdown
`onModuleDestroy`/SIGTERM releases in-memory handles WITHOUT stopping provisioned sandboxes, so the next process re-adopts them. Pre-stop credential zeroing on the DURABLE/teardown path (session-sandbox-retention) is unchanged and still applies on real task teardown.

### D6 — Single-writer for concurrent attach
Attach shares one tmux pane (all attachers see output; input is shared). Gate input through the existing `WriteLockService` so only the lease holder injects keystrokes; others are read-only viewers.

### D7 — Keep abnormal-exit recovery untouched
The sidestep only enables LIVE takeover of a still-running session. On a true crash/SIGKILL there is no session to attach; `SnapshotManager` + the frozen-stopped-layer + structured rollout (`session-sandbox-retention`) remain the conversation-recovery mechanism and MUST NOT be removed.

## Risks / Trade-offs

- **Termination-detection regression (highest).** → Moving off WS-close can mis-report exit status or leak zombie `running` tasks holding slots. Mitigate with a liveness poller + explicit exit resolution + a backstop (idle/deadline reclamation still arms).
- **First-deploy interruption.** → The deploy that ships this still runs under old behavior and kills then-running tasks. Mitigate: ship when the queue is empty; document it.
- **Single-instance assumption preserved.** → Re-adoption trusts every RUNNING `cap-aio-*` belongs to this host's prior process. A future multi-node setup would need ownership/heartbeat (out of scope; noted).
- **tmux socket / image drift.** → The sidestep depends on the upstream tmux being present + on a shared socket (verified for the pinned tag). A base bump could change it. Mitigate: pin the tmux expectation with the `command -v tmux ||` guarantee so a base bump that drops tmux fails the build, not production.
- **Multi-attach echo.** → Two attachers share one pane; D6's single-writer gates input but both see output — acceptable, matches a shared terminal.
- **Control-plane blip.** → REST is briefly unavailable during the container swap; the WS client auto-reconnects. Acceptable per Non-Goals.

## Migration Plan

1. Ship D1/D2 (detached launch + attach-on-connect) behind the same code path; verify a fresh task launches + streams normally.
2. Ship D3/D4/D5 (boot re-adoption + liveness termination + non-destructive shutdown).
3. Deploy WHEN THE QUEUE IS EMPTY (first deploy still interrupts running tasks).
4. Verify e2e on the live api: start a task, redeploy the api, confirm codex keeps running and the new api re-adopts it (operator terminal reconnects, task stays `running`, completes normally).
- **Rollback:** revert to in-shell launch + reap-on-boot; detached sessions left behind are reaped by the (restored) boot reap. No schema change to roll back.

## Open Questions

- Liveness poll cadence + how to resolve a precise exit code for a detached session that ended between polls (vs the current synchronous WS-close exit resolution).
- Should re-adoption also rebuild the SnapshotManager byte-offset from `session.log` on boot (for scrollback continuity), or is fresh-snapshot-on-reattach acceptable?
- Multi-attach: do we surface "another operator is viewing" in the UI, or keep it silent (input already gated by the write-lease)?
