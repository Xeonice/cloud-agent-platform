# Verification Report — agent-control-platform

Adversarial spec verification with three-way routing. Each verified requirement was
classified as **MET** (implementation traced end-to-end), **UNMET** (core logic exists
but is not wired / a validation boundary is broken — re-opened as a `verify-reopened`
task in `tasks.md`), or **SPEC-DEFECT** (requirement ambiguous/untestable — recorded in
`design.md` "Open Questions", no implementation task).

- **MET** requirements with evidence are catalogued below.
- **UNMET** findings → `tasks.md` `## Track: verify-reopened (depends: none)` (VR.1–VR.10).
- **SPEC-DEFECT** findings → `design.md` "Open Questions" (no task).

## Routing summary

| Destination | Count | Where |
| --- | --- | --- |
| MET | see catalogue below | this report |
| UNMET (code problem) | 10 | `tasks.md` → VR.1–VR.10 |
| SPEC-DEFECT (ambiguous requirement) | 1 | `design.md` → "Open Questions" (Write-lock lazy-vs-proactive release) |

### UNMET findings routed to `tasks.md` (for cross-reference)

- VR.1 — "Concurrency semaphore bounds running tasks" (guardrails): `admit()`/`onTerminal()` never called outside `guardrails/`.
- VR.2 — "Wall-clock deadline force-fails a task" (guardrails): `admit()` never invoked (deadline never armed) and `SandboxProvider` port has no teardown method.
- VR.3 — "Idle ceiling reclaims wedged tasks" (guardrails): `recordActivity()`/`admit()`/`onTerminal()` never fed by any external caller.
- VR.4 — "Circuit breaker on repeated start/turn failure" (guardrails): `recordFailure()`/`recordSuccess()` have zero external call sites.
- VR.5 — "Ephemeral credentials destroyed with the session" (guardrails/runner-dialback-and-creds): natural-completion `onTerminal()` is dead code; creds/TASK_TOKEN leak on clean completion.
- VR.6 — "contracts package is the single source of truth" (monorepo-foundation): runner local mirror schemas not replaced + `post-tool-use`/`git-diff` enum drift.
- VR.7 — "Postgres + Prisma data model for repos and tasks" (repo-and-task-management): CUID default vs `z.string().uuid()` contract → `ZodError` at the validation boundary.
- VR.8 — "Live-frame parity under PTY parity conditions" (realtime-terminal/frontend-console): no geometry round-trip; runner PTY fixed at 80x24 while browser auto-fits.
- VR.9 — "Server-side backpressure with bounded high-water mark" (realtime-terminal): `BackpressureController` constructed with no PTY, so `pause()`/`resume()` no-op.
- VR.10 — "Snapshot plus tail-replay reconnect" (realtime-terminal): `SnapshotManager` never instantiated / `registerSession()` never called, so reconnect frames never sent.

### SPEC-DEFECT routed to `design.md` "Open Questions" (for cross-reference)

- **Write-lock "Expired lease without heartbeat is released" — lazy vs. proactive release is underspecified.** Implementation releases lazily (purge on next read); spec does not state whether release must be observable to connected clients at expiry time. Met-as-written but ambiguous; resolve spec wording before any code work. No `verify-reopened` task.

## MET requirements (with evidence)

### agent-events-and-approvals

**Blocking hook forwards the approval round-trip** — MET
- `apps/runner/hooks.json:6,12` — PreToolUse and PermissionRequest hooks registered with `"blocking":true` pointing to `permission-request.hook.js`.
- `apps/runner/src/hooks/permission-request.hook.ts:42` — `ApprovalTransport.requestDecision()` Promise does not resolve until a decision is available; `:97` `await transport.requestDecision(event)` blocks execution; `:146` `stdout.write(JSON.stringify(envelope))` prints `{decision}` JSON to stdout for Codex; `:102,111,138-141` fail-closed deny on any malformed/unparseable response.
- `packages/contracts/src/approvals.ts:18,25-28` — `DecisionBehaviorSchema=z.enum(['allow','deny'])` with optional `message` satisfies the decision contract.

**Any-deny-wins resolution** — MET
- `apps/runner/src/hooks/resolve-decision.ts:19-37` — `resolveDecisions()`: empty set → `{behavior:'deny'}` (fail-closed, :20-22); any `deny` → deny (:24-29); only when no deny → `{behavior:'allow'}` (:32-36).
- Call site: `apps/runner/src/hooks/permission-request.hook.ts:105` — result validated (:109) then printed to stdout (:146).
- Contract: `apps/runner/src/hooks/contract.ts:21` — `DecisionBehaviorSchema = z.enum(['allow','deny'])`; out-of-range falls back to deny (:109-112 in permission-request.hook.ts).

**PostToolUse file-edit reporting with git-diff fallback** — MET
- Implemented in `apps/runner/src/hooks/post-tool-use.hook.ts` (post-hoc file-edit reporting with git-diff fallback for partial hook coverage).

**Hooks baked into the runner image** — MET
- `apps/runner/Dockerfile` + `apps/runner/hooks.json` register the blocking hooks into the runner image at top level.

**Two-capability notification adapter port** — MET
- `apps/runner/src/notify/adapter.port.ts` exposes the `notify` (one-way) and `request-decision` (round-trip) adapter capabilities.

### frontend-console

**New task creation from the console** — MET
- `apps/web/src/app/tasks/new/page.tsx:22-185` — new-task form (repo selector, branch, strategy, prompt); submits via `createTask()`; on success renders `created.id` and `Link` to `/tasks/${created.id}`.
- `apps/web/src/lib/api-client.ts:76-89` — `createTask()` POSTs to `/repos/${repoId}/tasks` with bearer auth; `:31-37` `authHeaders()` attaches `Authorization: Bearer` via `operatorToken()`.
- `apps/api/src/tasks/tasks.controller.ts:30-38` — `@Post('repos/:repoId/tasks')` handler.
- `apps/api/src/tasks/tasks.service.ts:31-53` — `create()` validates repo (404 if missing), inserts task, issues TASK_TOKEN.
- `apps/api/src/auth/auth.module.ts:19-26` — `APP_GUARD` registers `AuthGuard` globally over this endpoint.
- `packages/contracts/src/task.ts:110-127` — shared `CreateTaskRequestSchema`/`TaskResponseSchema` used by both sides.

**`packages/ui` `<Terminal>` wrapping xterm.js (fit/serialize/unicode11)** — MET
- `packages/ui/src/terminal/terminal.tsx` wraps xterm.js with fit/serialize/unicode11 addons; consumed by `apps/web`.

**Session page with WebSocket + approval surface** — MET
- `apps/web/src/app/tasks/[id]/page.tsx` — live terminal + WebSocket + lock-independent approval surface.

**Fleet dashboard** — MET
- `apps/web/src/app/page.tsx` — dashboard fleet view.

**Cross-origin env config** — MET
- `apps/web/.../config.ts` — env-configurable `API_BASE_URL`/`WS_URL` for cross-origin web↔api.

### multi-target-deploy

**Persistent volume for session.log survives restart** — MET
- Fly.io: `apps/api/fly.toml:24` sets `WORKSPACES_DIR="/data/workspaces"`; `:26-29` `[mounts]` `source="cap_api_data"` `destination="/data"`.
- Docker Compose: `docker-compose.yml:28` `WORKSPACES_DIR=/data/workspaces`; `:36-38` mounts named volume `workspaces` at `/data/workspaces`; `:55-57` top-level `workspaces:` volume.
- Append-only open: `apps/runner/src/session-log.ts:50` opens in `'a'` (append) mode — existing log never truncated on restart.
- Idempotent workspace creation: `apps/runner/src/task-entry.ts:133-139` resolves path from `config.workspacesRoot` and `mkdir {recursive:true}` (never wipes existing `session.log`).

**Vercel (web-only, no WS server)** — MET
- `vercel.json` ships web only; no WS server.

**api deploy targets (Fly.io + docker-compose)** — MET
- `apps/api/fly.toml` + `docker-compose.yml` deploy the stateful NestJS WS+PTY orchestrator on both targets.

**Cross-origin env vars** — MET
- `API_BASE_URL`/`WS_URL` configured cross-origin in both deploy configs.

### realtime-terminal

**Dual-channel WebSocket protocol** — MET
- `apps/api/src/terminal/terminal.gateway.ts` carries raw-byte and discriminated control-frame channels; frames validate against contracts zod schemas (`packages/contracts/src/ws-frames.ts`, `control-frame.ts`).

**Live-frame parity — PTY-side and transit fidelity** — PARTIAL (parity precondition unreachable → routed to VR.8)
- TERM pinned on PTY side: `apps/runner/src/pty/spawn-codex.ts:84` (`name:'xterm-256color'`) and `:129` (`TERM:'xterm-256color'` pinned last in `buildPtyEnv`).
- Raw byte fidelity verbatim in transit: `session-log.ts:60` (append, no transform) → `terminal.gateway.ts:639` (base64 encode) → `ws-client.ts:127` (decode) → `page.tsx:116` (`term.write`).
- rAF coalescing: `page.tsx:96-131` buffers chunks, flushes once per `requestAnimationFrame`.
- Gap (VR.8): no geometry round-trip — `apps/web/.../tasks/[id]/page.tsx:282-286` does not pass `onResize`; no `ResizeFrame` in contracts; `CodexPtyHandle.resize()` (`spawn-codex.ts:104`) never invoked from the gateway; runner PTY stays at spawn default 80x24 while browser auto-fits. The "identical cols and rows" precondition is unreachable at runtime, so live-frame byte-identity is not guaranteed.

**Server-side backpressure with bounded high-water mark** — PARTIAL (producer halt missing → routed to VR.9)
- HWM correctly defined: `packages/contracts/src/ws-frames.ts:83` (500,000) and enforced in `apps/api/src/terminal/backpressure.ts:77`.
- Controller calls `pty?.pause()` (`backpressure.ts:122`) / `pty?.resume()` (`:147`) — only when a `PausablePty` is injected.
- Accounting, HWM constant, ACK frames, and hysteresis fully implemented.
- Gap (VR.9): `terminal.gateway.ts:200` constructs `new BackpressureController()` with NO pty arg → `pty?.pause()`/`pty?.resume()` silently no-op; `emitFlowSignal` (`:649-663`) only sends client control frames, never halts the producer.

**Snapshot plus tail-replay reconnect** — PARTIAL (lifecycle wiring missing → routed to VR.10)
- Contracts fully implemented: `packages/contracts/src/snapshot-frames.ts:21-33` (SnapshotFrame), `:41-51` (TailReplayFrame), `:58-68` (ReconnectFrame).
- Server logic fully implemented: `apps/api/src/terminal/snapshot.ts:83` (SnapshotManager), `:141` (capture records cols/rows/seq), `:154` (start arms interval), `:182` (buildReconnectFrames), `:216` (readTailFrames reads `session.log` from byte offset).
- Gateway/client wired: `terminal.gateway.ts:88-92` and `:676-711`; client `page.tsx:138-147,159-168`.
- Gap (VR.10): no `new SnapshotManager(...)`, `registerSession()`, `snapshots.start()`, or `snapshots.feed()` outside definition files → `terminal.gateway.ts:689` always hits `if (!session) return`; neither snapshot nor tail-replay frames are ever sent.

**ACK pause/resume frames in contracts** — MET
- `packages/contracts/src/ws-frames.ts` defines explicit `pause`/`resume`/`ack` control-frame variants.

### repo-and-task-management

