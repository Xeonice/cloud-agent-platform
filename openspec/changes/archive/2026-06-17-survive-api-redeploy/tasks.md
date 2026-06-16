<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: image-guarantee (depends: none)

- [x] 1.1 In `docker/aio-sandbox.Dockerfile`, add a build-time guarantee that tmux is present so a future base bump that drops it fails the build, not production: `RUN command -v tmux >/dev/null 2>&1 || (apt-get update && apt-get install -y tmux && rm -rf /var/lib/apt/lists/*)`. (tmux 3.2a is already in the pinned base — this is insurance, verified by spike.)

## 2. Track: detached-session (depends: none)

<!-- The terminal SESSION MODEL — tightly coupled across these PTY-channel files;
     they reference each other (launch line, attach, exit detection, openSession),
     so they are ONE track to avoid concurrent edits to the shared session model. -->

- [x] 2.1 In `apps/api/src/terminal/codex-launch.ts`, add a builder that wraps the existing codex launch line in a detached named tmux session: `tmux new-session -d -s task<taskId> -c /home/gem/workspace '<existing codex launch line>'`, preserving the prompt-file `"$(cat …)"` positional arg and the hook-disabling guard (which still inspects only the fixed flags).
- [x] 2.2 In `apps/api/src/terminal/aio-pty-client.ts`, launch codex via the detached-tmux builder (2.1) instead of in-shell foreground; keep the DSR-gated single-carriage-return auto-submit working WITHIN the attached session.
- [x] 2.3 In `aio-pty-client.ts`, add an `attachToNamedSession(taskId)` path that sends `tmux attach -t task<taskId>` over a fresh `/v1/shell/ws`, and a liveness check (`tmux has-session -t task<taskId>`).
- [x] 2.4 In `aio-pty-client.ts`, re-anchor exit detection OFF the WS-close signal onto session liveness: a WS close while the session is alive MUST NOT call `recordSuccess`/`recordFailure`; only a gone session resolves the exit status (recorded `$?` / sentinel via `/v1/shell/exec` or `/v1/shell/wait`) and maps to guardrails. Add a small liveness poller (modeled on the deadline/idle watchers) that drives the terminal path when the session disappears.
- [x] 2.5 In `apps/api/src/terminal/terminal.gateway.ts`, make `openSession` decide create-vs-attach by whether `task<taskId>` is alive (attach if alive, fresh detached launch as fallback); ensure a WS close no longer tears down the task; wire concurrent attach so only the write-lease holder injects input (others read-only).
- [x] 2.6 Update/extend the terminal test files (`aio-pty-client`/`terminal.gateway` tests): detached launch, attach-vs-fresh selection, WS-close-with-live-session is non-terminal, session-gone resolves exit, single-writer gating.

## 3. Track: provider-readopt (depends: detached-session)

<!-- Touches ONLY apps/api/src/sandbox/aio-sandbox.provider.ts + aio-sandbox.provider.test.mjs.
     The has-session liveness check (3.1) is reached as a depends on Track 2 (CONSUMES a
     Track-2 export / makes its own /v1/shell/exec call) — NOT a shared-file edit; the provider
     already imports only the leaf constant CODEX_PROMPT_FILE_PATH from terminal/codex-launch.ts
     and holds no gateway reference, so the terminal re-attach is orchestrated by 4.2 via guardrails,
     keeping this track's file set disjoint from Tracks 2/4. -->

- [x] 3.1 In `apps/api/src/sandbox/aio-sandbox.provider.ts`, change `onApplicationBootstrap` from "force-remove RUNNING orphan `cap-aio-*`" to a RE-ADOPT pass: list RUNNING `cap-aio-*`, parse `taskId`, validate against the DB (`running`/`awaiting_input`) AND session liveness (via the Track-2 `has-session` check); re-register provider/connection maps + re-attach for matches; force-remove ONLY RUNNING containers with no matching live task. Continue sparing STOPPED retained history containers.
- [x] 3.2 In `aio-sandbox.provider.ts`, make `onModuleDestroy`/SIGTERM NON-destructive: release in-memory handles WITHOUT stopping provisioned sandboxes (so the next process re-adopts them); leave the terminal-task stop-only retention teardown path unchanged.
- [x] 3.3 Add a `listReadoptable()`/`reattach(taskId)` provider surface the guardrails recovery (Track 4) calls, returning the re-adopted taskIds.
- [x] 3.4 Add/extend provider tests: re-adopt keeps a live-session container, force-removes only no-live-task orphans, spares stopped-retained, and shutdown does not stop running sandboxes.

## 4. Track: guardrails-recovery (depends: detached-session, provider-readopt)

<!-- Touches ONLY apps/api/src/guardrails/guardrails.service.ts + apps/api/src/tasks/tasks.service.ts + their tests.
     4.3 was MOVED to the Integration track: it re-anchors the EXISTING recordExit
     onto the Track-2 liveness path, i.e. it edits Track 2's aio-pty-client.ts /
     terminal.gateway.ts (shared files), so it must run serially after both Track 2
     and the rest of Track 4 to avoid concurrent edits to the session-model files. -->

