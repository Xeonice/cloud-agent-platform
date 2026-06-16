# Verification Report — survive-api-redeploy

Adjudication of the five raw-unmet requirements for the `sandbox-readoption`
capability after an independent end-to-end re-trace against the actual code (NOT a
rubber-stamp of the skeptic). All five re-trace as **MET**. No requirement re-opened
as a code task; no requirement routed to a spec defect.

Test evidence captured during this pass (local `node --test`):
- `write-lock/write-lock-single-writer.test.mjs` — 18/18 pass.
- `terminal/codex-launch.test.mjs` — pass.
- `terminal/codex-autostart.test.mjs` — 21/21 subtests, 13/13 files pass (real `AioPtyClient` vs fake sandbox WS+HTTP: detached launch → attach → CPR → auto-submit → stream; close()-then-gone fires no second onExit).
- `tasks/startup-recovery.test.mjs` — re-adoption cases 8-12 pass (kept-running, dead-failed, raced-to-gone reclaimed, capacity-accounts-for-re-adopted, terminates-exactly-once).
- `sandbox/aio-sandbox.provider.test.mjs` — pass (re-adopt live, force-remove only no-live-task orphans, spare stopped-retained, shutdown does not stop running sandboxes).

---

## MET — Codex launches in a detached named tmux session that outlives the terminal WebSocket

