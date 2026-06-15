# Verification report — session-sandbox-retention

Adjudicated re-trace of the raw verify findings against the actual implementation.
Each raw-unmet finding was re-traced end-to-end before routing; the skeptic count
was NOT rubber-stamped. Routing is three-way: reopened code tasks (see
`tasks.md` → `## Track: verify-reopened`), spec-defects (→ `design.md` Open
Questions), and MET (folded here).

## Three-way tally

- Reopened as code tasks: 3 (from the prior pass; no NEW code tasks this pass)
  - "Session-history response is a discriminated honest 5-state contract"
    (V.1 — cancelled interrupted indication missing from the wire contract)
  - "Pre-stop cache trim and auth.json clear bound the retained footprint"
    (V.2 — provision-failure retention path skips the `auth.json` zero)
  - "Console renders the read-only structured transcript on the terminal-state
    branch" (V.3 — `终端回放` secondary `session.log` cold-replay is a placeholder)
- Spec-defects routed to design.md Open Questions: 1 (NEW this pass)
  - "Control frame bridges back into the query cache" — the inherited
    `frontend-console` scenario asserts a *task-completion control frame* bridges
    into the query cache, but no `task.completed` frame type exists in
    `ControlFrameSchema` and no `setQueryData` exists in `apps/web/src`;
    completion propagates via 5s `taskQuery` polling + socket-`open`
    invalidation instead. This change is scoped to NOT touch the live WS/PTY/
    lease pipeline, so the scenario is untestable against this change's
    deliberately-untouched live path → SPEC-DEFECT, owned by realtime-terminal,
    NOT a code task here. (See design.md "Open Questions".)
- Reclassified MET (re-traced as satisfied despite the skeptic's framing): 4
  (this pass re-traced "Pre-stop cache trim and auth.json clear bound the
  retained footprint" — the skeptic raised only a risk flag, no refutation;
  all four scenarios trace, and the one prior gap on this requirement is closed
  as V.2. Folded below. No NEW code tasks and no NEW spec-defects this pass.)

## Reclassified MET (folded in)

### Terminal-state sandbox containers are retained, not removed — MET
Re-traced every claim against `aio-sandbox.provider.ts` /
`guardrails.service.ts`:
- `HostConfig.AutoRemove: false` at creation (`aio-sandbox.provider.ts:199`).
- `teardownSandbox` is stop-only: `container.stop({ t: 0 })` at `:268`, no
  `remove()` on the retain path; `removeSandbox` (`:278-286`) is the separate
  cleaner-only deletion path.
- Both terminal chokepoints route through the stop-only teardown: natural
  completion via `onTerminal` (`guardrails.service.ts:453`) and `forceFail`
  for all five abnormal causes (`:570`).
- The slot is still freed independently of teardown via
  `semaphore.release(taskId)` (`:463`, `:579`), each decoupled with `.catch()`.

The skeptic's evidence is entirely confirmatory ("Risk is high" is a risk note,
not a refutation — no claimed behavior fails to trace). MET as written.

### Per-task AIO Sandbox container provisioning — MET
Re-traced against `aio-sandbox.provider.ts`: container name `cap-aio-<taskId>`
(`:163`/`:184`), `SecurityOpt=[seccomp=unconfined]` with the
`assertSeccompUnconfined` guard (`:170`/`:478`), `ShmSize` 2 GB (`:193`/`:101`),
`AutoRemove:false` (`:199`), `NetworkMode=cap-net` with no `PortBindings`
(`:202`), `container.start()` (`:208`), `waitForReadiness` polling `GET /v1/docs`
(`:220`/`:499`), stop-only `teardownSandbox` (`:254-271`), pre-stop trim
(`:296-324`), and the separate `removeSandbox` cleaner path (`:278-286`). Every
asserted point is confirmed by inspection. MET.