**Postgres + Prisma data model for repos and tasks** — PARTIAL (CUID/UUID mismatch → routed to VR.7)
- Schema/migration present and correct: `apps/api/prisma/schema.prisma:34-64`, `apps/api/prisma/migrations/20260601000000_init/migration.sql:1-37`.
- `TaskStatus` enum incl. `agent_failed_to_start` defined in `packages/contracts/src/task.ts:15-23` and `schema.prisma:23-31`; lifecycle guard `apps/api/src/tasks/task-lifecycle.ts:36-44`.
- Gap (VR.7): `schema.prisma:35,49` use `@default(cuid())` for `Repo.id`/`Task.id` while contracts `task.ts:41,58,60` validate id/repoId as `z.string().uuid()`. Every `repoResponseSchema.parse()` (`repos.service.ts:22,29,37`) and `taskResponseSchema.parse()` (`tasks.service.ts:52,68,76,100,118`) throws a `ZodError` (CUIDs are not UUID format). The persisted model is correct; the service validation boundary is broken.

**REST API for repos** — MET
- Spec scenarios: `openspec/changes/agent-control-platform/specs/repo-and-task-management/spec.md:15-25`.
- `apps/api/src/repos/repos.controller.ts:27-31` — `POST /repos` (HTTP 201); `:34-36` `GET /repos`; `:38-42` `GET /repos/:id`.
- `apps/api/src/repos/zod-validation.pipe.ts:14-19` — `ZodValidationPipe` throws `BadRequestException` (HTTP 400) on invalid body.
- Service validates request via `createRepoBodySchema` and response via `repoResponseSchema` from `@cap/contracts` (`packages/contracts/src/task.ts:73-96`); `ReposService.create()` writes to Prisma (`repos.service.ts:15-22`).
- `ReposModule` registered in `AppModule` (`apps/api/src/app.module.ts:38`). All three scenarios (create+list, 201 with id, 400 on invalid body) implemented.

**REST API for tasks** — MET
- Contracts SSoT: `packages/contracts/src/task.ts:15-23` (`TaskStatusSchema`, all 7 states), `:110-134` (`CreateTaskRequestSchema`/`TaskResponseSchema`/`ListTasksResponseSchema`).
- Prisma: `apps/api/prisma/schema.prisma:23-31` (`TaskStatus` enum), `:48-64` (Task model with `repoId` FK, prompt, `status @default(pending)`).
- Repos REST (3.3): `repos.controller.ts:27-43`; `repos.service.ts:32-38` (`findById` → 404).
- Tasks REST (3.4): `tasks.controller.ts:30-48` (POST 201, GET list, GET by id, ZodValidationPipe); `tasks.service.ts:31-53` (`create()` → 404 on missing repo at :34, issues TASK_TOKEN at :50); `:64-77` (`list()`/`findById()` with 404).
- Lifecycle (3.5): `task-lifecycle.ts:36-44` (`ALLOWED_TRANSITIONS`, terminal states empty); `:80-95` (`assertTransition` throws on illegal edge; `toAgentFailedToStart`); `tasks.service.ts:87-101` (`transition()` asserts before `db.update`, leaving status unchanged on rejection).
- Auth gating: `auth.module.ts:19-22` (`APP_GUARD`), `app.module.ts:41` (`AuthModule` imported).

### runner-dialback-and-creds

**Runner dials back to the orchestrator** — MET
- Outbound-only dial: `apps/runner/src/dialback/dialback-client.ts:43` (`OutboundSocketFactory`) and `:119` (socketFactory call — no bind/listen).
- Handshake frame: `packages/contracts/src/dialback.ts:12-20` (`DialbackHandshakeFrameSchema` with channel, `type:'dialback_handshake'`, taskId, TASK_TOKEN); exported via `index.ts:25`, included in `ControlFrameSchema` at `control-frame.ts:48`.
- Orchestrator verifier: `apps/api/src/terminal/terminal.gateway.ts:346-354` (unauthenticated runner may only send `dialback_handshake`) and `:443-464` (`onDialbackHandshake` calls `taskTokens.verify`, closes 1008 on failure, associates taskId on success).
- Token issuance (scoped, TTL): `apps/api/src/tasks/task-token.service.ts:61-78` (`issue`: `randomBytes(32)`, per-task binding, TTL); minted at task creation `tasks.service.ts:50`.
- Token binding enforced (A-token cannot claim task B): `task-token.service.ts:101-103` (`record.taskId !== id` → false) and `:105-108` (expiry with lazy purge).
- Ephemeral creds destroyed at session end: `guardrails.service.ts:176-178` (`teardownSession` calls `creds.destroyForSession` AND `taskTokens.revokeForTask`); `session-credential.ts:98-101` (`destroy()` zeroes secret); `session-credentials.service.ts:49-59` (`provisionForSession` throws on duplicate).

**Ephemeral credentials destroyed with the session** — PARTIAL (natural-completion path dead code → routed to VR.5)
- `SessionCredential.destroy()` zeroes the secret (`session-credential.ts:98-101`).
- `SessionCredentialsService.destroyForSession()` removes from the in-memory Map (`session-credentials.service.ts:98-105`).
- `GuardrailsService.teardownSession()` calls `creds.destroyForSession()` on forced-failure paths (`guardrails.service.ts:176-179`).
- `onModuleDestroy()` calls `destroyAll()` on graceful shutdown (`session-credentials.service.ts:125-127`).
- Gap (VR.5): `GuardrailsService.onTerminal()` (`guardrails.service.ts:124-129`) — the public method that destroys credentials at natural task completion — has zero call sites outside the guardrails module. No REST status-transition endpoint and no runner-completion → `onTerminal()` wiring. Forced-failure paths (`forceFail` :154-163) correctly call `teardownSession()`, but the natural-completion path is dead code; creds/TASK_TOKENs leak on cleanly-completing tasks.

**Dial-back handshake carries TASK_TOKEN / per-task token scope** — MET
- See above (`dialback.ts`, `task-token.service.ts`); per-task binding enforced at `task-token.service.ts:101-108`.

### terminal-execution

**session.log is the byte source of truth** — MET
- Append-only open: `apps/runner/src/session-log.ts:50` (`open(logPath, 'a')`); existing content never truncated.
- Verbatim writes: `session-log.ts:60-63` (`append(bytes)` writes with no transformation).
- Opened before PTY subscription: `apps/runner/src/task-entry.ts:156-157` (`SessionLog.open()` before data subscription — no early byte dropped).
- PTY `onData` appends in emission order: `task-entry.ts:182-187`.
- Authoritative replay source: `apps/api/src/terminal/snapshot.ts:104-105,216-254` (`readTailFrames()` reads `session.log` via `createReadStream` from a byte offset); `terminal.gateway.ts:671-711` (`onReconnect` → `buildReconnectFrames()` → snapshot + tail replay).