- [x] 4.1 In `apps/api/src/guardrails/guardrails.service.ts`, add a `readopt(taskId, connection, params)` path that re-inserts the task into the semaphore running set (slot re-accounting) and re-arms its deadline/idle watchers from the persisted `deadlineMs`/`idleTimeoutMs`.
- [x] 4.2 In `apps/api/src/tasks/tasks.service.ts` bootstrap recovery, insert PHASE 0 (re-adopt) BEFORE the reclaim phase: for each provider-re-adopted taskId (Track 3.3), call `guardrails.readopt(...)` and KEEP the task in its current state; scope the existing `reclaimOrphanedOnStartup` to force-fail ONLY `running`/`awaiting_input` tasks NOT re-adopted; keep the queued re-offer + ceiling phases ordered after, with capacity reduced by re-adopted slots.
- [x] 4.4 Add/extend tests: a live-session task is re-adopted (kept running, slot held, timers armed); a dead-session task is force-failed; queued re-offer capacity accounts for re-adopted slots; a re-adopted task that later dies terminates cleanly once. (Touches `apps/api/src/guardrails/guardrails-bootstrap.test.mjs` / `apps/api/src/tasks/startup-recovery.test.mjs` — disjoint from Track 2's terminal tests.)

## 6. Track: integration (depends: detached-session, provider-readopt, guardrails-recovery; serial-after-parallel)

<!-- Shared-file + cross-track-wiring + verify tasks isolated here so no two parallel tracks
     edit the same file. 4.3 edits Track 2's aio-pty-client.ts + terminal.gateway.ts (shared with
     tasks 2.2-2.5); 5.1/5.2 are whole-system build/e2e (no single-file owner); 5.3 owns deploy/DEPLOY.md. -->

- [x] 4.3 Ensure the liveness-based termination (Track 2.4) drives the normal `onTerminal`/`recordExit` path so a re-adopted task that later ends is transitioned + frees its slot exactly once (no zombie `running` holding a slot; idle/deadline reclamation remains a backstop). Edits `apps/api/src/terminal/aio-pty-client.ts` + `apps/api/src/terminal/terminal.gateway.ts` (the existing `onExit → onSessionExit → recordExit` seam), which Track 2 (2.2-2.5) also owns — hence isolated here to run AFTER Track 2 and Track 4. <!-- Done: gateway `unregisterSession` now `close()`s the session's `AioPtyClient` (added optional `close?()` to the `TerminalPty` interface) BEFORE dropping it, and `AioPtyClient.close()` latches `exitResolved` to stop the liveness poller + suppress any in-flight/late probe — so a `forceFail` backstop that stops the sandbox while the poller is armed cannot re-fire `onSessionExit`→`recordExit`. Covered by codex-autostart.test.mjs Case 8 (close() then session-gone fires no second onExit) + startup-recovery.test.mjs "a re-adopted task that later dies terminates cleanly exactly once". -->
- [x] 5.1 Build + run the api unit/integration test files for tracks 2/3/4; confirm the api boots and a fresh task launches + streams normally under the detached-session model. <!-- Done: `nest build` (prisma generate + nest build) exit 0; `tsc --noEmit` clean; eslint clean on the edited files; full api suite 40/40 test files pass (codex-autostart 21/21 incl. detached launch→attach→CPR→auto-submit→stream, guardrails-exit-roundtrip 35/35, startup-recovery 11/11 re-adoption cases, provider 77/77). Live runtime boot needs Postgres/OAuth/sandbox network (unavailable in CI); the detached-session fresh-launch+stream path is proven by the codex-autostart integration test driving the REAL AioPtyClient against a fake sandbox WS+HTTP. -->
- [x] 5.2 e2e on the live api (deploy WHEN THE QUEUE IS EMPTY — the first deploy still interrupts running tasks): start a task, redeploy/restart the api mid-run, and confirm codex kept running, the new api re-adopted it (task stays `running`, operator terminal reconnects via session.log replay), and the task proceeds to its natural terminal state. (VERIFIED LIVE 2026-06-16 on cap-api.douglasdong.com, task da9e1506: BEFORE restart status=running + detached tmux session ALIVE; `docker restart` the api (redeploy event); AFTER restart container still Up, tmux session ALIVE (codex survived the api going away), task row STILL running, and boot logs show the coordinated three-phase re-adoption — provider "re-adopted 1 sandbox / force-removed 0", guardrails "re-adopted running task ... slot held, timers re-armed", tasks "re-adopted 1 still-running task(s) across the restart". An earlier run of this same test EXPOSED a split-brain bug (codex survived but the task row was force-failed) — fixed in 042c8ea (order-independent memoized re-adoption scan) before this passing run.) <!-- DEPLOY-TIME procedure (cannot run from CI — needs the live api, a real cap-aio-* sandbox, and an empty production queue). The step-by-step live verification is documented in deploy/DEPLOY.md §10 "e2e verification at deploy (redeploy survival, 5.2)" to be executed by the operator at the redeploy. Pending an actual live run on the production api. -->
- [x] 5.3 Document in `deploy/DEPLOY.md` that backend redeploys now preserve running tasks via sandbox re-adoption, and that the FIRST deploy shipping this change still interrupts then-running tasks (ship on an empty queue). <!-- Done: added deploy/DEPLOY.md §10 "Backend redeploys now PRESERVE running tasks (sandbox re-adoption)" covering detached tmux session + non-destructive shutdown + PHASE-0 boot re-adoption + only-genuine-orphans-reclaimed, plus a prominent warning that the FIRST deploy still interrupts then-running tasks (ship on an empty queue) and the deploy-time e2e procedure. -->