### Pre-stop cache trim and auth.json clear bound the retained footprint — MET
Re-traced all four scenarios of the spec requirement
(`specs/session-sandbox-retention/spec.md:26-45`) against
`aio-sandbox.provider.ts` / `guardrails.service.ts`; the skeptic's evidence is
entirely confirmatory ("Risk=high" is a risk note about a data-mutating,
security-sensitive, shared-teardown-path operation — NOT a refutation; no
claimed behavior fails to trace):
- **Cache/logs dropped, sessions kept** — `trimCodexHomeBeforeStop`
  (`:302-330`) issues `rm -rf ${dir}/cache ${dir}/logs_*.sqlite ...` (`:308-309`)
  with `sessions/` ABSENT from the delete list, so the `rollout-*.jsonl` survives.
- **auth.json cleared before stop** — the same shell command appends
  `: > ${dir}/auth.json 2>/dev/null; true` (`:310`), zeroing the file via shell
  truncation.
- **Trim runs before stop** — `teardownSandbox` (`:254-277`) calls
  `trimCodexHomeBeforeStop` at `:270`, then `container.stop({ t: 0 })` at `:274`;
  the order is unconditional.
- **Trim failure does not block retention** — `trimCodexHomeBeforeStop` wraps the
  whole fetch in try/catch (`:311-329`); any error (including the
  `AbortSignal.timeout(TRIM_TIMEOUT_MS=10_000)` at `:130`/`:316`) logs a warning
  and returns normally, so the stop at `:274` proceeds regardless.
- Both terminal chokepoints route through `teardownSandbox`:
  `onTerminal` (`guardrails.service.ts:453`) and `forceFail` for all five
  abnormal causes (`:570`).

The one genuine gap previously found on THIS requirement — the provision-failure
teardown skipping the `auth.json` zero because `teardownSandbox` saw no
`connection` — was reopened and CLOSED as code task V.2 (`tasks.md:71`, `[x]`).
The current `teardownSandbox` reconstructs `baseUrl` DETERMINISTICALLY from the
container name (`connection?.baseUrl ?? http://${CONTAINER_PREFIX}${taskId}:${AIO_PORT}`,
`:267-269`), so the trim/clear fires even on the provision-failure path where
`connection` is undefined (documented at `:260-266`). With V.2 closed, the
requirement re-traces end-to-end as satisfied. MET as written.

### Session page renders the live terminal and controls (frontend-console) — MET (with a minor gap that does not block the primary scenario)
Re-traced the live-terminal branch (`$taskId.tsx:200-209`, SSR-off terminal,
takeover/keystroke, statusline) and the replay branch
(`$taskId.tsx:184-192` gating `<SessionReplay>` via `isReplayableStatus`;
`sessionHistoryQuery` → `real.getSessionHistory` `.parse` or mock;
`session-replay.tsx` two tabs, five filter presets, final-answer/commentary/
tool-call treatments, honest empty/expired states). Both branches are
implemented and trace as satisfied.

The two skeptic "gaps" do NOT make the primary scenario unmet:
- `BACKEND_CAPABILITIES.sessionHistory = false` (`capabilities.ts:93`) is the
  documented, intended "render on mock, flip one flag to go real after e2e
  verification against a running api + retained container" posture
  (`capabilities.ts:88-93`). The spec requires the real/mock SEAM be plumbed
  (`queryKeys.sessionHistory` + `sessionHistoryQuery` + `real.getSessionHistory`
  `.parse` + mock + flag) — all present — NOT that the flag be flipped. The flag
  value is an operational gate, not a spec violation. MET as written.
- The `终端回放` secondary `session.log` cold-replay being a placeholder IS a
  real gap, but it is the SAME gap reopened as code task V.3 (it belongs to the
  session-history-replay "structured transcript on the terminal-state branch"
  requirement, which owns the secondary-source clause). The PRIMARY scenario
  (read-only structured conversation transcript) is fully satisfied; only the
  secondary tab is deferred. Tracked once, under V.3.

## Gap findings (real, traceable — reopened, not spec-defects)

