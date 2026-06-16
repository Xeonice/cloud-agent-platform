# Research Brief — survive-api-redeploy

> Side-car grounding doc. NOT a tracked OpenSpec artifact. Captures the
> investigation + two empirical spikes that de-risked this change. Produced from
> read-only codebase investigation and live throwaway-container probes on the
> production VPS (bwg-jp), 2026-06-16.

## The problem (observed in production)

A backend redeploy force-fails every RUNNING task. Confirmed live: task `b3ee3f63`
was `running` when a git push triggered a Dokploy full-stack redeploy at
`08:17:26Z`; the recreated api booted, its startup reap removed the orphaned
RUNNING `cap-aio-*` container, and recovery transitioned the task to `failed`
(`08:17:28Z`) — mid-work, no agent error (the codex transcript showed a
successful build, no final answer; `is_interrupted=true`). Dokploy redeploys the
WHOLE compose stack on ANY push to main (even a frontend-only commit), so the api
is recreated and all in-flight tasks die.

## Why it happens (codebase findings, with citations)

- **Codex is welded to a single ephemeral WS connection and is NOT detached.**
  Codex is launched IN-SHELL over `/v1/shell/ws` as a foreground child of a
  per-task tmux session that the gem-server creates fresh per WS (no
  `?session_id=`): `aio-pty-client.ts:186-190` ("Connect WITHOUT any
  `?session_id=` ... Rejoining is NOT supported"), `aio-pty-client.ts:228-245`
  (`sendInput(buildCodexLaunchLine(argv))`), `Dockerfile:216` (launch argv, no
  nohup/disown/screen/&). When the api's outbound WS closes (api restart), the
  tmux session is severed and codex + its tool children are reaped.
- **On boot the api REAPS running orphans and FAILS their tasks.**
  `aio-sandbox.provider.ts:444-476` (`onApplicationBootstrap` force-removes RUNNING
  `cap-aio-*`); `tasks.service.ts:137-160` (`reclaimOrphanedOnStartup` transitions
  `running`/`awaiting_input` → `failed`).
- **Per-running-task api state is in-memory** (rebuildable from DB): concurrency
  slots (`semaphore.ts:39-41`), deadline/idle timers (`deadline-watcher.ts:56`,
  `idle-tracker.ts:67`, re-armable from `Task.deadlineMs`/`idleTimeoutMs`),
  write-lease, SnapshotManager byte-offset (`snapshot.ts:193-199`). `session.log`
  is durable (`terminal.gateway.ts:1300-1319`).
- **Client reconnect already exists**: WS auto-reconnect with backoff
  (`ws-client.ts:68-70,236-245`), snapshot + tail-replay from `session.log`
  (`snapshot.ts`, `terminal.gateway.ts:1135`). The browser survives an api restart
  today (it just reconnects); only the task gets killed server-side.
- **Frontend is fully decoupled**: Vercel (Nitro), cross-origin `VITE_API_BASE_URL`
  /`VITE_WS_URL`; a frontend deploy never touches a sandbox. Only gap: no
  "new version, refresh" signal (out of scope here).

## The pivotal question and its answer

Can the running codex session be made to survive an api change? Two mechanisms:

1. **AIO `/v1/shell/ws` `?session_id=` rejoin — NOT fixable in our image.** The
   `/v1/shell/*` server is an UPSTREAM third-party binary (ByteDance
   `agent-infra/sandbox` gem-server + libtmux) baked into the pinned base
   `ghcr.io/agent-infra/sandbox:1.0.0.125`; our `docker/aio-sandbox.Dockerfile`
   only layers codex/hooks on top. Patching it means forking upstream — rejected.

2. **The tmux-attach SIDESTEP — empirically verified end-to-end.** AIO sessions
   are tmux-backed and tmux runs as a per-container daemon. Launch codex in a
   DETACHED NAMED tmux session (`tmux new-session -d -s task<id> '<codexline>'`)
   and it becomes a child of the tmux DAEMON, not of the WS-spawned shell — so it
   survives the WS close; a fresh `/v1/shell/ws` can `tmux attach -t task<id>`.
   No upstream change; client-side only.

## Empirical spikes (live, throwaway containers, self-cleaning)

- **Spike #1 (daemon-level, via `docker exec`)** — PASS. A detached named tmux
  session survived the death of the spawning `docker exec`, ticks advanced (3→10)
  across a 6s no-connection window, a fresh exec re-attached to live output, and
  `/v1/shell/exec` saw the session. tmux 3.2a present in the image.
- **Spike #2 (WS-level, via the REAL gem-server protocol)** — PASS. The detached
  session was created OVER a real `/v1/shell/ws` (JSON frames `{type:"input",...}`,
  no `?session_id=`, exactly as `aio-pty-client.ts` connects); that WS was then
  CLOSED; after a 6s no-connection window a FRESH `/v1/shell/ws` saw the session
  alive with ticks advanced (2→11), and `/v1/shell/exec` cross-confirmed. This
  closes the two residual risks: (a) the gem-server does NOT reap detached
  sessions on WS close; (b) the tmux socket is SHARED across connections (a
  session created over WS#1 is visible from WS#2), not per-connection-private.

## Decisions locked

- Route 乙 (detach + reattach + boot re-adoption), client-side only. Route 甲
  (connection supervisor, very-high) and route C (blue-green, very-high) are NOT
  pursued. Resume-run (docker commit + relaunch with rollout replay) stays the
  deferred fallback for ABNORMAL-exit conversation recovery, which the sidestep
  does NOT address.
- `SnapshotManager` + `session-sandbox-retention` are KEPT untouched: they recover
  conversation context on abnormal exit (when there is no live session to attach);
  the sidestep is the orthogonal live-takeover path.

## Anti-scope / caveats

- Not fixing the upstream gem-server; not building blue-green/multi-instance; not
  building resume-run; not building the frontend "new version" banner.
- The FIRST deploy that ships this change still interrupts any then-running task
  (it runs under the old behavior); only subsequent deploys are protected.
- The real implementation cost is RE-ANCHORING task-termination detection off the
  WS-close signal (`aio-pty-client.ts` exit detection) onto tmux-session/codex
  liveness polling — the main regression risk for exit-status correctness.
