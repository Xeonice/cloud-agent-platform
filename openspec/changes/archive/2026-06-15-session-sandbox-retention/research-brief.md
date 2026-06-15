# Research Brief — session-sandbox-retention

> Side-car artifact. **Not a tracked OpenSpec artifact.** Referenced by `proposal.md` / `design.md` the same way `spike-findings.md` is. Synthesizes three research routes (Web / Codebase / Archive) for the change that retains the per-task AIO sandbox container after a task terminates, exposes a read-only structured session-history replay, and reaps/retains containers safely.

---

## Route: Web (external prior art & engineering patterns)

External research validates the design baseline as established prior art and resolves several open research points with concrete, citable mechanisms.

### Rollout-viewing is community-standard prior art, not novel UI
A mature OSS ecosystem already converts codex rollout JSONL into browsable read-only transcripts. `masonc15/codex-transcript-viewer` is the most complete model (sticky left sidebar with search + event tree, distinct visual treatments per event type, token-usage counters), and at least six other live alternatives exist: `prateek/codex-transcripts`, `zpdldhkdl/codex-replay` (self-contained HTML replays), `PixelPaw-Labs/codex-trace`, Simon Willison's `tools.simonwillison.net/codex-timeline`, and a native macOS viewer in `openai/codex` Discussion #24042.
- Evidence: https://github.com/masonc15/codex-transcript-viewer ; https://github.com/zpdldhkdl/codex-replay ; https://github.com/PixelPaw-Labs/codex-trace ; https://tools.simonwillison.net/codex-timeline ; https://github.com/openai/codex/discussions/24042
- Relevance: Validates the design-baseline (`history-replay-preview.html`) approach as established prior art rather than novel UI. The spec's rendering contract can cite these as reference rather than inventing categories, and confirms "structured scrollable transcript, not terminal animation" is the community-standard form for rollout viewing.

### The load-bearing commentary-vs-final-answer categorization is a `phase` field, not message ordering (resolves open point #2)
`masonc15`'s `parser.py` distinguishes commentary from final answer NOT by a "last assistant message" heuristic but by an explicit `phase` field on assistant `output_text` blocks: `response_item` `message(role=assistant)` carries a `phase`, and the matcher does `if response_event.get('phase') == 'final_answer': return False` to exclude finals from the `agent_commentary` bucket. Full event mapping:
- `event_msg`: `user_message`→`user_message`, `agent_message`→`agent_commentary`, `agent_reasoning`→`reasoning`, `task_complete`→`task_complete`, `token_count`→`token_count`
- `response_item`: `function_call`→`tool_call` (with name/arguments/call_id), `function_call_output`→`tool_output` (linked by `call_id`), `message(assistant)` `output_text`→`assistant_text` with phase tracking
- Evidence: https://github.com/masonc15/codex-transcript-viewer (`src/codex_transcript_viewer/parser.py` event mapping + `phase == 'final_answer'` matcher)
- Relevance: Directly resolves open research point #2 (RolloutItem type → UI item mapping). The spec's structured-rendering requirement should key the green-tinted "最终回答" label off the assistant `output_text` `phase == 'final_answer'` field, with `call_id` linking `tool_call`↔`tool_output` — NOT off message ordering. This is the load-bearing categorization contract.

### Field paths for clean conversation reconstruction (resolves parser field paths)
Reconstructing a clean conversation from rollout JSONL is done by selecting on `.payload.type` with text at known field paths: e.g. `jq -r 'select(.payload.type == "user_message") | .payload.message'`. `event_msg` lines carry rendered text at `.payload.message`; the user prompt frequently has a wrapper that is split on a delimiter (e.g. `## My request for Codex:`).
- Evidence: https://michaelheap.com/extract-codex-conversation/
- Relevance: Confirms the exact field paths the new `GET /tasks/:id/session-history` parser should read (`.payload.type`, `.payload.message`), and warns that `user_message` payloads may contain a developer/instruction wrapper that must be split before display — a concrete rendering edge case for the spec.

### Reading files out of a STOPPED container is documented-reliable via docker cp / dockerode getArchive (resolves open point #1)
Reading files out of a stopped container via `docker cp` / dockerode `getArchive` (tar stream) is the documented-reliable pattern as long as `AutoRemove` is `false`: "You can copy data out of stopped containers using docker cp ... a reliable method for retrieving files ... with filesystems intact." dockerode exposes `container.getArchive`/`putArchive` (tar) plus `.commit` on the `Container` object obtained via `docker.getContainer(id)`.
- Evidence: https://oneuptime.com/blog/post/2026-02-08-how-to-automatically-remove-a-container-after-it-exits/view ; https://github.com/apocas/dockerode (Container getArchive/putArchive/commit) ; https://github.com/apocas/dockerode/issues/649
- Relevance: Confirms the spike's decision (open point #1) to use `docker cp` over the AIO File API — the File API server is stopped with the container, but the daemon-level `getArchive` reads the frozen layer directly. dockerode's `getArchive` returns a tar stream the endpoint must untar to extract `rollout-*.jsonl`; `.commit` is the verified resume path (deferred follow-up).