1. **Cancelled interrupted-terminal indication is not on the wire** — the
   `SessionHistorySchema` `available` branch (`session-history.ts:99-103`) has no
   `isInterrupted` field, and `session-history.controller.ts:50-58` returns
   `{ status: 'available', turns, meta }` identically for completed/cancelled/
   failed (it never reads `task.status`). The frontend's `cancelled` framing comes
   from `replayPresentationState(task.status)` computed CLIENT-side, not from the
   response. The spec scenario "Cancelled task returns rollout plus interrupted
   indication" requires the indication in the response. Unambiguous + testable →
   reopened as V.1 (not a spec-defect).

2. **Provision-failure retention path skips the `auth.json` zero** —
   `provision()` calls `teardownSandbox(ctx.taskId)` at `:237` on a post-start
   error, BEFORE `this.connections.set(...)` at `:242`. `teardownSandbox`'s
   `if (connection)` guard at `:262` is therefore false and
   `trimCodexHomeBeforeStop` (the `auth.json` zero) is skipped, yet the container
   is stopped-and-retained — and the "Abnormally-terminated tasks are still
   retained" scenario lists `provision-failed` as a retained cause. A provision
   that failed AFTER `injectCodexAuth` (`:224`, e.g. in `injectTaskPrompt` /
   `cloneTaskRepository`) retains a live `auth.json`, violating "retained
   containers do not hold a usable credential" (security-sensitive). The
   subsequent `forceFail('provision_failed')` re-invokes `teardownSandbox` but is
   a no-op (`this.containers` cleared at `:259`). Unambiguous + testable →
   reopened as V.2.

3. **`session.log` cold-replay (secondary source) unimplemented** —
   `session-replay.tsx:152-166` renders a "终端回放待接入" placeholder; there is no
   provider `readSessionLogFromContainer` / cold-replay path. The spec names
   `session.log` cold-replay as the SECONDARY replay source. Real unimplemented
   feature, not an ambiguity → reopened as V.3.

## Spec-defect findings (routed to design.md Open Questions — NOT code tasks)

4. **"Control frame bridges back into the query cache" — task-completion frame
   has no traceable implementation (SPEC-DEFECT, not reopened here).** Re-traced
   the inherited `frontend-console` MODIFIED scenario end-to-end:
   `ControlFrameSchema` (`packages/contracts/src/control-frame.ts:29-50`) carries
   pause/resume/ack/snapshot/tail_replay/reconnect/resize/permission_request/
   decision/post_tool_use_report/keystroke/heartbeat/takeover_request/lease_state/
   connect_auth — there is NO `task.completed` (or any completion) frame type.
   `session-terminal.tsx`'s `handleControl` switch (`:241-305`) handles
   snapshot/tail_replay/lease_state/permission_request/pause/resume and contains
   no completion case and no query-cache bridge; there is NO `setQueryData`
   anywhere in `apps/web/src`. Completion status instead reaches other views via
   the 5s-polled `taskQuery` (`queries.ts:84`, `refetchInterval: 5000`) plus a
   socket-`open` `invalidateQueries(queryKeys.task(id))` (`$taskId.tsx:147-156`).
   The `task.completed` string in `mock.ts:590` is an AUDIT-LOG event fixture,
   not a WS control frame — unrelated.
   Routing: this is a SPEC-DEFECT, NOT a reopened code task. session-sandbox-
   retention is categorically scoped to NOT touch the live WebSocket/PTY/write-
   lease pipeline (Goals/Non-Goals; D8; the "descope scar" risk), and the
   scenario describes pre-existing live-path behavior owned by the realtime-
   terminal change. The in-scope deliverable for THIS change (the terminal-state
   replay branch) is fully MET; the control-frame bridge clause is inherited,
   unchanged, live-path behavior whose mechanism (polling + socket-lifecycle
   invalidation) diverged from the scenario's wording (a `task.completed` frame +
   `setQueryData`). Untestable against this change's deliberately-untouched live
   path → routed to design.md "Open Questions" for the realtime-terminal spec to
   resolve (add a real completion frame and bridge it, OR amend the scenario to
   the propagation that actually ships). No task added to `tasks.md`.