**Agent-failed-to-start surfaces distinctly without hanging** — MET
- Early-exit failure: `apps/runner/src/startup-window.ts:92-95` (`noteExit()` settles `{ok:false, reason:'early_exit'}` on exit before `sawFirstFrame`); `task-entry.ts:190-207` (`pty.onExit → startupWindow.noteExit`, then on failure `reporter.reportAgentFailedToStart(...)` + `teardown(pty, sessionLog)`).
- Bounded startup window: `startup-window.ts:63-73` (constructor arms `setTimeout(windowMs)`, default 30000ms at :30; settles `{ok:false, reason:'startup_timeout'}`; timer `unref()`d at :72 so it doesn't hang the event loop); failure reported at `task-entry.ts:198-207`.
- Distinct terminal state: `packages/contracts/src/task.ts:6-23` (`agent_failed_to_start` first-class enum); `task-lifecycle.ts:19,37-44` (listed separately from `failed`, reachable from `pending`/`queued`/`running`); `tasks.service.ts:107-119` (`markAgentFailedToStart()` persists via `toAgentFailedToStart()`).

**Interactive codex under node-pty (xterm-256color)** — MET
- `apps/runner/src/pty/spawn-codex.ts` spawns interactive codex under node-pty with `TERM=xterm-256color`.

**Isolated per-task workspace** — MET
- `apps/runner/src/task-entry.ts` resolves an isolated per-task workspace under `workspacesRoot`.

### write-lock-and-takeover

**Single-writer multi-reader lease** — MET
- Lease state machine: `write-lock.types.ts:23` (`Lease` interface with `writerClientId` + `leaseExpiry`); `write-lock.service.ts:66` (`acquire()` single-writer grant; denied client stays reader :84-88; expired holder displaced :73-76); `:102` (`heartbeat()` advances expiry; expired heartbeat releases :109-113); `:125` (`takeover()` unconditional seizure, reports `demotedClientId` :127-128); `:141` (`releaseOnDisconnect()` immediate drop, false for non-holders); `:154` (`isWriter()` gate, false for expired via `getLease` :164-174).
- Gateway wiring: `terminal.gateway.ts:484` (`onKeystroke` checks `isWriter`, silently drops non-writer keystrokes); `:241-244` (`handleDisconnect` → `releaseOnDisconnect` + broadcast); `:587-608` (`onDecision` lock-INDEPENDENT, explicit comment); `:719-728` (`attachPty` not gated on lease — all operator clients receive the read stream); `:530-544` (`broadcastLeaseState` fans out on every change).
- Contracts: `packages/contracts/src/write-lock-frames.ts` (Keystroke/Heartbeat/TakeoverRequest/LeaseState frames).

**Heartbeat renewal and expiry** — MET (with SPEC-DEFECT on observability — see Open Questions)
- HeartbeatFrame: `packages/contracts/src/write-lock-frames.ts:59-65`.
- Renewal logic: `write-lock.service.ts:102-116` — non-holder/mismatch → Denied (:105); expired-at-heartbeat → delete + Denied (:109-112, Scenario B); live match → `grant()` sets `leaseExpiry = now()+leaseTtlMs` (:115, :185, Scenario A).
- TTL: `write-lock.types.ts:44-48` (`leaseTtlMs = 30_000`).
- Gateway: `terminal.gateway.ts:494-502` (`onHeartbeat` → `heartbeat()` then `broadcastLeaseState()`; auth gate :499).
- Note (SPEC-DEFECT, routed to design.md): expiry is lazy (`getLease()`/`isWriter()` purge on read, `write-lock.service.ts:164-174`/`:154`); no timer-driven proactive `lease_state` broadcast when a lease lapses between interactions. Met-as-written but the spec is ambiguous on whether release must be observable at expiry time. No `verify-reopened` task.

**Preemptive takeover** — MET
- Takeover service: `write-lock.service.ts:125-132` (`takeover()` unconditionally overwrites via `grant()`, returns `TakenOver` + `demotedClientId = previousHolder`).
- Gateway wire-up: `terminal.gateway.ts:508-516` (`onTakeover()` validates auth, calls `writeLock.takeover()`, then `broadcastLeaseState()`; note: `demotedClientId` return is discarded — demotion is passive via broadcast, not an explicit per-client push).
- Keystroke gate: `terminal.gateway.ts:484` (`onKeystroke` → `isWriter`; after takeover the old holder's keystrokes are silently dropped).
- Contract: `packages/contracts/src/write-lock-frames.ts:75-82` (`TakeoverRequestFrameSchema`).

**Auto-release on disconnect** — MET
- `write-lock.service.ts:141` (`releaseOnDisconnect()`); `terminal.gateway.ts:241-244` (`handleDisconnect` calls it + broadcasts).

**Keystroke lock-gated; approvals lock-independent** — MET
- Keystroke gate: `terminal.gateway.ts:484`. Approval independence: `:587-608` (`onDecision` explicit "Lock-INDEPENDENT" comment). Read stream ungated: `:719-728`.

## Capabilities with all requirements MET (no per-requirement gap)

Beyond the requirements catalogued above, the following capabilities had every requirement
traced to implementation with no UNMET/SPEC-DEFECT finding:

- **monorepo-foundation** — pnpm + Turborepo workspace; contracts as SSoT (note: VR.6 covers the runner mirror drift under "contracts package is the single source of truth"); strict TypeScript in `packages/tsconfig/base.json` + `.claude/settings.json` hooks + husky pre-commit; `turbo.json` `build` `dependsOn: ["^build"]`; aggregate `turbo typecheck lint build`.
  - Note: the "Schemas are exported with inferred types" scenario is fully met — `packages/contracts/src/index.ts` re-exports all schemas and `z.infer` types across 11 source files with 40+ inferred-type exports.
- **sandbox-provider-port** — `SandboxProvider` port (`apps/api/src/sandbox/sandbox-provider.port.ts`); Docker impl reporting `danger-full-access` with documented trade-off (`docker-sandbox.provider.ts`); port designed for a future stricter impl with no consumer changes.
  - Note: the port currently exposes only `getSandboxMode()` (`sandbox-provider.port.ts:49-56`) with no teardown method — the missing teardown is folded into VR.2 ("Wall-clock deadline force-fails a task"), not raised as a separate sandbox-provider-port gap.
- **single-user-auth** — operator token gates REST (`auth.guard.ts`) and WebSocket (`terminal.gateway.ts`); constant-time comparison (`constant-time.ts`); refuse-to-boot on unset token (`main.ts`); unauthenticated `/health`.

## Gap / scope analysis

**Coverage assessment.** All 12 spec capabilities were enumerated and every requirement
traced against the codebase. Every requirement has *traceable implementation* — there are
no requirements with zero implementation. The 10 UNMET findings are integration/wiring gaps
(core logic exists but is not invoked end-to-end) or a single broken validation boundary
(CUID/UUID), not missing features. The 1 SPEC-DEFECT is a requirement-wording ambiguity, not
a code defect.

**Common root cause of the UNMET cluster.** Six of the ten UNMET findings (VR.1–VR.5, VR.10)
trace to the same place: `tasks.md` task **12.1b** (and the Track 14 orchestrator-integration
cross-track call sites) were marked `[x]` but the actual cross-module wiring never landed —
`GuardrailsService.admit/onTerminal/recordActivity/recordFailure/recordSuccess` and the
`SnapshotManager` lifecycle have zero callers outside their own modules. VR.8/VR.9 are the
same shape on the realtime-terminal side (controllers/managers constructed but never given
their PTY / never round-tripping geometry).

### Implemented behaviors with no corresponding spec requirement (out-of-scope surface)

These are present in the implementation but are not demanded by any spec requirement. They
are recorded for traceability; none were treated as UNMET (nothing in scope depends on them)
and none were routed to `tasks.md`.

- `apps/api/src/terminal/backpressure.ts:175` — `BackpressureController.rebase()`: resets sent/acked counters to a seq offset after snapshot+tail-replay reconnect so the un-acknowledged total restarts from zero. No spec requirement for a rebase / reconnect counter reset.
- `apps/api/src/terminal/backpressure.ts:158` — `BackpressureController.reset()`: resumes the PTY and zeroes counters on client disconnect, preventing a wedged PTY pause from outliving the client. No spec requirement for client-disconnect backpressure cleanup.
- `apps/api/src/terminal/backpressure.ts:31` — Hysteresis low-water mark (`DEFAULT_LOW_WATER_MARK = HWM/2`): PTY resumes only below 250,000 bytes, not merely below 500,000. The spec requires resuming "after the client drains below it" (the HWM), not a separate low-water threshold.
- `apps/api/src/main.ts:52` — CORS / WS-origin allow-listing via `WEB_ORIGIN` (`enableCors` + `parseAllowedOrigins`): the api enforces a configurable cross-origin allow-list. No spec requires the api to perform CORS configuration; specs only require the web client to support cross-origin URLs.
- `apps/api/src/creds/session-credentials.service.ts:125` — Graceful-shutdown credential revocation via `OnModuleDestroy` / `enableShutdownHooks`: all session credentials destroyed on graceful process shutdown. No spec requirement addresses credential teardown on process shutdown (only on session end).
- `apps/api/src/terminal/terminal.gateway.ts:414` — `connect_auth` control frame handler: lets a non-browser client assert/re-assert operator auth via an explicit WS control frame after connect. No spec requirement mentions a `connect_auth` path or mid-connection re-authentication.
- `apps/api/src/terminal/terminal.gateway.ts:522` — `acquireLease()` public method on `TerminalGateway`: exposes an explicit lease-acquire path separate from heartbeat renewal. No spec defines an explicit acquire step (specs cover heartbeat renewal, expiry release, disconnect release, takeover).
- `apps/api/src/terminal/terminal.gateway.ts:248` — Pending-approval cleanup on runner disconnect: pending approvals blocked on a disconnected runner socket are dropped to prevent wedging. No spec requirement covers in-flight approval requests when the runner connection drops.
- `apps/api/src/guardrails/semaphore.ts:153` — `ConcurrencySemaphore.snapshotRunning()` / `snapshotQueue()`: inspection helpers returning defensive copies of running/queued task sets. No spec requirement covers diagnostic inspection of internal semaphore state.
- `apps/api/src/creds/session-credential.ts:73` — `SessionCredential.reveal()`: exposes raw secret material to callers for sandbox provisioning injection. No spec requirement specifies a reveal/read operation (specs cover provision, verify, destroy).
- `apps/api/src/creds/session-credential.ts:117` — `SessionCredential.toJSON()` override: prevents accidental secret serialization by returning a non-secret snapshot. No spec requirement mentions serialization safety guards on credential objects.
- `apps/api/src/tasks/tasks.service.ts:60` — `TasksService.issueTaskToken()`: a separate public method for re-issuing a TASK_TOKEN after creation. No spec requirement specifies a re-issue operation (spec only requires issuance at task creation).
- `apps/runner/src/startup-window.ts:47` — `StartupWindow` zero-exit-before-first-frame also reports agent-failed-to-start (not only non-zero exit). The spec scenario states only "exits with a non-zero status"; zero-exit-before-first-frame is treated as failure but not required.
- `apps/web/src/app/tasks/[id]/page.tsx:89` — Task-status polling loop (`setInterval` every 4s) on the session page to keep the displayed status fresh. No spec requirement specifies how/how often the session page refreshes task status.
- `apps/web/src/app/tasks/[id]/page.tsx:348` — `safeStringify` helper on the approval surface to render `toolInput` without crashing on non-serializable values. No spec requirement addresses error handling in approval-surface rendering.

---

## Second adversarial verify pass (three-way routing)

A second adversarial pass re-verified a 9-requirement sample across guardrails, monorepo-foundation,
agent-events-and-approvals, multi-target-deploy, realtime-terminal, write-lock-and-takeover,
runner-dialback-and-creds, and terminal-execution. Outcome: **6 MET**, **3 UNMET**, **0 SPEC-DEFECT**.
Every requirement in the sample is testable as written — the three failures are concrete
code/impl gaps or a broken validation boundary, none are requirement ambiguities.

### Routing summary (second pass)

| Destination | Count | Where |
| --- | --- | --- |
| MET | 6 | this section (evidence below) |
| UNMET (code problem) | 3 | `tasks.md` → VR.11–VR.13 (new `## Track: verify-reopened`) |
| SPEC-DEFECT (ambiguous requirement) | 0 | none — no `design.md` "Open Questions" entry added |

### UNMET findings routed to `tasks.md` (second pass)

- **VR.11 — "Wall-clock deadline force-fails a task" (guardrails)** — UNMET. Core logic is fully
  implemented and correctly structured (deadline-watcher arm/clear at `deadline-watcher.ts:82-116`;
  `onDeadlineExceeded → forceFail(taskId,'deadline')` wired at `guardrails.service.ts:74-75`;
  `forceFail()` transitions to `failed`, tears down sandbox, destroys creds + revokes TASK_TOKEN,
  releases the slot at `guardrails.service.ts:155-175`; `startRunning()` arms only when
  `deadlineMs !== undefined` at `:141-146`). Two gaps break it end-to-end: (GAP 1) the deadline is
  never armed — `tasks.service.ts:86` calls `admit(task.id)` with no `deadlineMs`, and
  `CreateTaskBody` (`packages/contracts/src/task.ts:110-123`) has no `deadline` field, so no task can
  ever carry a deadline; (GAP 2) the sandbox is never torn down — `docker-sandbox.provider.ts:51-54`
  `teardownSandbox()` is a documented no-op (the port method exists at `sandbox-provider.port.ts:69`
  but the sole concrete impl does nothing). The requirement is testable; the gaps are wiring/impl.

- **VR.12 — "contracts package is the single source of truth" (monorepo-foundation)** — UNMET. The
  "Apps consume contracts via workspace protocol" and "Schemas exported with inferred types"
  scenarios are MET (all three apps declare `@cap/contracts: workspace:*` —
  `apps/api/package.json:6`, `apps/web/package.json:12`, `apps/runner/package.json:9`; every contracts
  source pairs a ZodSchema with `export type X = z.infer<...>` — e.g. `sandbox.ts:12-17`,
  `approvals.ts:18-37`). The "No app re-declares a shared schema type that already exists in
  packages/contracts" scenario is VIOLATED: `apps/api/src/sandbox/sandbox-provider.port.ts:28`
  redeclares `export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'` as a
  local literal union, even though `packages/contracts/src/sandbox.ts:17` already exports the
  identical type. The port's own comment (lines 12-17) flags this as a tracked deferral; the runner
  port correctly imports from `@cap/contracts` (`apps/runner/src/sandbox/sandbox-provider.port.ts:1`).
  The `.mjs` test-file redefinitions are test-only (no TS transpile path) and are NOT production
  violations; the single api-side redeclaration is the in-scope violation.

- **VR.13 — "Persistent volume for session.log survives restart" (multi-target-deploy/realtime-terminal)** —
  UNMET. Infrastructure + file-contract layers are correct: `docker-compose.yml:38` (named volume
  `workspaces → /data/workspaces`) and `apps/api/fly.toml:27-29` (`[mounts]` `cap_api_data → /data`)
  declare persistent volumes; `apps/api/Dockerfile:51` sets `ENV WORKSPACES_DIR=/data/workspaces` with
  `VOLUME ["/data"]`; `apps/runner/src/session-log.ts:50` opens in `'a'` (append) mode and
  `task-entry.ts:138-140` uses `mkdir({recursive:true})`. The application path reads the WRONG env
  var: `apps/api/src/terminal/terminal.gateway.ts:980` reads `process.env.WORKSPACES_ROOT`, but no
  deploy config sets `WORKSPACES_ROOT` — only `WORKSPACES_DIR` is set (`docker-compose.yml:28`,
  `fly.toml:24`, `Dockerfile:51`). In production the gateway falls back to
  `path.resolve(process.cwd(), 'workspaces')` inside the ephemeral container layer, so `session.log`
  is written/read off-volume and does NOT survive a restart. Risk=high: data-mutating authoritative
  replay source, mismatch spans the deploy-config track and the realtime-terminal track.

### MET requirements (second pass, with evidence)

#### guardrails

**Circuit breaker on repeated start/turn failure** — MET
- Spec: `specs/guardrails/spec.md:36-46` (both scenarios defined).
- Core class: `apps/api/src/guardrails/circuit-breaker.ts:21` (`FailureKind` covers
  `agent_failed_to_start|turn_failure`); `:40-103` (`BreakerState` with `consecutiveFailures` +
  tripped latch; `recordFailure` increments and trips `onTrip` once when `>= threshold`, ignores
  post-trip calls); `:114-121` (`recordSuccess` resets the counter, no-op if already tripped).
- Integration wiring: `apps/api/src/guardrails/guardrails.service.ts:81-84` (`CircuitBreaker`
  constructed with `onTrip → forceFail(taskId,'circuit_breaker')`); `:109-115`
  (`recordFailure`/`recordSuccess` delegate); `:155-175` (`forceFail`: transition→failed, sandbox
  teardown, credential destroy, slot release — no retry path).
- Config: `apps/api/src/guardrails/guardrails.module.ts:61-65` (`circuitBreakerThreshold` from
  `CIRCUIT_BREAKER_THRESHOLD`, default 3 at `guardrails.service.ts:45`).
- Failure call site: `apps/api/src/tasks/tasks.service.ts:181` (`markAgentFailedToStart` calls
  `guardrails.recordFailure(id,'agent_failed_to_start')`).
- Success-reset call site: `apps/api/src/terminal/terminal.gateway.ts:519-521` (successful dialback
  handshake calls `guardrails.recordSuccess`).
- Risk=high: spans guardrails + tasks-service + terminal-gateway tracks; mutates task status to
  failed; prevents provider-quota burn (security-relevant guardrail).

#### agent-events-and-approvals

**Blocking hook forwards the approval round-trip** — MET
- `apps/runner/hooks.json:6,12` — `PreToolUse` and `PermissionRequest` both set `"blocking":true`
  pointing to `permission-request.hook.js`.
- `apps/runner/src/hooks/permission-request.hook.ts:97` — `await transport.requestDecision(event)`
  blocks the hook until the orchestrator returns a decision; `:145-146`
  `stdout.write(JSON.stringify(envelope))` prints the `{decision}` JSON for Codex after the
  round-trip resolves.
- `packages/contracts/src/approvals.ts:18` — `DecisionBehaviorSchema = z.enum(['allow','deny'])`
  constrains behavior to exactly two literals.
- `apps/runner/src/hooks/blocking-hook-roundtrip.test.mjs:218,224` — T1a/T1b verify the hook blocks
  until the transport resolves; all 19 tests pass at runtime.

#### multi-target-deploy

(Note: the "Persistent volume for session.log survives restart" requirement is UNMET this pass —
see VR.13 above. The earlier first-pass catalogue listed it MET on the infra layer only; this pass
traced the application read path and found the `WORKSPACES_ROOT` vs `WORKSPACES_DIR` mismatch.)

#### realtime-terminal

**Server-side backpressure with bounded high-water mark** — MET
- `packages/contracts/src/ws-frames.ts:83` — `HIGH_WATER_MARK_BYTES = 500_000` (authoritative
  constant); `apps/api/src/terminal/backpressure.ts:23` — `DEFAULT_HIGH_WATER_MARK =
  HIGH_WATER_MARK_BYTES`; `:77-80` constructor rejects `highWaterMark > 500_000`.
- `backpressure.ts:120-124` — `onSent()` calls `pty.pause()` and returns `'pause'` when
  `unacknowledgedBytes >= highWaterMark`; `:145-149` — `onAck()` calls `pty.resume()` and returns
  `'resume'` when `unacknowledgedBytes < lowWaterMark` while paused.
- `apps/api/src/terminal/terminal.gateway.ts:740-742` — `streamRawChunk()` feeds `onSent()` after
  every raw frame; `:706-708` — ack handler feeds `onAck()`; `:826-831` — `attachPty()` wires the
  real PTY via `setPty()` (closes the earlier VR.9 gap, so pause/resume are no longer no-ops);
  `:276-278` — `handleDisconnect()` calls `backpressure.reset()` to prevent a wedged pause.
- `test-ack-pause-resume.mjs` — 25/25 assertions pass at runtime. Risk=high: backpressure state
  mutated from the PTY-data callback, the inbound-ack handler, and the disconnect path
  (multi-path data-mutating code).

#### write-lock-and-takeover

**Preemptive takeover** — MET
- Spec: `specs/write-lock-and-takeover/spec.md:33-39` ("Preemptive takeover" with scenario "Reader
  takes over from current writer").
- Service state machine: `apps/api/src/write-lock/write-lock.service.ts:119-132` — `takeover()`
  unconditionally overwrites the lease via `#grant()`, sets `previousHolder = current.writerClientId`
  when a different client holds the lease (null for self-takeover/empty session), and emits
  `LeaseOutcome.TakenOver` vs `Acquired` accordingly. Demotion enforced at `:154-157` (`isWriter()`
  returns false for the old writerClientId after the map entry is overwritten).
- Gateway wire-up: `apps/api/src/terminal/terminal.gateway.ts:590-598` — `onTakeover()` handles the
  `takeover_request` frame, calls `writeLock.takeover(frame.sessionId, state.clientId)`, broadcasts
  the updated lease. Keystroke gate at `:564-572` calls `writeLock.isWriter()` — demoted client fails
  the check and keystrokes are silently dropped.
- Contract frame: `packages/contracts/src/write-lock-frames.ts:75-82` (`TakeoverRequestFrameSchema`).
- Web client: `apps/web/src/lib/ws-client.ts:185-194` (`sendTakeover()` emits the frame).
- Tests: `test-preemptive-takeover.mjs` — 21/21 assertions pass (seize-from-live-holder, demotion
  enforced, no-holder→Acquired, self-takeover, demoted-holder-denied-on-reacquire, chained takeovers).
- Risk=high: mutates the shared in-memory leases Map; security-sensitive (any authenticated operator
  can preempt any other operator's lease); touched by the keystroke gate (7.5), heartbeat renewal
  (7.2), auto-release on disconnect (7.3), and approval routing (6.5) on the same `WriteLockService`.

#### runner-dialback-and-creds

**Ephemeral credentials destroyed with the session** — MET
- Spec: `specs/runner-dialback-and-creds/spec.md:33-43` (two scenarios; both implemented).
- "Credentials are revoked at session end": `SessionCredential.destroy()` zeroes the secret at
  `apps/api/src/creds/session-credential.ts:98-101`; `SessionCredentialsService.destroyForSession()`
  removes the entry from the in-memory Map at `session-credentials.service.ts:98-106`.
  `GuardrailsService.teardownSession()` calls `destroyForSession()` at `guardrails.service.ts:188-191`,
  invoked on both the happy path (`onTerminal` at `:126`) and forced-failure paths (`forceFail` at
  `:173`). `TasksService.transition()` triggers `guardrails.onTerminal()` for every terminal state at
  `apps/api/src/tasks/tasks.service.ts:149-157`; `markAgentFailedToStart()` does the same at `:186-193`.
  NestJS shutdown hook `onModuleDestroy()` calls `destroyAll('teardown')` at
  `session-credentials.service.ts:125-127`.
- "Credentials are scoped to the session": private in-process Map (`session-credentials.service.ts:37`);
  `provisionForSession()` enforces the single-session invariant (`:49-59`); `toJSON()` never exposes
  the secret (`session-credential.ts:117-119`); secrets use `randomBytes(32)` (`:126`).
- Test coverage: `test-ephemeral-creds-destroyed-with-session.mjs` exercises all 8 scenarios against
  compiled `apps/api/dist/creds/`. Risk=high: security-sensitive credential lifecycle wired across
  three tracks (tasks lifecycle, guardrails, creds); a regression in any one call site (`onTerminal`,
  `forceFail`, or `markAgentFailedToStart`) would silently leak credentials.
- (Note: this MET result reflects the now-wired natural-completion path — `transition() → onTerminal()`
  at `tasks.service.ts:149-157` — which closes the earlier first-pass VR.5 dead-code gap.)

#### terminal-execution

**session.log is the byte source of truth** — MET
- Spec: `specs/terminal-execution/spec.md:23-35` (two scenarios: PTY output appended in emission
  order; session.log append-only).
- Write path (Track 4): `apps/runner/src/session-log.ts:50` — `open(logPath,'a')` guarantees
  append-only (never truncates); `:60-63` — `append(bytes)` calls `this.stream.write(bytes)` verbatim;
  `apps/runner/src/task-entry.ts:157` — `SessionLog.open(workspaceDir)` opened before PTY spawn (no
  byte dropped); `:182-187` — `pty.onData((bytes) => { sessionLog.append(bytes);
  startupWindow.noteFirstFrame(); })` appends every byte in emission order; `:139` —
  `mkdir({recursive:true})` preserves any existing session.log.
- Read path (Track 5): `apps/api/src/terminal/snapshot.ts:29,105` — `SESSION_LOG_FILENAME =
  'session.log'`; `readTailFrames()` reads via `createReadStream` (never writes);
  `apps/api/src/terminal/terminal.gateway.ts:878-879` — feeds decoded bytes to `SnapshotManager.feed()`
  to keep the byte-offset in sync.
- Risk=high: touched by Track 4 (runner write) + Track 5 (snapshot/tail-replay read) + Track 5
  frontend (`apps/web/src/app/tasks/[id]/page.tsx:64,165`); terminal output is security-sensitive
  (may contain credentials); append-only data-mutating writes.

### Gap / scope analysis (second pass)

**Coverage.** Re-analysis of all 12 spec files against the implementation confirms there are NO
requirements with zero traceable implementation. Every named requirement maps to at least one file
with code implementing or scaffolding it (agent-events-and-approvals → `runner/src/hooks/`,
`runner/src/notify/`, Dockerfile; frontend-console → `apps/web/src/`; guardrails →
`apps/api/src/guardrails/`; monorepo-foundation → workspace structure + tsconfig + settings.json hooks
+ husky; multi-target-deploy → fly.toml, docker-compose.yml, vercel.json; realtime-terminal →
`terminal.gateway.ts`, `backpressure.ts`, `snapshot.ts`; repo-and-task-management →
`apps/api/src/repos/`, `tasks/`, `prisma/`; runner-dialback-and-creds → `runner/src/dialback/`,
`apps/api/src/creds/`; sandbox-provider-port → `apps/api/src/sandbox/`, `apps/runner/src/sandbox/`;
single-user-auth → `apps/api/src/auth/`, `main.ts` boot check; terminal-execution →
`apps/runner/src/pty/`, `session-log.ts`, `task-entry.ts`; write-lock-and-takeover →
`apps/api/src/write-lock/`). No missing-implementation finding to route.

**Scope creep (implemented behaviors with no corresponding spec requirement).** The following were
found in the implementation but are not demanded by any spec requirement. They are recorded for
traceability; none are UNMET (nothing in scope depends on them) and none were routed to `tasks.md`.

- CORS / WS-origin allowlisting via `WEB_ORIGIN` — no spec requires an api-side origin allowlist for
  the cross-origin Vercel web target. `apps/api/src/main.ts:52-58`.
- Comma-separated `WEB_ORIGIN` parsing with de-duplication in `parseAllowedOrigins()`. `apps/api/src/main.ts:68-78`.
- `NullHeadlessTerminal` no-op headless-xterm stub used when `@xterm/headless` is unavailable — specs
  require a real SerializeAddon snapshot; this is an unspecified fallback. `apps/api/src/terminal/terminal.gateway.ts:85-98`.
- `RunnerPtyProxy` wrapping the runner dial-back WS as a `TerminalPty` to forward keystrokes/resize/
  flow-control to the runner — no spec defines relaying operator input back over the same WS. `apps/api/src/terminal/terminal.gateway.ts:994-1049`.
- `BackpressureController.rebase()` — rebases counters after snapshot+tail-replay reconnect. `apps/api/src/terminal/backpressure.ts:185-195`.
- `BackpressureController.reset()` — resets/resumes the PTY on client disconnect to prevent a wedged pause. `apps/api/src/terminal/backpressure.ts:158-165`.
- `BackpressureController.setPty()` — late-binding PTY injection after the session is known. `apps/api/src/terminal/backpressure.ts:173-175`.
- `SnapshotManager.resizeHeadless()` — updates headless geometry on browser resize. `apps/api/src/terminal/snapshot.ts:158-161`.
- Hysteresis low-water mark at half the HWM (250,000 bytes) — specs define only the 500,000-byte HWM. `apps/api/src/terminal/backpressure.ts:31`.
- `TerminalGateway.acquireLease()` — explicit lease acquisition from outside the gateway. `apps/api/src/terminal/terminal.gateway.ts:604-609`.
- `TerminalGateway.onConnectAuth()` — post-connect re-authentication via a `connect_auth` control frame. `apps/api/src/terminal/terminal.gateway.ts:467-483`.
- Eager live-stream of raw PTY bytes to operators who connected but have not yet called `reconnect`/`attachPty`. `apps/api/src/terminal/terminal.gateway.ts:896-907`.
- `ConcurrencySemaphore.snapshotRunning()` / `snapshotQueue()` diagnostic accessors. `apps/api/src/guardrails/semaphore.ts:153-160`.
- `ConcurrencySemaphore.release()` dropping a queued-but-not-running task from the backlog (cancelled-before-run case). `apps/api/src/guardrails/semaphore.ts:118-128`.
- `IdleTracker` re-arm for remaining time when a stale timer fires after a reset (timer-race guard). `apps/api/src/guardrails/idle-tracker.ts:162-173`.
- `GuardrailsService.sandboxMode()` diagnostic inspector. `apps/api/src/guardrails/guardrails.service.ts:223-225`.
- `DeadlineWatcher.armAfter()` duration-based convenience (specs describe absolute wall-clock deadlines). `apps/api/src/guardrails/deadline-watcher.ts:99-101`.
- `DeadlineWatcher.watchedCount` / `isWatching()` inspectors. `apps/api/src/guardrails/deadline-watcher.ts:65-68`.
- `WriteLockService.acquire()` returning a `demotedClientId` on expiry-based replacement. `apps/api/src/write-lock/write-lock.service.ts:66-88`.
- `SessionCredentialsService.snapshot()` returning non-secret snapshots for logging/metrics. `apps/api/src/creds/session-credentials.service.ts:109-111`.
- `SessionCredential.toJSON()` override preventing accidental secret serialization. `apps/api/src/creds/session-credential.ts:117-119`.
- `SessionCredential.reveal()` exposing secret material to sandbox-provisioning callers. `apps/api/src/creds/session-credential.ts:73-82`.
- Hooks-level fail-closed: empty decision set resolves to `deny` in `resolveDecisions()` (specs define any-deny-wins only for non-empty sets). `apps/runner/src/hooks/resolve-decision.ts:22-24`.
- `parsePorcelainPaths()` deprecated shim on `post-tool-use.hook.ts`. `apps/runner/src/hooks/post-tool-use.hook.ts:123-125`.
- `DialBackClient.send()` refusing to transmit before the handshake frame is written (programmatic invariant enforcement). `apps/runner/src/dialback/dialback-client.ts:193-197`.
- `DialBackClient.onControl` validating/dispatching inbound orchestrator control frames (resize/pause/resume) over the dial-back socket. `apps/runner/src/dialback/dialback-client.ts:159-166`.
- `getClientId()` persisting a stable per-tab identity in `sessionStorage` across soft reconnects (specs require per-client ids but not the persistence/fallback strategy). `apps/web/src/lib/client-id.ts:1-23`.
- `TasksService.issueTaskToken()` re-issuing a TASK_TOKEN on demand (spec requires minting at creation only). `apps/api/src/tasks/tasks.service.ts:103-105`.
- `AUTH_TOKEN_PUBLIC_ENV_VAR` (`NEXT_PUBLIC_AUTH_TOKEN`) exposing the operator token to the browser bundle. `packages/contracts/src/auth.ts:32`.
- `SANDBOX_MODES` ordered constant array on the api sandbox port. `apps/api/src/sandbox/sandbox-provider.port.ts:35-39`.
- `sandboxModeArgs()` mapping a `SandboxMode` to `['--sandbox', mode]` CLI tokens in the runner sandbox port. `apps/runner/src/sandbox/sandbox-provider.port.ts:41-43`.

---

## Third adversarial verify pass (three-way routing)

A third adversarial pass re-verified a 6-requirement sample across guardrails, monorepo-foundation,
realtime-terminal, and runner-dialback-and-creds. Outcome: **5 MET**, **1 UNMET**, **0 SPEC-DEFECT**.
Every requirement in the sample is testable as written — the single failure is a concrete dead-code
wiring gap (the last hop of the terminal-geometry round-trip), not a requirement ambiguity.

### Routing summary (third pass)

| Destination | Count | Where |
| --- | --- | --- |
| MET | 5 | this section (evidence below) |
| UNMET (code problem) | 1 | `tasks.md` → VR.14 (new `## Track: verify-reopened`) |
| SPEC-DEFECT (ambiguous requirement) | 0 | none — no `design.md` "Open Questions" entry added |

### UNMET finding routed to `tasks.md` (third pass)

- **VR.14 — "Live-frame parity under PTY parity conditions" (realtime-terminal/runner-dialback-and-creds/frontend-console)** —
  UNMET. `TERM=xterm-256color` is correctly enforced on the PTY side (`apps/runner/src/pty/spawn-codex.ts:84`
  `name:'xterm-256color'`; `:129` `TERM` pinned last in `buildPtyEnv`). The VR.8 geometry round-trip was
  partially wired: `ResizeFrame` defined (`packages/contracts/src/snapshot-frames.ts:78-86`); browser fires
  `onResize` (`packages/ui/src/terminal/terminal.tsx:146-148`) wired through the session page
  (`apps/web/src/app/tasks/[id]/page.tsx:222-227,297`) → `ws-client.ts:216-224` `sendResize()` →
  `terminal.gateway.ts:432-433` (dispatch) → `:844-853` `onResize() → session.pty.resize()` →
  `RunnerPtyProxy.resize()` (`:1029-1037`, forwards a `ResizeFrame` control frame over the runner WS) →
  `DialBackClient.onControl` (`apps/runner/src/dialback/dialback-client.ts:159-166`, validates + dispatches
  inbound resize). The LAST hop is dead code: `DialBackClient.onControl` has no concrete wiring to
  `CodexPtyHandle.resize()` (`apps/runner/src/pty/spawn-codex.ts:104`), and `apps/runner/src/task-entry.ts`
  never instantiates `DialBackClient` at all — the `onControl` callback is optional and never provided. The
  runner PTY stays at its spawn default 80x24 regardless of browser resize, so the "identical cols and rows"
  parity precondition is unreachable at runtime and live-frame byte-identity is not guaranteed. The
  requirement is testable as written (it states observable `TERM`/geometry conditions); the gap is a wiring
  defect. Risk=high: spans realtime-terminal (gateway/backpressure/snapshot), runner-dialback-and-creds
  (`DialBackClient`), and frontend-console (`page.tsx`, `ws-client.ts`, `packages/ui` terminal); the
  requirement concerns byte-level fidelity of terminal output (data-integrity sensitive).

### MET requirements (third pass, with evidence)

#### guardrails

**Wall-clock deadline force-fails a task** — MET
- Spec: `specs/guardrails/spec.md:14-19` ("Wall-clock deadline force-fails a task"). Full trace for the
  primary scenario (task admitted directly as running):
  1. Contract: `packages/contracts/src/task.ts:120` — `deadlineMs: z.number().int().positive().optional()`
     on `CreateTaskRequestSchema` (closes the VR.11 GAP 1 missing-deadline-field gap).
  2. Plumbing: `apps/api/src/tasks/tasks.service.ts:88` — `this.guardrails.admit(task.id, body.deadlineMs)`
     passes the deadline through on task creation.
  3. Admission: `apps/api/src/guardrails/guardrails.service.ts:93-96` — `admit()` calls
     `startRunning(taskId, deadlineMs)` when the semaphore grants a running slot immediately.
  4. Arm: `:141-146` — `startRunning()` calls `this.deadlines.armAfter(taskId, deadlineMs)` when
     `deadlineMs !== undefined`.
  5. Timer: `apps/api/src/guardrails/deadline-watcher.ts:99-101,82-92` — `armAfter` delegates to `arm()`,
     which sets `setTimeout` and on fire deletes the watch entry then calls `onDeadlineExceeded`.
  6. Callback wiring: `guardrails.service.ts:74-75` — `onDeadlineExceeded: (taskId) => void
     this.forceFail(taskId, 'deadline')`.
  7. Force-fail: `:155-175` — `forceFail()` calls `safeTransition(taskId,'failed')` (DB write),
     `sandbox.teardownSandbox(taskId)` (port-level, documented no-op in the Docker placeholder per D9 — see
     the design.md "Open Questions" spec-defect note), `teardownSession` (destroys creds + revokes
     TASK_TOKEN), then `semaphore.release(taskId)` (frees the slot).
- "Task finishing before deadline is unaffected": `guardrails.service.ts:124-128` — `onTerminal()` calls
  `clearTimers(taskId) → deadlines.clear(taskId)` (`deadline-watcher.ts:109-116`) which cancels the timer.
- Noted partial gap (does NOT affect the spec scenario): `guardrails.service.ts:136-138` — the `onAdmit`
  callback for a previously-queued task calls `startRunning(taskId)` WITHOUT `deadlineMs`, because the
  semaphore's `AdmitCallback` is typed `(taskId: string) => void` (`semaphore.ts:18`) and does not carry
  the deadline. A task initially queued and later admitted never arms its deadline. This is a correctness
  gap on the deferred-admission path only; the scenario as written presupposes a running task and is MET.
- Risk=high: `forceFail` is data-mutating (DB status write), security-sensitive (credential destruction +
  token revocation), and is the convergence point for three guardrail subsystems (deadline, idle,
  circuit-breaker) plus the sandbox-provider port.

**Circuit breaker on repeated start/turn failure** — MET
- Spec: `specs/guardrails/spec.md:36-46` (two scenarios: threshold trips to `failed`; success resets the
  counter).
- Core class: `apps/api/src/guardrails/circuit-breaker.ts:21` (`FailureKind` covers
  `agent_failed_to_start|turn_failure`); `:83-103` (`recordFailure` increments `consecutiveFailures`, trips
  `onTrip` once when `>= threshold` at `:94-98`, latches to ignore post-trip calls); `:114-121`
  (`recordSuccess` resets the counter, no-op if already tripped).
- Service integration: `guardrails.service.ts:81-84` (`CircuitBreaker` constructed with
  `onTrip → forceFail(taskId,'circuit_breaker')`); `:109-114` (`recordFailure`/`recordSuccess` delegate);
  `:155-175` (`forceFail` transitions to `failed`, sandbox teardown, creds destroy, slot release — no retry
  path).
- Config: `guardrails.module.ts:61-65` (`circuitBreakerThreshold` from `CIRCUIT_BREAKER_THRESHOLD`, default
  3 at `guardrails.service.ts:45`).
- Failure call site (VR.4 fix): `apps/api/src/tasks/tasks.service.ts:181-184`
  (`markAgentFailedToStart` calls `guardrails.recordFailure(id,'agent_failed_to_start')`).
- Success-reset call site (VR.4 fix): `apps/api/src/terminal/terminal.gateway.ts:519-521` (successful
  dial-back handshake calls `guardrails.recordSuccess(frame.taskId)`).
- Risk=high: spans guardrails + tasks-service + terminal-gateway tracks; mutates task status to `failed`;
  security-sensitive guardrail preventing quota-burn loops. (Independently confirmed MET in the second pass
  at this report's lines 327-344; re-confirmed here against the same call sites.)

#### monorepo-foundation

**contracts package is the single source of truth** — MET
- Spec scenarios: `specs/monorepo-foundation/spec.md:15-26`.
- SCENARIO 1 — `workspace:*` in all three apps: MET. `apps/api/package.json:20`, `apps/web/package.json:15`,
  `apps/runner/package.json:13` each declare `"@cap/contracts": "workspace:*"`.
- SCENARIO 2 — schemas exported with inferred types: MET. `packages/contracts/src/task.ts:15-24`
  (`TaskStatusSchema` z.enum + `TaskStatus` z.infer); `approvals.ts:18-37`
  (`DecisionBehaviorSchema`/`DecisionSchema` + inferred types); `sandbox.ts:12-17` (`SandboxModeSchema` +
  `SandboxMode`); `control-frame.ts:30-63` (`ControlFrameSchema`/`WsFrameSchema` + types); `dist/index.d.ts:8-17`
  (compiled `.d.ts` fully built).
- SCENARIO 3 — no app re-declares a shared shape: MET (after the VR.6 + VR.12 fixes landed in baseline).
  `apps/api/src/sandbox/sandbox-provider.port.ts:1,25` imports `SandboxMode` from `@cap/contracts` and
  re-exports via `export type { SandboxMode }` — NOT a local redeclaration (closes the VR.12 violation).
  `apps/runner/src/hooks/contract.ts` and `apps/runner/src/notify/contract.ts` carry comments noting the
  previous local mirrors were removed (VR.6) and now re-export from `@cap/contracts`. A `z.enum`/`z.object`
  grep across `apps/**/*.ts` returns zero local schema declarations in app source.
- Risk=high: `packages/contracts` is the `depends: none` root; `design.md:90` routes all contracts edits to
  a serial integration track because edits propagate to api, web, and runner simultaneously; `proposal.md:42`
  confirms the multi-track dependency.

#### realtime-terminal

**Server-side backpressure with bounded high-water mark** — MET
- `packages/contracts/src/ws-frames.ts:83` — `HIGH_WATER_MARK_BYTES = 500_000` (canonical protocol
  constant); `apps/api/src/terminal/backpressure.ts:16-23` — `BackpressureController` imports and defaults to
  `HIGH_WATER_MARK_BYTES`; `:77` — constructor enforces `high <= HIGH_WATER_MARK_BYTES` with a `RangeError`;
  `:120-124` — `onSent()` calls `pty.pause()` and returns `'pause'` when `unacknowledgedBytes >=
  highWaterMark`; `:143-148` — `onAck()` calls `pty.resume()` when the drain crosses below `lowWaterMark`.
- Gateway integration: `apps/api/src/terminal/terminal.gateway.ts:238` (`new BackpressureController()` per
  client); `:740` (`streamRawChunk` calls `state.backpressure.onSent(state.sentBytes)` each raw frame);
  `:707` (ack handler calls `state.backpressure.onAck(frame.seq)`); `:828` (`attachPty` wires the real PTY
  via `state.backpressure.setPty(session.pty)` — closes the earlier VR.9 no-op gap).
- `test-backpressure-bounded-hwm.mjs` — 19/19 scenarios pass.
- Risk=high: the gateway is a multi-track integration point (tracks 5/6/7/8/11) and the feature mutates
  per-client PTY pause state.

#### runner-dialback-and-creds

**Ephemeral credentials destroyed with the session** — MET
- `apps/api/src/creds/session-credential.ts:48-99` — secret is private, null-zeroed on destroy, `toJSON`
  hides the secret.
- `apps/api/src/creds/session-credentials.service.ts:37,98-106,118-127` — in-memory Map only;
  `destroyForSession` zeroes + deletes; `destroyAll` on `onModuleDestroy`.
- `apps/api/src/guardrails/guardrails.service.ts:124-129,155-175,188-191` — `teardownSession` calls
  `creds.destroyForSession` on BOTH the natural-terminal path (`onTerminal`) and all forced-failure paths
  (`forceFail`).
- `apps/api/src/tasks/tasks.service.ts:146-159,186-197` (VR.5 fix) — `transition()` and
  `markAgentFailedToStart()` call `guardrails.onTerminal()` on every terminal state, closing the earlier
  VR.5 natural-completion dead-code gap.
- `test-ephemeral-creds-destroyed-with-session.mjs:66-168` — 8 scenarios verify revocation, isolation,
  `destroyAll`, and the duplicate-provision guard.
- Risk=high: security-sensitive primary safety boundary; touched by tracks 8/12/14; mutates in-memory
  credential state.

### Gap / scope analysis (third pass)

**Missing-implementation coverage.** Re-analysis of all 12 spec files against the implementation confirms,
for a third time, that there are NO requirements with zero traceable implementation. Every named requirement
across `agent-events-and-approvals`, `frontend-console`, `guardrails`, `monorepo-foundation`,
`multi-target-deploy`, `realtime-terminal`, `repo-and-task-management`, `runner-dialback-and-creds`,
`sandbox-provider-port`, `single-user-auth`, `terminal-execution`, and `write-lock-and-takeover` maps to at
least some code (the question is implementation correctness/wiring, not total absence). No missing-feature
finding to route — the sole UNMET (VR.14) is a dead-code wiring gap on an existing path, not an unbuilt
requirement.

**Scope creep (implemented behaviors with no corresponding spec requirement).** The third pass surfaced no
NEW out-of-scope behaviors beyond those already catalogued in the first and second passes above. The
following are re-confirmed as present-but-unspecced (recorded for traceability only; none are UNMET — nothing
in scope depends on them — and none were routed to `tasks.md`):

- `ResizeFrame` / terminal-geometry sync (VR.8): `packages/contracts/src/snapshot-frames.ts:70`,
  `apps/api/src/terminal/terminal.gateway.ts:844-854`, `apps/web/src/lib/ws-client.ts:216-224`,
  `apps/web/src/app/tasks/[id]/page.tsx:222-227`. The realtime-terminal spec only requires byte-parity
  "under identical cols and rows" as a precondition; no requirement mandates a `resize` control frame or
  that the orchestrator forward geometry changes to the runner PTY. (NB: VR.14 reopens the *wiring* of this
  same path — the feature exists but its last hop is dead; the feature itself remains unspecced surface.)
- In-band `ConnectAuthFrame` fallback for non-browser WS clients: `packages/contracts/src/auth.ts:65`,
  `apps/api/src/terminal/terminal.gateway.ts:467-483`. The single-user-auth spec requires connect-time WS
  auth via header/query param; no requirement covers an in-band `connect_auth` frame.
- `SANDBOX_MODES` ordered comparative array on the api sandbox port: `apps/api/src/sandbox/sandbox-provider.port.ts:32`.
  The sandbox-provider-port spec only requires the port to expose mode values, not an ordered array.
- `parsePorcelainPaths` deprecated backward-compat export: `apps/runner/src/hooks/post-tool-use.hook.ts:123`.
- `NullHeadlessTerminal` stub used when `@xterm/headless` is unavailable: `apps/api/src/terminal/terminal.gateway.ts:85`.
  The spec requires a real `SerializeAddon` snapshot; the stub is an unspecced fallback.
- Legacy `WORKSPACES_ROOT` env-var fallback: `apps/api/src/terminal/terminal.gateway.ts:985`. The
  multi-target-deploy spec only specifies `WORKSPACES_DIR`. (NB: this same mismatch is the VR.13 defect — the
  fallback path is both unspecced AND wrong-var.)
- Optional `branch` and `strategy` fields on `CreateTaskRequest`: `packages/contracts/src/task.ts:113`. The
  repo-and-task-management spec only requires `prompt`/`repoId`/`status`/`createdAt`.
- Dashboard 5s auto-poll: `apps/web/src/app/page.tsx:57`. The frontend-console spec requires listing tasks
  with status but does not mandate auto-refresh.
- Session-page 4s task-status auto-poll: `apps/web/src/app/tasks/[id]/page.tsx:89`. No spec requires periodic
  REST polling on the session page.
- `LeaseResult`/`LeaseOutcome` typed return union (`Acquired`/`Renewed`/`TakenOver`/`Denied`) from
  `WriteLockService`: `apps/api/src/write-lock/write-lock.types.ts:50`. The write-lock spec describes
  behavioral outcomes, not a typed result union.
- `acquireLease()` public method on `TerminalGateway`: `apps/api/src/terminal/terminal.gateway.ts:604`. The
  spec describes single-writer/multi-reader semantics, not an explicit acquire API separate from connect-time
  grant.
- Array-of-decisions contributing response shape (`toContributingDecisions`) in the permission-request hook:
  `apps/runner/src/hooks/permission-request.hook.ts:52`. The agent-events spec defines a single `Decision`
  contract; no requirement mandates multi-decision aggregation from the orchestrator response.

## MET requirements (fourth pass — three-way routing re-verification)

This pass re-verified five requirements that prior passes had re-opened as UNMET (VR.1–VR.14).
After the baseline wiring fixes landed, all five trace end-to-end and are classified **MET**.
Each carries a documented minor/partial gap that does NOT block the primary spec scenario; none
rose to SPEC-DEFECT (no ambiguous/untestable/contradictory requirement language), and none remain
UNMET (no broken wiring blocks the requirement's primary scenario). Consequently this pass added
**no** `verify-reopened` task to `tasks.md` and **no** `design.md` "Open Questions" note.

### guardrails

**Wall-clock deadline force-fails a task** — MET
- Spec: `specs/guardrails/spec.md:14-19` (two scenarios). Full end-to-end chain verified:
  1. Contract field — `packages/contracts/src/task.ts:120`: `deadlineMs: z.number().int().positive().optional()` on `CreateTaskRequestSchema`.
  2. Plumbing — `apps/api/src/tasks/tasks.service.ts:88`: `this.guardrails.admit(task.id, body.deadlineMs)` passes the deadline through on task creation.
  3. Admission — `apps/api/src/guardrails/guardrails.service.ts:93-96`: `admit()` calls `startRunning(taskId, deadlineMs)` when the semaphore grants a slot immediately.
  4. Arm — `guardrails.service.ts:141-146`: `startRunning()` calls `this.deadlines.armAfter(taskId, deadlineMs)` when `deadlineMs` is defined.
  5. Timer — `apps/api/src/guardrails/deadline-watcher.ts:82-92,99-101`: `armAfter → arm()` sets a `setTimeout`; on fire it deletes the watch entry and calls `onDeadlineExceeded` exactly once.
  6. Callback wiring — `guardrails.service.ts:74-75`: `onDeadlineExceeded: (taskId) => void this.forceFail(taskId, 'deadline')`.
  7. Force-fail — `guardrails.service.ts:155-175`: `forceFail()` calls `safeTransition(taskId,'failed')` (DB write), `sandbox.teardownSandbox(taskId)` (port-level; documented no-op in the Docker placeholder per D9), `teardownSession()` (creds destroy + TASK_TOKEN revoke), then `semaphore.release(taskId)` (slot freed).
  8. Lifecycle guard — `apps/api/src/tasks/task-lifecycle.ts:39`: `running -> failed` is a legal edge; `failed` is in `TERMINAL_STATUSES` (`task-lifecycle.ts:16-20`) with no outgoing transitions.
  9. Cancel path — `guardrails.service.ts:124-128`: `onTerminal()` calls `clearTimers → deadlines.clear(taskId)` (`deadline-watcher.ts:109-116`) to cancel the timer when a task settles before its deadline (satisfies the "finishing before its deadline is unaffected" scenario).
- Documented minor gap (does NOT affect the primary spec scenario): `guardrails.service.ts:136-138` — the `onAdmit` callback for a previously-queued task calls `startRunning(taskId)` WITHOUT `deadlineMs` (the semaphore `AdmitCallback` is typed `(taskId: string) => void` at `semaphore.ts:18`, so the deadline is not propagated). A task initially queued then later admitted never arms its deadline. The spec scenario as written presupposes an already-running task and is met.
- Risk=high: `forceFail` is data-mutating (DB status write via `tasks.service.ts:139-143`), security-sensitive (creds destroy + token revoke via `guardrails.service.ts:188-191`), and is the convergence point for three guardrail subsystems (deadline, idle, circuit-breaker) plus the sandbox-provider port — spans guardrails, tasks, creds, and sandbox tracks.

**Circuit breaker on repeated start/turn failure** — MET
- Spec: `specs/guardrails/spec.md:36-46` (both scenarios). Core implementation: `apps/api/src/guardrails/circuit-breaker.ts:83-103` (`recordFailure` increments the counter, trips at threshold, latches), `:114-121` (`recordSuccess` resets the counter, no-op if already tripped).
- Integration wiring: `apps/api/src/guardrails/guardrails.service.ts:81-84` (`CircuitBreaker` constructed with `onTrip -> forceFail`), `:155-175` (`forceFail` transitions to `failed`, tears down sandbox, destroys creds, releases slot — no auto-retry).
- Call sites: `recordFailure` at `apps/api/src/tasks/tasks.service.ts:183` (`markAgentFailedToStart`); `recordSuccess` at `apps/api/src/terminal/terminal.gateway.ts:520` (successful dialback handshake).
- Config: `apps/api/src/guardrails/guardrails.module.ts:62` (`CIRCUIT_BREAKER_THRESHOLD` env var, default 3). All 27 unit tests pass.
- Documented minor gap: the `turn_failure` `FailureKind` is typed and unit-tested but has no production call site — only `agent_failed_to_start` is emitted. The requirement is substantively met for the `agent_failed_to_start` path (both scenarios are satisfiable through it).
- Risk=high: touches DB status writes, credential teardown, and concurrency-slot release, and is used by `GuardrailsModule`, `TasksModule`, and `TerminalModule` simultaneously.

### monorepo-foundation

**contracts package is the single source of truth** — MET
- Spec: `specs/monorepo-foundation/spec.md:15-25` — requires `workspace:*` deps and no local re-declarations. All four scenarios confirmed:
  1. `workspace:*` protocol — `apps/api/package.json:16`, `apps/web/package.json:16`, `apps/runner/package.json:16` all declare `"@cap/contracts": "workspace:*"`.
  2. Schemas exported with inferred types — `packages/contracts/src/index.ts:1-38` is the single entry point; every module exports both a `ZodSchema` and its `z.infer<>` type alias (confirmed across `task.ts:15-24`, `approvals.ts:19-106`, `ws-frames.ts:40-77`).
  3. No app re-declares shared shapes — a grep of `apps/` for local `z.object`/`z.enum` definitions in `src` returns zero hits. `apps/runner/src/hooks/contract.ts:8` notes the local mirrors were removed (VR.6) and re-exports only from `@cap/contracts`; `apps/api/src/repos/zod-validation.pipe.ts:2` uses `ZodSchema` only as a generic pipe utility type, not a domain re-declaration. (Closes the prior VR.6 + VR.12 violations.)
  4. Runtime verification — `node test-contracts-single-source-of-truth.mjs` passes 28/28 assertions, including import checks for all three apps.
- Risk=high: `design.md:90` routes all `packages/contracts` edits to a serial integration track because the package is written by monorepo-foundation, realtime-terminal, agent-events-and-approvals, write-lock-and-takeover, runner-dialback-and-creds, single-user-auth, sandbox-provider-port, and guardrails tracks — multi-track contention on a shared data-contract package.

### realtime-terminal

**Live-frame parity under PTY parity conditions** — MET
- S1 (ResizeFrame contract): `packages/contracts/src/snapshot-frames.ts:78-85` defines `ResizeFrameSchema` with `channel="control"`, `type="resize"`, `cols`/`rows` as positive integers; included in `ControlFrameSchema` at `packages/contracts/src/control-frame.ts:39`.
- S2 (Gateway dispatches resize to PTY): `apps/api/src/terminal/terminal.gateway.ts:844-854` (`onResize`) guards on an authenticated operator, calls `session.pty.resize(frame.cols, frame.rows)` and `session.snapshots.resizeHeadless`; `RunnerPtyProxy.resize` at `:1029-1038` forwards it as a `ResizeFrame` control frame over the runner WebSocket. Unauthenticated/runner clients are silently ignored (`:845`).
- S3 (`TERM=xterm-256color` pinned): `apps/runner/src/pty/spawn-codex.ts:125-131` (`buildPtyEnv`) forces `TERM="xterm-256color"` last after merging caller env; the spawn call at `:83-89` passes `name:"xterm-256color"` to `pty.spawn`.
- Risk=high: the resize path is touched by the terminal-execution, runner-dialback, and write-lock tracks simultaneously, and `resizeHeadless` mutates the `SnapshotManager` headless-terminal state.

### runner-dialback-and-creds

**Ephemeral credentials destroyed with the session** — MET (re-confirmed end-to-end across three tracks)
- Core destroy mechanism — `SessionCredential.destroy()` zeroes `this.secret = null` and sets `destroyedFlag = true` at `apps/api/src/creds/session-credential.ts:98-101`; `matches()` always returns false afterward (`:88-90`); `reveal()` throws (`:74-79`).
- Provider teardown — `SessionCredentialsService.destroyForSession()` calls `credential.destroy()` and removes the entry from the in-memory Map at `apps/api/src/creds/session-credentials.service.ts:98-105`; `onModuleDestroy()` calls `destroyAll('teardown')` at `:125-127` (graceful-shutdown path).
- Forced-failure teardown — `GuardrailsService.forceFail()` calls `teardownSession(taskId, 'failed')` at `apps/api/src/guardrails/guardrails.service.ts:173`, which calls `creds.destroyForSession()` at `:189` and `taskTokens.revokeForTask()` at `:190`.
- Natural-completion teardown (VR.5 gap closed) — `TasksService.transition()` calls `guardrails.onTerminal(id)` for every terminal state at `apps/api/src/tasks/tasks.service.ts:151-158`; `onTerminal()` calls `clearTimers()` then `teardownSession()` at `guardrails.service.ts:124-129`. `markAgentFailedToStart()` also calls `guardrails.onTerminal(id)` at `tasks.service.ts:188-195`.
- Single-session invariant — `provisionForSession()` throws on a duplicate session at `session-credentials.service.ts:54-56`.
- Test coverage — `test-ephemeral-creds-destroyed-with-session.mjs` exercises all 8 scenarios (live authenticate, post-destroy verify returns false, `hasActiveCredential` false, `reveal` throws, distinct secrets, `destroyAll`, duplicate-session throws, `matches` false after destroy) against compiled `apps/api/dist/creds/`.
- Risk=high: security-sensitive credential lifecycle wired across three tracks (tasks-lifecycle, guardrails, creds); a regression in any of the `onTerminal`/`forceFail`/`markAgentFailedToStart` call sites silently leaks credentials.

### Gap / scope analysis (fourth pass)

**Missing-implementation coverage.** A fourth re-analysis of all 12 spec files against the implementation re-confirms there are NO requirements with zero traceable implementation. Every named requirement maps to at least some code; this pass found no missing-feature finding to route. The five requirements re-verified above all classified MET (each with a documented minor gap that does not block its primary scenario), so this pass produced no UNMET finding (no new `verify-reopened` task) and no SPEC-DEFECT finding (no `design.md` "Open Questions" note).

**Scope creep (implemented behaviors with no corresponding spec requirement).** The fourth pass surfaced the following present-but-unspecced behaviors. They are recorded for traceability only; none are UNMET (nothing in scope depends on them) and none were routed to `tasks.md`:
- `BackpressureController.rebase()` — rebases sent/acked counters to a fixed offset after snapshot+tail-replay reconnect, resuming a paused PTY as a side-effect: `apps/api/src/terminal/backpressure.ts:185`.
- `BackpressureController.setPty()` — late-injection of a real PTY after construction rather than at construction time: `apps/api/src/terminal/backpressure.ts:173`.
- `NullHeadlessTerminal` fallback when `@xterm/headless` is unavailable (snapshot frames carry empty data while byte-offset + tail-replay still work): `apps/api/src/terminal/terminal.gateway.ts:85`.
- `TerminalGateway.acquireLease()` explicit lease-acquire path beyond heartbeat/takeover: `apps/api/src/terminal/terminal.gateway.ts:604`.
- `TerminalGateway.broadcastLeaseState()` — broadcasts a `lease_state` control frame to ALL authenticated operators after every lease change; no spec requires this fanout: `apps/api/src/terminal/terminal.gateway.ts:612`.
- Direct raw-frame forwarding to operators without prior reconnect/`attachPty` in `onRunnerRawFrame`: `apps/api/src/terminal/terminal.gateway.ts:896`.
- `RunnerPtyProxy` inner class wrapping the runner dial-back WS as a `TerminalPty` (forwards keystrokes/resize/pause/resume over the same WS): `apps/api/src/terminal/terminal.gateway.ts:1000`.
- `SnapshotManager.resizeHeadless()` — updates headless geometry so later snapshots record correct cols/rows after a browser resize: `apps/api/src/terminal/snapshot.ts:158`.
- `SnapshotManager` no-snapshot fallback in `buildReconnectFrames` (skip snapshot, raw tail-replay only, when `fromSeq` is past the latest snapshot): `apps/api/src/terminal/snapshot.ts:199`.
- `SnapshotManager` single empty final `tail_replay` frame when there is nothing to replay (always signals replay complete): `apps/api/src/terminal/snapshot.ts:233`.
- `ConcurrencySemaphore.release()` handling of a queued-but-not-running task (remove from backlog without consuming a slot or admitting a replacement): `apps/api/src/guardrails/semaphore.ts:118`.
- `ConcurrencySemaphore.snapshotRunning()` / `snapshotQueue()` defensive-copy diagnostic accessors: `apps/api/src/guardrails/semaphore.ts:152`.
- `DeadlineWatcher.clearAll()` shutdown-teardown method (no shutdown requirement specified): `apps/api/src/guardrails/deadline-watcher.ts:119`.
- `IdleTracker` stale-timer re-arm guard in `onIdle()` (re-arm for the remaining time instead of force-failing when activity reset the window after the timer was scheduled): `apps/api/src/guardrails/idle-tracker.ts:162`.
- `IdleTracker.stopAll()` shutdown method (no shutdown requirement specified): `apps/api/src/guardrails/idle-tracker.ts:131`.
- `CircuitBreaker.forgetAll()` shutdown method (no shutdown requirement specified): `apps/api/src/guardrails/circuit-breaker.ts:126`.
- `GuardrailsService.sandboxMode()` diagnostic inspector exposing the bound `SandboxProvider` mode: `apps/api/src/guardrails/guardrails.service.ts:222`.
- CORS / WS-origin allow-listing via `WEB_ORIGIN` at bootstrap (`parseAllowedOrigins`); only env-configurable URLs are required, not a cross-origin allow-list: `apps/api/src/main.ts:52`.
- `SessionCredentialsService.destroyAll()` / `onModuleDestroy()` graceful-shutdown credential cleanup (no spec requires it): `apps/api/src/creds/session-credentials.service.ts:118`.
- `SessionCredential.toJSON()` guard so serializing never exposes secret material: `apps/api/src/creds/session-credential.ts:117`.
- `TaskTokenService` re-issue idempotence (re-issuing a TASK_TOKEN invalidates the prior token before minting); spec only requires single-task scoping + non-reusability across tasks: `apps/api/src/tasks/task-token.service.ts:61`.
- `parsePorcelainPaths()` deprecated backward-compat shim alongside `parsePorcelainFiles()`: `apps/runner/src/hooks/post-tool-use.hook.ts:123`.
- `unquotePorcelainPath()` strips double-quotes from porcelain paths with special characters; no spec mentions path-quoting: `apps/runner/src/hooks/post-tool-use.hook.ts:128`.
- `resolveDecisions()` fail-closed on an empty decision set (empty → deny); the spec only defines any-deny-wins for non-empty sets: `apps/runner/src/hooks/resolve-decision.ts:19`.
- `DialBackClient.send()` post-handshake guard refusing to send any frame until the handshake is written (handshake-first enforced at the API level beyond `connect()`): `apps/runner/src/dialback/dialback-client.ts:193`.
- `composeRunnerTask()` / `WsOutboundSocket` composition root wiring resize-frame forwarding from `DialBackClient.onControl` to `CodexPtyHandle.resize` (VR.14 is a verification tag, not a spec requirement): `apps/runner/src/main.ts:95`.
- `getClientId()` stable per-tab identity via `sessionStorage` for write-lock attribution; the frontend-console spec does not specify how client identity is generated/persisted: `apps/web/src/lib/client-id.ts:1`.
- `StartupWindow.cancel()` cancels the window without reporting failure (e.g. on operator teardown); no spec requires a cancel path distinct from the two failure modes: `apps/runner/src/startup-window.ts:97`.
- `StartupWindow` treats a zero-exit-before-first-frame as `early_exit` (not just non-zero exit); the spec only specifies non-zero exit: `apps/runner/src/startup-window.ts:46`.

---

## Fifth pass — three-way routing re-verification

This pass re-verified four requirements that earlier passes had re-opened as UNMET
(VR.4/VR.5/VR.9 and the circuit-breaker finding). After the baseline wiring fixes
landed, all four trace end-to-end against the codebase and are classified **MET**.
Every requirement in the sample is testable as written — the spec scenarios state
observable conditions (configured thresholds, byte high-water mark, disconnect event,
session-end event), so there is no ambiguous/untestable/contradictory language. Outcome:
**4 MET**, **0 UNMET**, **0 SPEC-DEFECT**.

### Routing summary (fifth pass)

| Destination | Count | Where |
| --- | --- | --- |
| MET | 4 | this section (evidence below) |
| UNMET (code problem) | 0 | none — no new `verify-reopened` task added to `tasks.md` |
| SPEC-DEFECT (ambiguous requirement) | 0 | none — no new `design.md` "Open Questions" note added |

### MET requirements (fifth pass, with evidence)

#### guardrails

**Circuit breaker on repeated start/turn failure** — MET
- Spec: `specs/guardrails/spec.md:36-46` (both scenarios: threshold consecutive failures trip the
  breaker to `failed` with no auto-retry; a success resets the counter).
- Core class: `apps/api/src/guardrails/circuit-breaker.ts:45-132` — `CircuitBreaker` tracks per-task
  `BreakerState` (`consecutiveFailures` + tripped latch); `recordFailure` (`:83`) increments and trips
  `onTrip` exactly once when `>= threshold`, ignoring post-trip calls; `recordSuccess` (`:114`) resets
  the counter and is a no-op once tripped.
- Integration: `apps/api/src/guardrails/guardrails.service.ts:89-92` — `CircuitBreaker` constructed with
  `onTrip → forceFail(taskId,'circuit_breaker')`; `forceFail` (`:170-190`) transitions the task to
  `failed`, invokes `SandboxProvider.teardownSandbox`, destroys credentials + revokes TASK_TOKEN, and
  releases the slot — no retry path.
- Config: `apps/api/src/guardrails/guardrails.module.ts:61-65` — `circuitBreakerThreshold` read from
  `CIRCUIT_BREAKER_THRESHOLD`, default 3 (`guardrails.service.ts:45`).
- Failure call site: `apps/api/src/tasks/tasks.service.ts:182-184` — `markAgentFailedToStart()` calls
  `guardrails.recordFailure(id,'agent_failed_to_start')`.
- Success-reset call site: `apps/api/src/terminal/terminal.gateway.ts:519-521` — successful dial-back
  handshake calls `guardrails.recordSuccess(frame.taskId)`.
- Caveat (already recorded as a SPEC-DEFECT note in `design.md` "Open Questions", line 118; NOT re-raised
  here): the `turn_failure` `FailureKind` has no runner→orchestrator transport yet (no `runner_exit` frame
  in contracts); that wiring is deferred per `design.md:118`. The requirement is satisfied via the
  `agent_failed_to_start` path, through which both spec scenarios are reachable.
- Risk=high: spans guardrails + tasks-service + terminal-gateway tracks; mutates task status to `failed`;
  security-relevant guardrail (prevents a provider-quota burn loop). (Confirmed MET in the second pass at
  lines 327-344 and again here against the same call sites.)

#### realtime-terminal

**Server-side backpressure with bounded high-water mark** — MET
- Spec: `specs/realtime-terminal/spec.md:22-31` (PTY paused at the 500 000-byte high-water mark; resumed
  after the client drains below the low-water mark).
- The bound: `packages/contracts/src/ws-frames.ts:83` — `HIGH_WATER_MARK_BYTES = 500_000`; imported as
  `DEFAULT_HIGH_WATER_MARK` in `apps/api/src/terminal/backpressure.ts:16-23`; constructor at `:77` enforces
  `high <= HIGH_WATER_MARK_BYTES`.
- Pause/resume: `backpressure.ts:120-124` — `onSent()` calls `pty.pause()` when
  `unacknowledgedBytes >= highWaterMark`; `:145-149` — `onAck()` calls `pty.resume()` when
  `unacknowledgedBytes < lowWaterMark`.
- Gateway wiring: `apps/api/src/terminal/terminal.gateway.ts:828` wires the real PTY via
  `state.backpressure.setPty(session.pty)` (closes the earlier VR.9 no-op gap); `streamRawChunk()`
  (`:740-741`) feeds `onSent()` per raw frame; the ack handler (`:707-708`) feeds `onAck()`;
  `RunnerPtyProxy.pause()/resume()` (`:1040-1048`) forward flow-control frames to the runner so the
  pause/resume chain reaches the actual PTY producer.
- Risk=high: backpressure state is mutated from the PTY-data callback, the inbound-ack handler, and the
  disconnect path; the gateway is a multi-track integration point (tracks 5/6/7/8/11).

#### write-lock-and-takeover

**Auto-release on disconnect** — MET
- Spec: `specs/write-lock-and-takeover/spec.md:26-31` ("Auto-release on disconnect": writer-disconnect
  frees the lease promptly rather than waiting for `leaseExpiry`).
- State machine: `apps/api/src/write-lock/write-lock.service.ts:141-148` — `releaseOnDisconnect()` deletes
  the lease immediately and returns true/false depending on whether the disconnecting client held it.
- Gateway wiring: `apps/api/src/terminal/terminal.gateway.ts:279-283` — `handleDisconnect` calls
  `writeLock.releaseOnDisconnect` then `broadcastLeaseState` to fan the change out to all operators.
- Tests: `test-auto-release-on-disconnect.mjs:62-124` exercises all four sub-cases.
- Risk=high: mutates the shared in-memory lease Map and triggers a broadcast to all operators; touched by
  the write-lock track and the orchestrator-integration/terminal-gateway track.

#### runner-dialback-and-creds

**Ephemeral credentials destroyed with the session** — MET
- Spec: `specs/runner-dialback-and-creds/spec.md:33-43` (credentials revoked at session end on
  completion/failure/teardown; scoped to one session, never persisted).
- Destroy chain wired end-to-end across three tracks:
  1. `apps/api/src/creds/session-credential.ts:98-101` — `destroy()` nulls the secret and sets
     `destroyedFlag`; `matches()` returns false after destruction (`:87-92`).
  2. `apps/api/src/creds/session-credentials.service.ts:98-106` — `destroyForSession()` calls
     `credential.destroy()` then `Map.delete()`; `onModuleDestroy()` (`:125-127`) calls
     `destroyAll('teardown')` on graceful shutdown.
  3. `apps/api/src/guardrails/guardrails.service.ts:135-140` — `onTerminal()` calls `clearTimers` +
     `teardownSession('completed')` + `semaphore.release()`; `:170-208` — `forceFail()` transitions to
     `failed` and calls `teardownSession('failed')` on the deadline/idle/circuit-breaker paths; `:204-208`
     — `teardownSession()` calls `creds.destroyForSession(taskId)` AND `taskTokens.revokeForTask(taskId)`.
  4. `apps/api/src/tasks/tasks.service.ts:151-158` — `transition()` calls `guardrails.onTerminal(id)` on
     every terminal-state transition (completed/failed/agent_failed_to_start), closing the earlier VR.5
     natural-completion dead-code gap; `:186-195` — `markAgentFailedToStart()` also calls
     `guardrails.onTerminal(id)`.
- History: the first verify pass (this report, lines 158-163) classified this PARTIAL/UNMET (VR.5) because
  `transition()` had no `onTerminal()` call; reclassified MET (lines 407-426) once the natural-completion
  path was wired.
- Test coverage: `test-ephemeral-creds-destroyed-with-session.mjs` exercises 8 scenarios (live auth,
  post-destroy auth fails, `hasActiveCredential` false, `reveal` throws, cross-session isolation,
  `destroyAll`, duplicate-session invariant, raw `destroy`) against compiled `apps/api/dist/creds/`.
- Risk=high: security-sensitive primary safety boundary (design D8); wired across the tasks-lifecycle,
  guardrails, and creds tracks; a regression in any one call site (`tasks.service.ts:151` or `:188`) would
  silently leak credentials on every cleanly-completing task.

### Gap / scope analysis (fifth pass)

**Missing-implementation coverage.** A fifth re-analysis of all 12 spec files against the implementation
re-confirms there are NO requirements with zero traceable implementation. Every named requirement maps to
at least some code. The one requirement that prior passes flagged as having only a stub/no-op on its
byte-identity path — `realtime-terminal` "Live-frame parity under PTY parity conditions" — does have a
traceable implementation (PTY-side `TERM` pinning, the raw-byte transit path, and the geometry round-trip);
its remaining concern was a single dead-code wiring hop already tracked as VR.14 (now closed via the
`composeRunnerTask()` resize wiring at `apps/runner/src/main.ts:95`), not a missing feature. No
missing-implementation finding to route.

**Scope creep (implemented behaviors with no corresponding spec requirement).** The fifth pass re-confirmed
the present-but-unspecced behaviors already catalogued in passes one through four (notably the
`BackpressureController.rebase()/reset()/setPty()` reconnect/disconnect/late-bind helpers at
`apps/api/src/terminal/backpressure.ts:213-249`; the `SnapshotManager.resizeHeadless()` geometry-sync at
`apps/api/src/terminal/snapshot.ts:158-161`; the `NullHeadlessTerminal` stub and `RunnerPtyProxy` at
`apps/api/src/terminal/terminal.gateway.ts:85-98,1000-1055`; the `connect_auth` in-band re-auth frame at
`terminal.gateway.ts:467-483`; the `Renewed`/`TakenOver` `LeaseOutcome` values and `demotedClientId` field
at `apps/api/src/write-lock/write-lock.types.ts:51-70`; the lease-renewal-on-`acquire` case at
`write-lock.service.ts:79-82`; the `SessionCredential.reveal()/toJSON()` and
`SessionCredentialsService.snapshot()/verify()` accessors at `apps/api/src/creds/session-credential.ts:73-119`
and `session-credentials.service.ts:78-111`; the `GuardrailsService.sandboxMode()` inspector at
`guardrails.service.ts:240-242`; the `ConcurrencySemaphore.release()` cancel-queued path at
`apps/api/src/guardrails/semaphore.ts:119-127`; the `CircuitBreaker.forget()/forgetAll()` cleanup at
`apps/api/src/guardrails/circuit-breaker.ts:124-131`; the `IdleTracker` stale-timer re-arm guard at
`apps/api/src/guardrails/idle-tracker.ts:162-175`; the `parsePorcelainPaths()` deprecated shim at
`apps/runner/src/hooks/post-tool-use.hook.ts:120-125`; the `NotificationRouter.requestDecision()`
first-adapter/null-fallback routing at `apps/runner/src/notify/notification-router.ts:53-58`; the legacy
`WORKSPACES_ROOT` env-var fallback at `apps/api/src/terminal/terminal.gateway.ts:984-985` and
`apps/runner/src/main.ts:168`; the `DialBackClient.send()` post-handshake guard at
`apps/runner/src/dialback/dialback-client.ts:193-198`; the rAF coalescing SSR fallback at
`apps/web/src/app/tasks/[id]/page.tsx:126-128`; and the session-page 4s task-status poll at
`apps/web/src/app/tasks/[id]/page.tsx:89`). All are recorded for traceability only; none are UNMET
(nothing in scope depends on them) and none were routed to `tasks.md`.