### Orphan-reaping must filter by state + age + label, never blanket force-remove (validates open point #5 / spike caveat #7)
The standard orphan-reaping pattern (Kubernetes GC + Docker prune) is exactly the change's reap decision: resources WITHOUT a valid owner or in a terminated phase are GC-eligible, while RUNNING resources with active owners are PROTECTED; age-based filtering (`MinAge` / `until=` filter) prevents premature deletion of recent resources; and label-based filtering distinguishes ephemeral helper containers from persistent ones that must be excluded from pruning.
- Evidence: https://kubernetes.io/docs/concepts/architecture/garbage-collection/ (owner-reference / orphan / MinAge) ; https://docs.docker.com/build/cache/garbage-collection/ (age + size thresholds) ; oneuptime `label=ci-build=true` / `until=24h` filters
- Relevance: Validates open point #5 and spike caveat #7: the `onApplicationBootstrap` reap MUST filter by container state (only RUNNING orphans) and ideally by a `cap-aio-*` label, never blanket force-remove, so a Dokploy redeploy / api restart cannot wipe the stopped history containers. The age-gate (don't reap containers younger than retention) is the established safety mechanism.

### Rollout JSONL is world-readable 0644 — informs the auth.json export guard (open point #6)
codex session/rollout JSONL files are created world-readable mode `0644` (dirs `0755`) — a known local information-disclosure issue (any other UID can `cat` the full session: prompts, model responses, every tool I/O) — whereas `history.jsonl` is correctly restricted to `0600`. The recommended fix mirrors `history.jsonl`: `0700` dirs + `0600` files.
- Evidence: https://github.com/openai/codex/issues/21660
- Relevance: Informs security open point #6. Inside the retained stopped container the rollout (and `~/.codex/auth.json`, even if expired) sit at permissive modes. Since the container is the trust boundary this is acceptable while stopped, but the endpoint that docker-cp's the rollout out should NOT also export `auth.json`, and the design should note clearing/zeroing `~/.codex/auth.json` before stop as cheap defense-in-depth (consistent with the cache-trim already planned).

### A Stop lifecycle hook is the considered-and-rejected alternative capture mechanism
codex 0.131+ exposes a Stop lifecycle hook: each command hook receives one JSON object on stdin and "`transcript_path` points to a conversation transcript" — i.e. codex hands you the rollout path at turn/session end. There is also a `--ephemeral` flag to NOT persist rollout files. Langfuse's official `codex-observability-plugin` uses exactly this: "Codex emits a Stop hook after each turn, passing the path to the session's rollout transcript on stdin," then reads the rollout JSONL to reconstruct turns/generations/tool-calls/subagents.
- Evidence: https://developers.openai.com/codex/hooks ; https://developers.openai.com/codex/noninteractive (`--ephemeral`) ; https://github.com/langfuse/codex-observability-plugin
- Relevance: Surfaces an ALTERNATIVE to docker-cp-from-stopped-container that the design should explicitly weigh and reject-with-reason. A Stop hook could copy the rollout to the mounted workspace volume DURING the run, surviving even container removal — but it fires only in flows that run hooks (and may be unreliable on SIGKILL abnormal-exit, the exact case the change targets). docker-cp from the frozen stopped layer is more robust for abnormal interruptions, so the spike's choice is sound; cite this as the considered-and-rejected option. Also note: do NOT pass `--ephemeral`, or rollouts won't persist.