`buildDetachedCodexLaunchLine()` (apps/api/src/terminal/codex-launch.ts:103-112) wraps
the existing in-shell launch line as `tmux new-session -d -s task<taskId> -c
/home/gem/workspace '<codex launch line>'`; the `-d` detaches from the WS-spawned
shell so codex becomes a child of the container tmux daemon. `launchCodex()`
(aio-pty-client.ts:296-332) sends this then `attachSession()` issues `tmux attach -t
task<taskId>`, so codex runs detached while the WS streams output and the DSR-gated
auto-submit still lands in the attached pane (the prompt-injection contract is
preserved WITHIN the detached session). `onSocketClose()` with an established session
explicitly does NOT call `onExit` (aio-pty-client.ts:590-596 — "left for re-adoption,
not terminating"); `startLivenessPoller()` (604-611) is the sole termination signal.
Verified by `codex-launch.test.mjs` (line starts with `tmux new-session -d -s
task<id>`) and `codex-autostart.test.mjs` on a real fake-sandbox run. **MET.**

## MET — Opening a task session attaches to the live named session with a fresh-session fallback

`openSession` constructs the `AioPtyClient` in `'launch-or-attach'` mode
(terminal.gateway.ts:751-763). On the `ready` frame `launchOrAttachOnReady()`
(aio-pty-client.ts:367-394) probes `hasSession()`: `true` → `attachToNamedSession()`
(tmux attach), `false` → `launchCodex()` fresh launch, `null` (inconclusive) →
`launchCodex(undefined, false)` idempotent-and-recoverable fallback. `probeSessionLiveness`
(757-784) POSTs `tmux has-session -t task<id>` to `/v1/shell/exec`. **MET.**

## MET — A running task survives an api restart or redeploy

End-to-end chain verified: detached launch (codex-launch.ts:103-112); attach-on-reconnect
(`launchOrAttachOnReady` 367-393, liveness poller armed regardless per D4); WS-close
non-terminal for established sessions (aio-pty-client.ts:572-596); boot re-adoption
(`onApplicationBootstrap` aio-sandbox.provider.ts:479-529 — lists running `cap-aio-*`,
`hasLiveSession()`, `reregister()` survivors, force-removes true orphans, spares stopped
history); non-destructive shutdown (`onModuleDestroy` 545-549); guardrails `readopt()`
(guardrails.service.ts:443-479 — `semaphore.offer`, `connections.set`, `gateway.openSession`
which ATTACHES, re-arms deadline/idle watchers); three-phase bootstrap (tasks.service.ts:172-289
— Phase 0 `readoptSurvivorsOnStartup` keeps state, Phase 1 `reclaimOrphanedOnStartup`
skips re-adopted ids at line 276). Dockerfile build-time tmux guarantee at
docker/aio-sandbox.Dockerfile:153. Operator terminal resume relies on the existing WS
auto-reconnect + `session.log` tail-replay (unchanged). `startup-recovery.test.mjs`
cases 8-12 cover kept-running, dead-failed, raced-to-gone, capacity, terminates-once.
**MET.**

## MET — API shutdown does not stop provisioned sandboxes

`onModuleDestroy()` (aio-sandbox.provider.ts:545-549) calls only `this.containers.clear()`,
`this.connections.clear()`, `this.readopted.clear()` — no `container.stop()`/`remove()`.
The normal terminal teardown path (`teardownSandbox`, `container.stop({t:0})`) is
unaffected, so stop-only retention + pre-stop credential zeroing still run on a real
terminal task. Verified by provider tests (re-adopted container handles released without
stop; freshly-provisioned container `stopped===0 && removed===0` after `onModuleDestroy`).
**MET.**

## MET — Concurrent attach to a task session is single-writer (met-as-written, minor accepted gap)

`onKeystroke()` (terminal.gateway.ts:817-835) gates `session.pty.write()` behind
`writeLock.isWriter(sessionId, clientId)` — the sole operator-input write path.
`WriteLockService.acquire()` (write-lock.service.ts:73-96) returns `LeaseOutcome.Denied`
when a different client holds a live lease; `grantWriteLeaseIfFree()` (gateway 931-938)
keeps a second operator a reader. 18/18 `write-lock-single-writer.test.mjs` pass,
including T3-c2/c3/c4 (others denied while c1 holds the lease) and "exactly one writer
at a time".

Minor gap (does NOT block the primary scenario): the `tmux attach` does not pass `-r`
(read-only), so an actor who BYPASSED the WS gateway and connected directly to the AIO
sandbox `/v1/shell/ws` could inject input outside the application-layer lock. The design
explicitly accepts this as within the container trust boundary (write-lock.types.ts:1-5 —
the lock is not delegated to tmux; suppression is purely application-layer). The spec's
single-writer scenario is about two operators attached THROUGH the gateway, which is
fully gated. **MET (met-as-written with an accepted minor gap).**

---

## Scope notes (behaviors present in the diff with NO spec requirement)

These are defensive sub-behaviors / test-reliability fixes carried by the change but not
mandated by any spec scenario. Recorded for traceability; none re-open a requirement.

- `armAutoSubmit = false` on the inconclusive (`alive === null`) liveness fallback
  (aio-pty-client.ts:375-381) — prevents a stray Enter if the probe was wrong and codex
  was already running (duplicate `tmux new-session` is a no-op, the attach rejoins the
  live codex). Not in any spec scenario; defensive correctness.
- `approvals-endpoint-roundtrip.test.mjs` replacing `delay(50)` with a `waitForPending`
  poll (lines 117, 150) — a test-reliability race fix unrelated to any
  survive-api-redeploy requirement.
- `runnerMinutes.recordStart(taskId)` inside `readopt()` (guardrails.service.ts:477) —
  resumes the runner-minutes accounting interval for the re-adopted running task. No spec
  requirement mentions metrics/billing resumption on re-adoption.
- `livenessTimer.unref?.()` (aio-pty-client.ts:610) — prevents the liveness poller from
  keeping the Node.js event loop alive. Implementation detail, not in any spec requirement.

## Gap note — single-writer "shared tmux pane" vs. one-AioPtyClient-per-task

The spec phrases single-writer as "non-holders attached to the shared pane are read-only
and SHALL NOT inject keystrokes." The architecture uses ONE `AioPtyClient` per task (not
one per operator); multiple operators see the same session output through the gateway's
fan-out, and only the lease holder's input passes the `onKeystroke` `isWriter` gate. The
spec's "attaching to the same named tmux session" is therefore conceptual at the operator
level — implemented at the gateway/write-lock seam rather than via per-operator tmux
attaches. The single-writer guarantee holds for all operators reaching the task through
the gateway (the only supported path). Implemented.