## Scope findings (implemented behavior with no mapped spec requirement)

These are additive hardening/UX behaviors observed beyond the spec; recorded for
traceability. None contradicts a requirement; none was routed to a task.

- `onModuleDestroy` stops all provisioned containers on app shutdown to prevent
  orphans (`aio-sandbox.provider.ts:466-471`) — only startup reap of RUNNING
  orphans and stop-only per-task teardown are specified.
- Pre-stop trim also deletes `logs_*.sqlite-shm` / `logs_*.sqlite-wal` WAL
  sidecars (`aio-sandbox.provider.ts:303`) — spec names only `cache` and
  `logs_*.sqlite`. (Harmless/correct extension: the sidecars belong to the
  deleted sqlite.)
- Retention cleaner resolves the window as MAX across ALL `accountSettings` rows
  (`retention-cleaner.ts:105-123`) — spec says "read from account settings
  (default 30)" with no multi-account MAX semantics.
- Retention cleaner uses `force:false` on remove so a container racing back to
  RUNNING is refused, not killed (`retention-cleaner.ts:210-221`) — the
  racing-container protection is unspecified.
- Rollout parser reads `session_meta` (cwd/startedAt) and `turn_context` (model)
  lines (`rollout-parser.ts:124-137`) — neither line type is named in the spec.
- Rollout parser handles `custom_tool_call` / `custom_tool_call_output`
  (`rollout-parser.ts:175-199`) — spec names only `function_call` /
  `function_call_output`.
- Rollout parser falls back to `response_item role=user` (wrapper-stripped) when
  a codex-exec rollout has no `user_message` events
  (`rollout-parser.ts:118,204-214`) — the non-interactive fallback branch is
  unspecified.
- `SessionHistoryMeta` (taskId/model/cwd/startedAt) is surfaced on the
  `available` response (`session-history.ts:76-86`) — no spec requirement
  mentions session-level metadata.
- `replayPresentationState()` / `isReplayableStatus()` /
  `REPLAY_PRESENTATION_STATES` shared helpers (`session-history.ts:125-157`) —
  the spec mandates correct render state, not a shared contract-level helper.
- `session-replay.tsx` event-tree sidebar with jump-to-scroll
  (`:280-302`,`:432-444`) — spec specifies the search input + five filter
  presets, not jump-to navigation.
- `session-replay.tsx` retention-note footer (`:203-208`) — no spec requirement
  mentions a retention-note UI element.
- `VITE_FORCE_MOCK=1` global mock override (`capabilities.ts:106-109`) — the
  capability flag seam is specified; the global override env var is not.
- Retention sweep cadence fixed at 6h (`retention-cleaner.ts:46`) — no spec
  prescribes a sweep cadence (called out as a tuning Open Question).
- Retention cleaner enumerates `created` / `dead` container states in addition
  to `exited` when listing non-running sandboxes (`retention-cleaner.ts:132`) —
  spec speaks only of STOPPED containers, not the specific docker states.
- Session-history controller distinguishes `no-rollout` (container exists, no
  file) from `expired` (container reaped) via `sandboxExists()`
  (`session-history.controller.ts:66-68`) — spec lists no-rollout/expired as
  explicit states but not the mechanical distinction.
- Client-side `isInterrupted` override: the wire `history.isInterrupted` field
  (V.1, spec-required) overrides the client-derived `presentationState` to set
  the meta-line text (`session-replay.tsx:109-113`) — the wire field is
  specified; the client override logic is not.
- Search filters turns by case-insensitive match across all visible fields
  (text/name/args/output) (`session-replay.tsx:426-435`) — spec requires a
  search input be present, not the search semantics.
- `TASK_ID` / `ORCHESTRATOR_APPROVALS_URL` env vars injected into every sandbox
  at creation (`aio-sandbox.provider.ts:178-182`) — these belong to the approval
  flow, not session-sandbox-retention; no spec in this change covers them.