### No off-the-shelf embeddable viewer exists — build-vs-buy resolves to build
Langfuse `codex-observability-plugin` is a production-ready off-the-shelf rollout→observability pipeline (turns as observations, generations with token usage, `exec_command`/`apply_patch`/`spawn_agent` tool calls, subagents, sessions by thread id, full session replay in Langfuse Sessions view) — but it is purely a data EXPORTER with no embeddable read-only viewer; visualization lives in the external Langfuse platform.
- Evidence: https://github.com/langfuse/codex-observability-plugin
- Relevance: Answers the build-vs-buy question for the viewer: no off-the-shelf component gives an in-console embeddable read-only transcript for this multi-tenant operator UI, so building the structured renderer (per `masonc15`'s model) is justified rather than adopting Langfuse. Its data model (turns→generations→tool-calls→subagents) is a good schema reference for the endpoint's response shape.

### Cold read-only terminal replay is a solved pattern — validates the secondary source (decision D)
Cold read-only terminal replay of recorded PTY bytes is a solved pattern with two mature approaches: (a) replay raw bytes via `term.write()` at recorded I/O times (xterm.js), with the `SerializeAddon` available to reconstruct buffer state without control-character corruption when seeking; (b) asciinema's asciicast `.cast` format (timestamped event stream) with `asciinema-player` as an npm component. For a partial/half-painted TUI (abnormal stop) the raw-byte replay reproduces exactly the broken frame.
- Evidence: https://github.com/xtermjs/xterm.js/discussions/4869 (SerializeAddon replay) ; https://docs.asciinema.org/how-it-works/ ; https://www.npmjs.com/package/asciinema-player/v/3.1.0
- Relevance: Confirms the SECONDARY source (`session.log` → read-only xterm) is a standard pattern and the spike's observation is correct: cold-replaying raw PTY into a read-only xterm gives a clean colored scroll for completed tasks but only a half-painted TUI for abnormal stops — which is precisely why structured rollout must be the PRIMARY source. Validates decision D (dual-source, rollout primary) and the honest-degradation "已停止(终端中断画面)" state.

### Disk retention is conventionally multi-policy (resolves open point #4)
Retention/disk management for accumulating per-item data is conventionally driven by MULTIPLE simultaneous policies, deleting when ANY trips: time-limit (age), size (max aggregate bytes), file/item count, and free-disk-space high-water-mark (delete oldest to maintain a minimum free GB). Combining time + size is the recommended way to bound growth.
- Evidence: https://docs.pingidentity.com/pingdirectory/latest/pingdirectory_security_guide/pd_sec_log_file_rotation_retention.html ; https://www.confluent.io/learn/kafka-retention/
- Relevance: Answers open point #4 (disk capacity model). The retention cleaner should not rely on the 30-day age cap alone (~15MB × daily volume could still blow 160GB under a burst); add a free-disk high-water-mark guard that evicts oldest stopped `cap-aio-*` containers first when free space drops below a floor. This is the "over-limit protection" the change explicitly flags.

### NestJS @Cron needs an overlap guard / distributed lock (resolves open point #3)
A NestJS `@Cron` retention cleaner needs an explicit overlap guard and (if ever multi-instance) a distributed lock: a job that can run longer than its interval will produce overlapping runs unless gated by an `isRunning` flag; horizontally-scaled deployments need a Redis or DB lock (`findOneAndUpdate`-style) so only one instance reaps. CPU/IO-heavy or retry-prone cleanup is better on a queue (Bull/BullMQ).
- Evidence: https://medium.com/geekfarmer/managing-distributed-cron-jobs-in-nestjs-from-basic-to-production-ready-solutions-7caed0cc14cf ; https://medium.com/@silverskytechnology/task-scheduling-in-nestjs-best-practices-for-cron-jobs-in-production-7c335ff53b58
- Relevance: Answers open point #3 (cleaner periodicity + concurrency safety). The retention sweeper (scan stopped `cap-aio-*` > retention days → remove) must carry an in-process `isRunning` guard so a slow docker-remove sweep never overlaps the next tick, and the design should state the single-instance assumption explicitly (or add a lock) given Dokploy could run multiple api replicas — tying back to the redeploy-must-not-reap concern.

---

## Route: Codebase (exact code points & integration seams)

Codebase research pins each abstract decision to an exact file/line and confirms the integration seams the new code plugs into.

### Surviving artifacts present; proposal/design/specs must be regenerated
The rebuilt artifacts (`spike-findings.md` + `design-baseline/history-replay-preview.html`) are present in the changeDir, but `proposal.md` / `design.md` / `specs/` are indeed missing and must be regenerated. The change dir has only `.openspec.yaml` (schema: spec-driven, created 2026-06-14), `spike-findings.md`, and `design-baseline/history-replay-preview.html`.
- Evidence: `openspec/changes/session-sandbox-retention/` listing — no `proposal.md`/`design.md`/`specs`
- Relevance: Confirms regeneration scope: proposal + design + specs must be authored to reference and stay consistent with the two surviving artifacts.

### Code point #1 — AutoRemove + teardown (the root cause)
`createContainer` sets `HostConfig.AutoRemove: true` (the root cause). `teardownSandbox` does `container.stop({t:0})` THEN `container.remove({force:true})`. Must flip `AutoRemove: false` and split teardown into stop-only (no remove) for retention.
- Evidence: `apps/api/src/sandbox/aio-sandbox.provider.ts:179` (`AutoRemove: true`), `:231-244` (`teardownSandbox` stop+remove)
- Relevance: Exact code point #1; the `AutoRemove` flag and `teardownSandbox` body are where container retention is enabled.

### Critical safety gap #7 — bootstrap reap force-removes ALL cap-aio-*
`onApplicationBootstrap` reap currently force-removes ALL `cap-aio-*` containers (filters by name prefix, `all: true`, then `remove({force:true})` on every match) with the comment "EVERY such container is by definition an orphan to reap." This MUST change to only remove RUNNING orphans, or a Dokploy redeploy / api restart wipes retained history containers.
- Evidence: `apps/api/src/sandbox/aio-sandbox.provider.ts:261-287` (listContainers `all:true` filter name `cap-aio-`, `Promise.all` remove force); `CONTAINER_PREFIX = 'cap-aio-'` at `:108`
- Relevance: Critical safety gap #7 — the reap must distinguish stopped/retained (keep) from running orphans (remove).

### Code point #2 — guardrails forceFail is the single teardown chokepoint
`forceFail` is the single chokepoint for all abnormal terminal causes (deadline/idle/circuit_breaker/provision_failed/abnormal_exit). Both `onTerminal` (natural completion) and `forceFail` call `sandbox.teardownSandbox(taskId)`; both are where stop-only must apply. `onTerminal` also handles the clean `recordExit`→completed path.
- Evidence: `apps/api/src/guardrails/guardrails.service.ts:442-460` (onTerminal teardownSandbox), `:544-572` (forceFail cause union + teardownSandbox), `:396-424` (recordExit maps exit→completed/failed/forceFail)
- Relevance: Code point #2 — guardrails is where completed + forceFail teardown becomes stop-only and where a retention cleaner would be wired. The cause union at `:546` enumerates exactly the 5 terminal causes the design must map to viewable states.

### No existing retention sweeper — the cleaner is the FIRST enforcer (corrects open point #3 framing)
There is NO existing retention sweeper for `session.log`/workspace today — the retention setting is stored but not enforced by any cleaner. The new retention cleaner has no prior art to coordinate with for those paths; it is net-new.
- Evidence: grep for cleanup/sweep/`@Cron`/`setInterval` in `apps/api/src` found only `resource-sampler.service.ts:336` (sampler timer) and `codex-device-login.service.ts:382` (login-container sweep) — neither touches `session.log`/workspace retention
- Relevance: Open point #3 — the design's claim that the new cleaner "coordinates with existing `session.log`/workspace retention" is aspirational; no such retention exists yet, so the cleaner is the FIRST retention enforcer.

### Closest reusable cleaner pattern — CodexDeviceLoginService
The closest reusable pattern for the retention cleaner is `CodexDeviceLoginService`: a `setInterval(60s)` sweep (`this.sweeper.unref()`) iterating sessions and calling `docker getContainer(name).remove({force:true})` past a TTL threshold. This is the model for a periodic stopped-container sweep.
- Evidence: `apps/api/src/settings/codex-device-login.service.ts:56-69` (sweeper setInterval 60_000 + unref), `:375-395` (sweep loop + remove force past TTL)
- Relevance: Reuse pattern for the retention cleaner: periodic unref'd `setInterval` + docker remove. Single-instance concurrency assumption matches the orchestrator's single-instance deployment model (per `aio-sandbox.provider.ts:255`).

### Decision C — retention window read from settings (default 30d)
Retention window is read from settings: `DEFAULT_RETENTION_DAYS = 30` (`RetentionDays` union), resolved as `stored?.retention ?? 30` in `settings-logic.ts`, persisted via `settings.service.ts` `coerceRetention`. The cleaner reads this same value.
- Evidence: `apps/api/src/settings/settings-logic.ts:43` (DEFAULT_RETENTION_DAYS=30), `:81` (retention ?? default); `apps/api/src/settings/settings.service.ts:112/465` (coerceRetention)
- Relevance: Decision C — retention follows account settings (default 30d). The cleaner injects `SettingsService`/`PrismaService` to read retention, mirroring how `GuardrailsService` injects prisma for the slot ceiling (`guardrails.service.ts:235-236`).

### Open point #1 — getArchive is net-new but on an established dockerode client
dockerode is already the docker client across the API (`new Docker()` in provider + resource-sampler). The provider already uses `listContainers`, `getContainer`, `.remove`, `.start`, `.stop`. For docker-cp reads the brief specifies, dockerode's `getContainer(id).getArchive()` is the API — NOT currently used anywhere, so it is net-new but on an established client. `.commit()` (resume, non-goal) is also unused.
- Evidence: `apps/api/src/sandbox/aio-sandbox.provider.ts:73` (new Docker()), `:263/271` (listContainers/getContainer/remove); `apps/api/src/metrics/resource-sampler.service.ts:745/771` (getContainer inspect/stats); grep found NO getArchive/putArchive/commit usage anywhere
- Relevance: Open point #1 — the session-history read endpoint will add the FIRST `getArchive` (docker cp) call against a stopped container; the dockerode client and patterns already exist to extend.

### New-endpoint precedent — GET /tasks/:taskId/metrics
New endpoint precedent is exact: `GET /tasks/:taskId/metrics`. `MetricsController` `@Get('tasks/:taskId/metrics')` delegates to `metrics.buildTaskResource(taskId)`, returns a discriminated `TaskResourceResponse` with explicit not-running state (not an error). The new `GET /tasks/:id/session-history` follows this controller shape and the not-running→degraded-state honesty pattern.
- Evidence: `apps/api/src/metrics/metrics.controller.ts:33-36` (@Get('tasks/:taskId/metrics') → buildTaskResource); auth via global APP_GUARD (no exemption) per controller doc `:9-14`
- Relevance: Reuse pattern for the new read endpoint: same controller convention, same global-auth gating, same "explicit honest state not an error" contract for the 404/expired/未能启动 degradations.

### Open point #7 — task terminal states map to the 5 honest UI states
Task terminal states are exactly: `completed`, `failed`, `cancelled`, `agent_failed_to_start` (`TERMINAL_TASK_STATUSES`). `provision_failed` is a forceFail CAUSE (guardrails), not a task status — it lands the task in `failed`. So the design's "5 honest states" map: completed→rollout; cancelled→rollout+interrupted terminal; failed→rollout-to-failure; agent_failed_to_start→empty; expired→empty (container reaped). `provision_failed` surfaces as failed-with-no-rollout.
- Evidence: `packages/contracts/src/task.ts:21-39` (TaskStatusSchema enum + TERMINAL_TASK_STATUSES); `guardrails.service.ts:546` (forceFail cause union includes provision_failed but `:558` transitions to `failed`)
- Relevance: Open point #7 — clarifies the state model: the UI degrades on `(status, rollout-present, container-present)`, where provision_failed/agent_failed_to_start have no rollout. The design稿 5 states (done/aborted/failed/nostart/expired) must map to these contract statuses.

### Decision D — session.log cold-replay already exists on a durable volume
`session.log` cold-replay is reusable: `SnapshotManager.buildReconnectFrames()`/`readTailFrames()` reads `workspaces/<id>/session.log` (raw PTY bytes) from the orchestrator volume — when no snapshot exists, "the whole of `session.log` is replayed." `SESSION_LOG_FILENAME = 'session.log'`; the volume survives orchestrator restart (multi-target-deploy spec).
- Evidence: `apps/api/src/terminal/snapshot.ts:29` (SESSION_LOG_FILENAME), `:189-211` (buildReconnectFrames replays whole log when no snapshot), `:226` (readTailFrames); `openspec/specs/multi-target-deploy/spec.md:47-56` (persistent volume survives restart)
- Relevance: Decision D (dual-source: rollout primary + session.log terminal-replay secondary). The terminal-replay source ALREADY exists on a durable volume independent of the container — the secondary tab can cold-replay `session.log` without docker cp; only the structured rollout needs the new container read.

### Code point #4 (web) — $taskId.tsx already has a terminal-state seam
The frontend session page `$taskId.tsx` already branches on `task.status`: it renders `PreRunningPlaceholder` for pending/queued, and computes `taskState` (failed/stopped/running) from `TERMINAL_TASK_STATUSES`. The read-only history-replay component plugs into the terminal-state branch (currently it just shows `SessionTerminal`). `SessionHeader` already takes `canStop` and hides controls for terminal tasks.
- Evidence: `apps/web/src/routes/_app/tasks/$taskId.tsx:62-66` (ssr:false route), `:115-121` (taskState from TERMINAL_TASK_STATUSES), `:178-196` (status-branched render), `:94-96` (canStop excludes terminal)
- Relevance: Code point #4 — the page already has the terminal-state seam; the new read-only replay component replaces/augments the `SessionTerminal` render for terminal statuses, and "no operation top-right" is already satisfied since `canStop` is false for terminal tasks.

### Code point #4 (web data plumbing) — strict real/mock capability seam
Frontend data plumbing is a strict real/mock capability seam. A new session-history query follows `taskResourceQuery` exactly: `queryOptions` with a `queryKeys.taskX(id)` tuple, `queryFn = isCapable(domain) ? real.X(id) : mock.X(id)`. `real.ts` uses `request(path)` + Zod `.parse` on a contracts schema. A new contract schema + capability flag + real/mock fns are required.
- Evidence: `apps/web/src/lib/api/queries.ts:65` (queryKeys.taskResource), `:121-127` (taskResourceQuery isCapable pattern); `apps/web/src/lib/api/real.ts:112/209-213` (request + Schema.parse); `apps/web/src/lib/api/capabilities.ts:36/68-77` (history flag, BACKEND_CAPABILITIES map)
- Relevance: Code point #4 (web) — integration path for the new read: add `SessionHistoryResponse` to `@cap/contracts`, a `queryKeys.sessionHistory(id)`, a `sessionHistoryQuery`, `real.getSessionHistory`, mock fallback, and a capability flag.

### Decision B — disk trim target is /home/gem/.codex, not /root/.codex
Disk trim target (decision B): the brief's `~/.codex` is at `/home/gem/.codex` (gem user, uid 1000, HOME=/home/gem) — NOT `/root/.codex`. The provider already writes there (`injectCodexAuth` dir=`/home/gem/.codex`). The trim (rm cache + `logs_*.sqlite`, keep sessions) and the `auth.json` security question both operate on this path inside the container before stop.
- Evidence: `apps/api/src/sandbox/aio-sandbox.provider.ts:426` (dir='/home/gem/.codex'), `:443` (auth.json there); `docker/aio-sandbox.Dockerfile:161-164` (HOME=/home/gem, gem user, /root/.codex never read)
- Relevance: Decision B + open point #6 — the pre-stop cache trim and the `auth.json` question both target `/home/gem/.codex`; the trim runs via the same `/v1/shell/exec` path the provider already uses, BUT only while the container is still running (before stop), so it slots into `teardownSandbox` before the stop call.

### Capability map — which specs to MODIFY vs ADD
The capability map (mapping change→spec): `aio-sandbox-execution` spec's provisioning Requirement currently mandates "AutoRemove enabled" verbatim — this MUST be deltaed. `guardrails` spec's deadline/idle/terminal-exit Requirements mandate `teardownSandbox()` calls that must become stop-only + add a retention requirement.
- Evidence: `openspec/specs/aio-sandbox-execution/spec.md:7` ("AutoRemove enabled" in provisioning requirement); `openspec/specs/guardrails/spec.md:38/86` (teardownSandbox() in deadline + terminal-exit requirements)
- Relevance: Confirms the capability mapping: the proposal's spec deltas must MODIFY `aio-sandbox-execution` (drop "AutoRemove enabled", add reap-only-running + cache-trim) and `guardrails` (stop-only teardown + retention cleaner), plus ADD `session-sandbox-retention` + `session-history-replay`, and MODIFY `frontend-console`.

### Open point #2 — design baseline state model drives frontend-render requirements
Design baseline state model is concrete and must drive the spec's frontend-render requirements: 5 states keyed in the HTML JS as `done/aborted/failed/nostart/expired`, each with label + card(replay|empty) + meta + termOn. Filter presets are exactly 默认/无工具/用户/答案/全部 with JS filter logic (答案 = user||final). Final-answer = green-tint + "最终回答" label; commentary = italic + muted left-border; tool-call = bordered card with inline token count.
- Evidence: `design-baseline/history-replay-preview.html:259-267` (states object), `:167-168` + `:242-251` (5 filter presets + filter JS), `:96-105` (commentary/final/tool-call CSS)
- Relevance: Open point #2 — the RolloutItem→UI mapping is anchored by this baseline: `response_item message[assistant]` splits into commentary vs final-answer; `function_call`/`function_call_output`→tool-call card; `event_msg token_count`→inline token; `message[user/developer]`→user bubble.

---

## Route: Archive (idioms, conventions & footgun avoidance from prior changes)

Archive research defines the exact deltas to copy verbatim, the decision idioms to reuse, and the apply-time scar to avoid.

### aio-sandbox-execution MODIFIED delta — copy the verbatim requirement header
The new change's exact code points are DEFINED by `archive/2026-06-04-migrate-execution-to-aio-sandbox`: its `aio-sandbox-execution` spec mandates `AutoRemove` enabled and `teardown = stop + remove` (the "Per-task AIO Sandbox container provisioning" requirement). This is the literal requirement the new change must MODIFY (flip AutoRemove→false, split teardown to stop-only). Reuse its requirement-header structure verbatim so the new delta is a clean MODIFIED block.
- Evidence: `openspec/changes/archive/2026-06-04-migrate-execution-to-aio-sandbox/specs/aio-sandbox-execution/spec.md:3-19` ; `proposal.md:8,14`
- Relevance: The capability mapping says "change `aio-sandbox-execution` (lifecycle: retention/cleancache/reap)." The canonical `openspec/specs/aio-sandbox-execution/spec.md` still carries the "Per-task AIO Sandbox container provisioning" header with AutoRemove — that is the verbatim header to copy into the MODIFIED delta.

### Decision idiom — lettered options + RESOLVED → (decisions A, B, F-security)
The DECIDED-option idiom to reuse for decision A (read-only only, resume deferred) and decision B (clean cache only) is `archive/2026-06-09-close-aio-execution-gaps`: it lays out lettered options (a/b/c/d) each with Pro/Con, then states "CHOICE: RESOLVED → option (c)" with rationale, and mirrors the same resolution in both `proposal.md` What-Changes and `design.md` Decisions + Open Questions. It also models the "spec MUST NOT overclaim" honesty guard.
- Evidence: `openspec/changes/archive/2026-06-09-close-aio-execution-gaps/design.md:103-157` (D2 options + RESOLVED), `proposal.md:7-9`
- Relevance: The session-sandbox-retention decisions (A: read-only-only with resume-run a verified-but-deferred follow-up; B: clean-cache trade-off; F-security: whether to clear `auth.json`) are exactly this shape. Copy the lettered-options-with-tradeoffs + RESOLVED→ pattern, and the "do not let the spec overclaim" guard for the honest-degradation 5-state rendering.

### guardrails delta pattern + the '> Note:' omitted-capability device
The guardrails capability delta pattern to reuse is `archive/2026-06-09-task-guardrail-controls`: it MODIFIES existing guardrails requirements AND adds a new "A terminal sandbox exit transitions the task and frees its slot" requirement, with an explicit "`> Note:`" in the proposal explaining why a sibling capability (audit-history) is deliberately NOT listed as modified. It also threads teardown through `forceFail` and slot-release — the exact chokepoint the new retention work changes to stop-only.
- Evidence: `openspec/changes/archive/2026-06-09-task-guardrail-controls/specs/guardrails/spec.md:42-60` ; `proposal.md:58-62` (the "> Note:" justifying an omitted capability)
- Relevance: The new change modifies guardrails (teardown→stop-only + new retention cleaner). The canonical `openspec/specs/guardrails/spec.md` already has the "A terminal sandbox exit transitions the task and frees its slot" header from this change — that is the requirement the new stop-only teardown MODIFIES. Reuse the "> Note:" device to justify why audit-history (or any sibling) is not in the delta.

### frontend read-only-replay delta follows the cockpit-redesign predecessor
The frontend read-only-replay UI delta should follow `archive/2026-06-14-session-cockpit-redesign` (the immediate predecessor): it MODIFIES the "Session page design-revision layout" and "Session page renders the live terminal and controls" requirements under the `frontend-console` capability, codifies the "honest degradation / no fabrication" idiom (D3: degrade to 未运行/未采样, never fabricate, drop unbacked fields), preserves invariants verbatim (`ssr:false`, `pendingComponent`, raw-bytes-bypass-Query), and ships a `design-baseline/*.html` export + pixel-gate.
- Evidence: `openspec/changes/archive/2026-06-14-session-cockpit-redesign/specs/frontend-console/spec.md:6-17,55-62` ; `design.md:53-63` (D3 honest degradation + D4 pixel gate)
- Relevance: The new change's "诚实降级 5 态" (已完成/已停止/失败/未能启动/已过期) is the same honest-degradation idiom — reuse D3's wording pattern. The replay UI is a new mode on the SAME `$taskId.tsx` surface these requirements govern, and `design-baseline/history-replay-preview.html` is already rebuilt, mirroring this change's design-baseline export convention.

### Avoid the cockpit-redesign apply-time descope scar
Avoid the cockpit-redesign trap of declaring a change "pure visual / read-only" then discovering a WS-path delta mid-apply: cockpit had to add a mid-stream "`> Descope (decided during apply)`" note and DEFER the state-lift because the live flow wasn't exercisable locally. Pre-commit the new change to read-only-only (no resume entry) up front and keep ALL backend reads (docker cp) off the live WS/PTY/lease path, so the same "descope during apply" scar is avoided.
- Evidence: `openspec/changes/archive/2026-06-14-session-cockpit-redesign/proposal.md:9-16` (Descope block) ; `design.md:33-41` (D1 DEFERRED during apply)
- Relevance: The session-sandbox-retention non-goals already say "no resume-run, no live WS/PTY/lease change." Hold that line in proposal/design from the start (resume verified-but-deferred per `spike-findings.md §D`) so the change does not repeat cockpit's apply-time descope; the docker-cp read endpoint must be a separate REST surface, never touching the terminal pipeline.

### Standard artifact set + side-car convention
Standard artifact set + side-car convention to reuse: every comparable change ships `proposal.md`, `design.md` (Context / Goals-Non-Goals / Decisions D1.. / Risks-Tradeoffs / Migration Plan / Open Questions), `specs/<cap>/spec.md` deltas (ADDED/MODIFIED requirement headers with `#### Scenario` WHEN/THEN), `tasks.md` (track-annotated with a partition-rationale comment block), a `research-brief.md` / `spike-findings.md` side-car explicitly marked "not a tracked OpenSpec artifact," a `.openspec.yaml` (schema: spec-driven + created date), and post-apply `verification-report.md` (three-way routing: reopened / spec-defect / reclassified-MET). New capabilities each get their own `specs/<name>/spec.md` with ADDED requirements.
- Evidence: `archive/2026-06-04-migrate-execution-to-aio-sandbox/{proposal,design,research-brief,tasks}.md + specs/*` ; `archive/2026-06-09-close-aio-execution-gaps/design.md:1-283` (full section skeleton) ; `archive/2026-06-14-session-cockpit-redesign/{.openspec.yaml,verification-report.md}`
- Relevance: The new change creates two NEW capabilities (`session-sandbox-retention`, `session-history-replay`) and modifies three (`aio-sandbox-execution`, `guardrails`, `frontend-console`). Each NEW cap → its own `specs/<name>/spec.md` with ADDED Requirements; each MODIFIED → a delta copying the canonical requirement header verbatim. `spike-findings.md` is already the side-car; mark it as such and reference it from proposal/design exactly like `research-brief.md` is referenced.

### tasks.md partition rationale grounded in real file coupling
`tasks.md` must be track-annotated with a partition-rationale comment grounded in REAL file coupling — the migrate change's `tasks.md` opens with a long HTML comment naming each shared file (`terminal.gateway.ts`, `sandbox.module.ts`, `guardrails.service.ts`) and routing co-edited files to a serial "## Integration" track. For the new change the two co-edited hot files are `aio-sandbox.provider.ts` (AutoRemove + teardownSandbox + onApplicationBootstrap reap + clean-cache, all in one file) and `guardrails.service.ts` (forceFail stop-only + new retention cleaner).
- Evidence: `archive/2026-06-04-migrate-execution-to-aio-sandbox/tasks.md:1-40` (partition rationale) ; `spike-findings.md:30-38,82-89` (same two files are the chokepoints)
- Relevance: The 必改代码点 list concentrates multiple edits in `aio-sandbox.provider.ts` and `guardrails.service.ts`. Use the migrate-change partition-comment style to declare those two files single-owner (or route shared touches to an Integration track) so parallel-apply does not collide on them.

### Reap-only-RUNNING is a MODIFIED delta to existing startup-recovery requirement
The "reap only RUNNING orphans" safety requirement has direct precedent in the guardrails capability's existing "Startup recovery reclaims orphaned tasks and re-offers queued tasks" requirement (added by the configurable-task-slots change). The new change MODIFIES the `onApplicationBootstrap` reap so it no longer force-removes ALL `cap-aio-*` (which would wipe retained history on Dokploy redeploy/api restart) — this is a MODIFIED delta to an already-existing guardrails/startup-recovery requirement, not a brand-new one.
- Evidence: `openspec/specs/guardrails/spec.md` header "Startup recovery reclaims orphaned tasks and re-offers queued tasks" (canonical) ; `spike-findings.md:85-87` (reap must spare stopped history) ; MEMORY configurable-task-slots-change
- Relevance: `spike-findings.md §F` and 必改代码点 #7 both flag the reap as the redeploy footgun. Routing it as a MODIFIED delta to the existing startup-recovery requirement (rather than a fresh ADDED one) keeps the spec coherent and reuses the verbatim-header convention these archives consistently follow.

---

## Implications for the proposal

Synthesizing across all three routes, the proposal/design/specs should be authored to the following concrete commitments:

1. **Build, not buy, the structured viewer — but cite prior art as the rendering contract.** No off-the-shelf component (Langfuse) gives an embeddable read-only transcript for this multi-tenant operator console (Web), so build the structured renderer. Anchor the spec's rendering contract on `masonc15/codex-transcript-viewer`'s parser and the rebuilt `design-baseline/history-replay-preview.html` (Codebase open point #2), so categories are cited prior art rather than invented.

2. **Categorization is keyed on the rollout `phase` field, not message ordering.** The load-bearing contract (Web finding, resolves open point #2): green-tinted "最终回答" keys off assistant `output_text` `phase == 'final_answer'`; `tool_call`↔`tool_output` link by `call_id`; user prompts may carry a developer/instruction wrapper that must be split on a delimiter before display. The 5 filter presets and CSS treatments are already fixed in the design baseline.

3. **Primary source = structured rollout via docker-cp from the STOPPED container; secondary = session.log cold-replay.** Decision D is validated on all routes: `getArchive`/docker-cp reads the frozen layer reliably while `AutoRemove:false` (Web open point #1; net-new but on the existing dockerode client per Codebase); `session.log` cold-replay already exists on a durable volume independent of the container (Codebase decision D), and half-painted-TUI-on-abnormal-stop is exactly why rollout must be primary (Web). Explicitly weigh and reject the Stop-hook alternative (unreliable on SIGKILL, the targeted case; never pass `--ephemeral`).

4. **Lifecycle change concentrates in two hot files — flip AutoRemove, split teardown, and fix the reap.** `aio-sandbox.provider.ts` (`AutoRemove:true`→`false`; `teardownSandbox` split to stop-only; pre-stop cache-trim of `/home/gem/.codex` via `/v1/shell/exec`; `onApplicationBootstrap` reap to RUNNING-orphans-only with a `cap-aio-*` label + age-gate) and `guardrails.service.ts` (`forceFail` + `onTerminal` stop-only; new retention cleaner). Partition `tasks.md` so these two single-owner files do not collide under parallel-apply (Archive).

5. **The retention cleaner is the FIRST enforcer and must be multi-policy + overlap-guarded.** It is net-new (Codebase corrects the "coordinates with existing retention" framing); model it on `CodexDeviceLoginService`'s unref'd `setInterval` + docker-remove (Codebase). Read retention days from settings (default 30, Decision C). Do not rely on age alone — add a free-disk high-water-mark guard evicting oldest stopped `cap-aio-*` first (Web open point #4), and carry an in-process `isRunning` guard with an explicitly stated single-instance assumption (Web open point #3), since Dokploy could run multiple api replicas.

6. **Reap safety is the redeploy footgun — route it as a MODIFIED delta to the existing startup-recovery requirement.** Only RUNNING orphans are removed; stopped retained history containers are PROTECTED via state + label + age filtering (Web open point #5 / Codebase gap #7 / Archive precedent). This keeps the spec coherent and avoids wiping history on Dokploy redeploy / api restart.

7. **Honest 5-state degradation, no fabrication.** Map contract terminal statuses to the design baseline states (Codebase open point #7): completed→rollout; cancelled→rollout+interrupted terminal; failed→rollout-to-failure; agent_failed_to_start→empty; expired→empty (reaped); provision_failed surfaces as failed-with-no-rollout. New read endpoint `GET /tasks/:id/session-history` follows the `GET /tasks/:taskId/metrics` controller convention (global-auth, discriminated response, not-running-is-a-state-not-an-error), with a matching `@cap/contracts` schema + web real/mock capability seam (Codebase code point #4).

8. **Security is acceptable-while-stopped but apply cheap defense-in-depth.** The container is the trust boundary, so world-readable `0644` rollout inside the stopped container is acceptable (Web). But the docker-cp endpoint MUST NOT export `auth.json`, and the design should clear/zero `/home/gem/.codex/auth.json` before stop as cheap defense-in-depth, folded into the same pre-stop trim (Codebase decision B + open point #6).

9. **Artifact set and decision idioms are prescribed.** Ship `proposal.md`, `design.md` (Context / Goals-Non-Goals / Decisions D1.. / Risks-Tradeoffs / Migration Plan / Open Questions), `specs/<cap>/spec.md` deltas (two ADDED capabilities + three MODIFIED with verbatim-copied canonical headers), and track-annotated `tasks.md`. Use the lettered-options + "CHOICE: RESOLVED →" idiom for decisions A/B/F-security and the "> Note:" device for any deliberately-omitted sibling capability (Archive). Pre-commit to read-only-only with resume verified-but-deferred, keeping the docker-cp read endpoint off the live WS/PTY/lease path to avoid cockpit-redesign's apply-time descope scar (Archive). `spike-findings.md` and this `research-brief.md` are side-cars, explicitly marked not-tracked.
