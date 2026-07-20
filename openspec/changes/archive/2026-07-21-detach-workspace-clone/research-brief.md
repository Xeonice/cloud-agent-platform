# Research Brief — detach-workspace-clone

Synthesized findings from three parallel research routes (Web prior art / Codebase archaeology / OpenSpec archive history) for the change that detaches `git clone` from the blocking admission pipeline: detached job primitive with marker files, dual-gate liveness (no-progress heartbeat + absolute cap), admission-claim parking, clone progress on `TaskProvisioningSummary`, provisioning timeline UI, and boot-scan ownership split.

---

## Route: Web (external prior art)

### W1. Progress parsing via `--progress` + stderr regex is the established practice
Running `git clone --progress` with stderr redirected and regex-matching lines like `Receiving objects:\s+(\d+)%` is the cross-ecosystem norm. Git only emits progress to stderr, suppresses it without `--progress` when not attached to a TTY, and the stream has multiple stages (Counting / Compressing / Receiving objects / Resolving deltas) that a parser must handle separately — with CR-delimited (not LF) progress lines.
- Evidence: https://www.pythontutorials.net/blog/how-can-i-git-clone-a-repository-with-python-and-get-the-progress-of-the-clone-process/ ; https://github.com/steveukx/git-js/issues/265
- Relevance: directly validates decision (2) — detached `git clone --progress` with stderr → marker progress file, polled and regex-parsed. Parser must tolerate stage transitions and CR delimiters.

### W2. Conventional field names for clone-progress payloads
simple-git exposes a first-party `progress` handler reporting `{stage, progress%}`; nodegit's `transferProgress` reports `receivedObjects` / `totalObjects` / `receivedBytes`.
- Evidence: https://www.npmjs.com/package/simple-git ; https://github.com/nodegit/nodegit/issues/1167
- Relevance: prior art for decision (5)'s progress field shape — percent + receivedObjects/totalObjects + bytes/throughput mirrors mature git libraries, so the contract names won't be idiosyncratic.

### W3. Git-native stall detection: `http.lowSpeedLimit` / `http.lowSpeedTime`
Env `GIT_HTTP_LOW_SPEED_LIMIT` / `GIT_HTTP_LOW_SPEED_TIME`: if transfer rate stays below N bytes/sec for T seconds, git aborts itself; commonly ~1KB/s for 30-60s.
- Evidence: https://git-scm.com/book/en/v2/Git-Internals-Environment-Variables ; https://www.scivision.dev/cmake-git-inactivity-timeout/
- Relevance: cheap defense-in-depth for decision (4)'s ~90s no-progress watchdog — git kills a stalled transfer at the source with a clean nonzero exit into the exit marker file; the external no-byte-growth poller becomes a backstop rather than the only line of defense.

### W4. CI dual-gate precedent: no-output timeout + absolute cap (Travis / Buildkite)
Travis CI's canonical liveness design is a 10-minute no-output timeout ("assumed to have stalled…and is subsequently killed") plus a separate absolute build timeout, with `travis_wait` as escape hatch; Buildkite similarly separates job-run timeouts from wait timeouts.
- Evidence: https://docs.travis-ci.com/user/common-build-problems/ ; https://buildkite.com/docs/pipelines/configure/build-timeouts
- Relevance: direct precedent for decision (4)'s replacement of the single 15-min wall clock — a decade of CI practice confirms output/progress-based liveness catches real stalls far faster, while the absolute cap guards against progress-detection bugs.

### W5. Temporal formalizes the same dual gate: Heartbeat Timeout + StartToClose
Temporal pairs a short Heartbeat Timeout (detect a dead worker minutes into an hour-long activity) with a long StartToClose timeout; heartbeat payloads carry progress metadata so a retry can resume from the last checkpoint.
- Evidence: https://docs.temporal.io/encyclopedia/detecting-activity-failures ; https://temporal.io/blog/activity-timeouts
- Relevance: industry-standard naming/semantics for decision (4): the progress-file mtime/byte-growth check IS a heartbeat timeout; the ~1h cap IS start-to-close. Also supports storing progress data in the heartbeat channel (progress marker file) for re-adoption after API redeploy.

### W6. Temporal Async Activity Completion = admission-claim parking; stale-token gotcha
An activity returns without completing (freeing the worker slot); completion happens later via a task token. Documented gotcha: retries mint a new task token, leaving remote services holding an invalidated stale token — completion must be validated against the current token.
- Evidence: https://docs.temporal.io/develop/typescript/asynchronous-activity-completion ; https://docs.temporal.io/activity-execution
- Relevance: validates decision (3)'s parked-state + re-enqueue-with-new-lease-token design, and specifically the fencing of zombie holders: the "stale task token after retry" failure mode is exactly the split-brain the new lease token must guard against on re-admission.

### W7. Lease + monotonic fencing-token pattern; SQS heartbeat/watchdog analog
Holder heartbeats to keep the lease; the storage layer rejects writes bearing an older token when a paused/zombie holder wakes. SQS practitioners implement the same as heartbeat-driven visibility-timeout extension with watchdogs.
- Evidence: https://singhajit.com/distributed-systems/lease/ ; https://www.tecracer.com/blog/2023/03/the-beating-heart-of-sqs-of-heartbeats-and-watchdogs.html
- Relevance: grounds decision (3)'s lease fencing and decision (7)'s single-owner scan assignment — the fence must be enforced at the state-mutation point (DB checkpoint writes in guardrails.service.ts), not just at claim time.

### W8. kubernetes/git-sync: most mature "clone as supervised independent process"
Runs clone/fetch as its own process with `--sync-timeout`, retries with backoff, exit-code-driven exechooks/webhooks, tiered log verbosity, and — notably — atomic publish via worktree + named-symlink flip so consumers never observe a partially materialized tree.
- Evidence: https://github.com/kubernetes/git-sync (README)
- Relevance: strongest prior art for the overall reshape; the atomic-publish trick is worth borrowing for the workspace_transfer checkpoint so boot re-adoption's three-way marker triage (running/succeeded/failed) never mistakes a half-written workspace for success.

### W9. `nohup` alone is insufficient — the robust POSIX detach is `setsid` + wrapper wait
`nohup` only ignores SIGHUP while the child stays in the parent's session/process group; controlling-terminal destruction, broken stdio pipes, or group-wide reaping can still kill it. Robust detach: `setsid nohup cmd >log 2>&1 &` with `$!` captured to a pid file. Exit-code capture has no native support — it requires a wrapper that waits on the child and writes the status to a file.
- Evidence: https://blog.margrop.net/en/post/setsid-daemon-process-survival/ ; https://www.baeldung.com/linux/nohup-process-get-pid
- Relevance: directly shapes decision (1)'s sandbox-core primitive — use `setsid` (not bare nohup) since the spawning shell is a short-lived HTTP exec whose session is torn down immediately; the `/tmp/cap-jobs/<id>/exit` marker inherently requires the wrapper wait+write, matching the proposed pid/exit/progress marker layout.

### W10. Zombie hazard: detached wrapper reparents to container PID 1
If PID 1 is not a reaping init (tini / `docker --init`), exited children accumulate as zombies; Docker ships tini behind `--init` precisely for containers spawning background processes.
- Evidence: https://www.tutorialpedia.org/blog/docker-init-zombies-why-does-it-matter/ ; https://oneuptime.com/blog/post/2026-01-30-docker-init-process/view
- Relevance: practical hazard for decision (1) on both BoxLite and AIO — verify each sandbox image's PID 1 reaps orphans, or state as a requirement that the wrapper waits on the git process before exiting (the exit-marker design already forces this, which is what makes zombies impossible).

### W11. Google AIP-151: progress metadata on long-running operations
Progress lives on a metadata message polled via GetOperation; `progress_percent = -1` means unknown; define the metadata type upfront (never Empty) because fields are added additively.
- Evidence: https://google.aip.dev/151 ; https://cloud.google.com/storage/docs/using-long-running-operations
- Relevance: blesses decision (5)'s additive nullable progress field as the industry-standard contract shape; also suggests explicitly modeling "progress unknown" (clone phases before Receiving objects) rather than defaulting to 0%, so the UI can render indeterminate vs 0.

### W12. Coder: per-stage live provisioning logs are proven CDE UX — and fragile
Coder streams workspace-agent startup-script output through a ScriptLogger, each script under its own UUID log source, rendered live as "Show startup log". Real regression (#14257): logs from a second log source silently failed to stream.
- Evidence: https://deepwiki.com/coder/coder/3.1-agent-architecture ; https://github.com/coder/coder/issues/14257
- Relevance: closest OSS analog for decision (6)'s provisioning timeline UI; Coder's regression is a cautionary tale for wiring the new progress channel alongside the existing 12-stage checkpoint events without breaking either.

### W13. GitHub Codespaces: stage-label UX; the industry's slow-clone fix is prebuilds
Codespaces surfaces provisioning as discrete UI labels/stages plus a creation log; its headline mitigation for slow clones is prebuilds (repo already cloned in a snapshot), not faster in-line clone.
- Evidence: https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds ; https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle
- Relevance: confirms decision (6)'s stage-checklist UI matches category-leader UX, and frames decision (8)'s exclusions correctly — caching/prebuilds (excluded repo-mirror/partial-clone territory) is the eventual speed fix; this change is deliberately the observability+resilience layer that stays necessary even if caching arrives later.

---

## Route: Codebase (current implementation seams)

### C1. workspace_transfer is one blocking staged shell command today
`rm -rf && mkdir -p && git clone --no-checkout --single-branch` (no `--progress`), executed synchronously through `SandboxGitStageExecutor` with the remaining deadline as `timeoutMs`.
- Evidence: `packages/sandbox/src/workspace/git.ts:479-489` (clone command), `683-712` (executeStage passes remainingTimeoutMs/signal)
- Relevance: this is exactly the blocking long-exec being replaced with a detached job; the command-string builder and stage loop (`runMaterializationStage`, git.ts:517-587) are the surgical insertion points.

### C2. One shared hook covers both providers; clone chain never touches runtime fields
BoxLite and AIO both wire the identical `workspaceMaterialization: materializeSandboxGitWorkspaceStaged`.
- Evidence: `packages/sandbox/src/host-harness/configured-provider.ts:194` (BoxLite), `:344` (AIO); hook contract `packages/sandbox-core/src/workspace-git.ts:46-61`
- Relevance: confirms decision (1) — the detached-job primitive in sandbox-core behind `SandboxGitStageExecutor` (workspace-git.ts:40-44) is automatically provider-shared and runtime-agnostic (codex/claude-code inherit for free).

### C3. AIO stage executor = one long blocking HTTP exec; dropped response forces sandbox fencing
A dropped/timed-out HTTP response against `/v1/shell/exec` cannot prove the guest git process stopped, so today it force-removes the whole sandbox (`fenceSandboxAndConfirm`).
- Evidence: `packages/sandbox-provider-aio/src/aio-workspace-security.ts:97-127`; `aio-provider-controller.ts:1014`; BoxLite equivalent `packages/sandbox-provider-boxlite/src/boxlite-workspace-security.ts:259-300`
- Relevance: motivates the marker-file design — with detach + `/tmp/cap-jobs/<id>/{progress,exit,pid}`, short polling execs replace one long-held connection; pid/exit markers give settlement proof so a dropped poll no longer forces fencing.

### C4. Deadline machinery to replace: 15-min default, single wall-clock OperationDeadline
`DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS = 15*60_000` (min 1s / max 24h), flowing via deployment env (`gitCloneTimeoutMs`) and boxlite-config into an immutable per-claim `workspaceMaterializationDeadlineMs`.
- Evidence: `packages/sandbox-core/src/provisioning.ts:39-42`; `packages/sandbox/src/host-harness/deployment-environment.ts:105,148-149`; `apps/api/src/task-admission/task-admission.types.ts:34`; deadline object `packages/sandbox/src/workspace/git.ts:722-766`
- Relevance: decision (4)'s dual gate replaces `createOperationDeadline` for the transfer stage; `snapshotSandboxProvisioningPolicy` (provisioning.ts:100-121) is the validation pattern for new knobs.

### C5. The slot parking frees: maxInFlight=5, claim holds slot through entire process()
`drainClaims` is a bounded local dispatch pool; a claim holds its slot for the whole `processor.process()` call including the clone.
- Evidence: `apps/api/src/task-admission/task-admission-runtime.ts:69`; `task-admission.worker.ts:204-265` (drainClaims), `312-412` (processClaim holds until settle)
- Relevance: the parked poll loop must live outside drainClaims' maxInFlight accounting.

### C6. Settlement union is closed; 'queued' settlement resets attempt — parked must not
Settlement vocabulary: succeeded/queued/retrying/failed/cancelled; claim SQL re-claims 'accepted','queued','retrying' plus expired-lease 'running'. The 'queued' settlement with availableAfterMs is the existing release-and-reclaim pattern.
- Evidence: `apps/api/src/task-admission/task-admission.types.ts:8-19,76-101`; `prisma-task-admission.store.ts:90-157` (claim CTE; line 152 `WHEN queued THEN attempt`)
- Relevance: 'parked' is a new swimlane in both the settlement union and the claim CTE; parked must NOT burn/reset attempts the way queued does.

### C7. Checkpoint/replay machinery already fences stage re-entry
`onWorkspaceProgress` checkpoints on 'started'; `beforeWorkspaceBoundary` checkpoints/authorizes around each stage; the checkpoint API tolerates stage replay without regressing the stored stage (monotonic `TASK_ADMISSION_STAGE_ORDER`).
- Evidence: `apps/api/src/guardrails/guardrails.service.ts:941-952`; `task-admission.worker.ts:476-538` (stage order at 60-73)
- Relevance: the parked task resumes from the durable workspace_transfer checkpoint; the stage-order table already contains all 12 stages the UI timeline needs.

### C8. ⚠ Direct conflict: ownerGeneration === leaseToken check will fence the waker
Sandbox ownership sets `ownerGeneration = claim.leaseToken` and post-provision verifies strict equality, throwing LeaseLost on mismatch.
- Evidence: `guardrails.service.ts:922-925` (Object.freeze ownership), `956-962` (strict equality re-check)
- Relevance: "wake with a NEW lease token" collides head-on — ownership survival across parking requires either persisting/re-stamping ownerGeneration on re-claim or decoupling ownerGeneration from leaseToken; otherwise the resumed worker is treated as a zombie.

### C9. Boot recovery is already two-track; the split seam already exists
`readoptSurvivorsOnStartup` re-adopts agent-launched tasks via attested detached tmux sessions; pre-agent durable work is protected by a `durableProtected` snapshot ("a pre-agent sandbox has no tmux session yet and must not be mistaken for a legacy orphan") and recovered purely by the claim query's expired-lease branch.
- Evidence: `apps/api/src/tasks/tasks.service.ts:485-540` (ordered bootstrap, comment 487-489), `661+`; `apps/api/src/terminal/codex-launch.ts:48-76`; `prisma-task-admission.store.ts:105-106`
- Relevance: decision (7)'s scan-ownership split maps onto existing seams — the new provisioning-level marker probe belongs in the claim/processor path; agent_launch+ stays with readoptSurvivorsOnStartup; durableProtected is where the split is already "written once".

### C10. Stop-task cannot reach a parked task today
Stop reaches in-flight provisioning only via `TaskAdmissionCancellationPort.abortTask`, which aborts the same-process controller of an active claim run; executors then fence the sandbox.
- Evidence: `apps/api/src/tasks/tasks.service.ts:1663,2214`; `task-admission.worker.ts:160-165`; `aio-workspace-security.ts:100-103,114-124`
- Relevance: while parked there is no activeClaimRuns entry — stop needs a parked-aware path that kills the detached job (pid marker) then runs the existing fence/cleanup chain.

### C11. TaskProvisioningSummarySchema is .strict(); stage vocabulary complete
Strict fields: state/stage/attempt/resolvedBranch/updatedAt; `TASK_PROVISIONING_STAGES` already carries all 12 stages including workspace_transfer.
- Evidence: `packages/contracts/src/task.ts:112-125` (stages), `139-152` (strict schema, "shared by Console, Public V1, MCP, OpenAPI, and the API Playground")
- Relevance: decision (5)'s additive nullable progress object goes inside this one schema; because it is strict, any projection emitting the field before the schema change fails closed.

### C12. Exactly one server-side projection point → one change, three exits
`taskProvisioningSummary()` in task-response.ts; Public V1 reuses the same `taskResponseSchema.parse(taskResponseFromRecord(row))`.
- Evidence: `apps/api/src/tasks/task-response.ts:121,134-148`; `apps/api/src/v1/public-list-pages.ts:39`
- Relevance: one projection change fans out to Console / /v1 / MCP; the progress payload only needs to be persisted onto the admission-work row (or joined) and mapped here.

### C13. Progress event type carries no percent; reportProgress is best-effort
`SandboxWorkspaceProgressEvent` carries only status+stage; guardrails ignores everything except 'started'; reportProgress is fire-and-forget.
- Evidence: `packages/sandbox-core/src/provisioning.ts:297-306`; `packages/sandbox/src/workspace/git.ts:889-901`; `guardrails.service.ts:941-945`
- Relevance: decision (2)'s Receiving-objects percent needs a new additive variant on this reporter (or a parallel throughput reporter); the best-effort precedent ("durable work state remains authoritative") is the right semantics for progress writes.

### C14. UI delivery channel already exists: 4s poll; labels already exist
`TaskProvisioningStatus` renders only state pill + stage label + attempt + updatedAt; `TASK_PROVISIONING_STAGE_LABELS` and `TASK_DETAIL_POLL_INTERVAL_MS = 4000` exist; the detail page polls until terminal.
- Evidence: `apps/web/src/components/task-provisioning-status.tsx:51-105`; `apps/web/src/lib/task-provisioning.ts:13,46`; `apps/web/src/routes/_app/tasks/$taskId.tsx:108-109,226`; `$taskId_.transcript.tsx:128`
- Relevance: decision (6) needs no new transport — the 4s poll carries percent; the checklist derives from TASK_PROVISIONING_STAGES order vs provisioning.stage with zero new backend vocabulary.

### C15. Diagnostics channel for job lifecycle events already exists
Per-stage descriptors (replayKey `workspace.workspace_transfer`, commandKind `git_clone`), a task-provisioning-diagnostics module, and MCP `get_task_provisioning_diagnostics`; timeout diagnostics already record timeoutMs.
- Evidence: `packages/sandbox/src/workspace/git.ts:58-95,814-820`; `apps/api/src/task-provisioning-diagnostics/`; `guardrails.service.ts:912-914`
- Relevance: the detached job's started/polled/exit outcomes should emit through this existing observer, not a new channel.

### C16. ⚠ Second legacy provisioning chain must be kept consistent
A legacy path also passes `onWorkspaceProgress` into provision.
- Evidence: `guardrails.service.ts:2570` (legacy snapshotSandboxProvisionContext)
- Relevance: scope risk — forgetting the legacy chain reproduces the survive-api-redeploy class of split-brain bug the decision list explicitly wants to avoid. Keep both line 941 (durable) and line 2570 (legacy) consistent.

### C17. Submodules is a separate staged command at the same seam
`submodule sync --recursive && submodule update --init --recursive` immediately after checkout, same executor seam.
- Evidence: `packages/sandbox/src/workspace/git.ts:500-513`
- Relevance: decision (8) — detaching submodules is mechanical reuse of the same job primitive; cheap to evaluate, safe to defer.

---

## Route: Archive (OpenSpec history & house conventions)

### A1. Direct predecessor: 2026-07-16-fix-large-repo-task-provisioning
That change created everything this one reshapes — the TaskAdmissionWork durable worker (lease claim/renew/retry, the maxInFlight seam), the staged materialization state machine (Decision 2: credential setup → ref resolution → fetch/clone → checkout → submodules → cleanup), and the 15-minute clone deadline ("operation policy not control-plane timeout").
- Evidence: `openspec/changes/archive/2026-07-16-fix-large-repo-task-provisioning/design.md` (Decisions 2, 5)
- Relevance: frame this change as a second-generation revision of those exact decisions (deadline → dual-gate liveness, in-flight lease → parking); the staged hook in `packages/sandbox/src/workspace/git.ts` is the insertion point that change already established.

### A2. Existing guardrails requirement must be MODIFIED, not paralleled
fix-large-repo explicitly chose renew-while-active leasing and flagged the exact risk this change fixes ("Long clone leases expire during a healthy transfer → renew leases from stage/heartbeat events…"). The guardrails delta "Durable task admission is leased, idempotent, and restart-recoverable" encodes worker-SHALL-renew.
- Evidence: `archive/2026-07-16-fix-large-repo-task-provisioning/specs/guardrails/spec.md:3-13`; design.md Risks
- Relevance: the parking design must MODIFY that requirement (renew-while-active → release-slot-and-park with new-lease re-enqueue) or the specs will contradict. Its scenario set (two workers contend / expired-lease replay / restart recovery / cancelled never re-admitted / late superseded worker tears down) is exactly the vocabulary parking must re-prove.

### A3. Template: 2026-06-17-survive-api-redeploy (detached process + boot re-adoption)
Detached named tmux session, boot re-adoption replacing reap-and-fail; D4 identified liveness-based termination detection as "the primary regression surface… avoiding zombie running tasks that hold a slot forever."
- Evidence: `archive/2026-06-17-survive-api-redeploy/design.md` (D1-D7, esp. D3/D4)
- Relevance: its three-way boot triage (alive → re-adopt / dead → resolve exit / unknown → fail) maps 1:1 to the marker-file probe; the "zombie holding a slot forever" framing applies verbatim to parked tasks. Its post-ship split-brain bug (onApplicationBootstrap ordering across NestJS providers, fixed 042c8ea) is the incident behind decision (7) "scan ownership written down once" — cite it explicitly in Risks.

### A4. Empirical-spike convention + honest first-deploy caveat
survive-api-redeploy shipped a research-brief.md sidecar recording live spikes de-risking the mechanism before propose, and a migration plan admitting "the FIRST deploy still interrupts running tasks; ship when the queue is empty."
- Evidence: `archive/2026-06-17-survive-api-redeploy/proposal.md:5,9`; design.md Migration Plan
- Relevance: the setsid+marker primitive deserves the same — spike it live in both BoxLite and AIO before propose; copy the honest caveat (tasks mid-clone during the deploy shipping parking still run under old blocking semantics).

### A5. House style for additive strict-schema exposure: 2026-07-19-harden-task-provisioning-diagnostics
Versioned strict envelope with only numeric/enum safe facts (no free text), registry-driven Public V1 + MCP parity from one canonical schema, deployment capability gate for mixed-version rollout, rollback closes the gate first, no destructive down-migration.
- Evidence: `archive/2026-07-19-harden-task-provisioning-diagnostics/design.md` (Decisions 1, 7; Migration Plan)
- Relevance: the progress field must follow this discipline — percent/receivedObjects/totalObjects/throughput are numeric-only (compliant), one contracts change propagates via the registry, and a surface-impact.json sidecar is mandatory (present in every change since July).

### A6. Per-tick events are explicitly out of the diagnostics ledger
The diagnostics change excluded "Emitting an event for every BoxLite poll tick, output frame, or terminal byte" and enforces bounded per-attempt event ceilings, folding polls into start + one terminal event per logical operation.
- Evidence: same design.md, Decision 2 and Non-Goals
- Relevance: clone progress polling must NOT be routed into diagnostic events; progress belongs on the mutable provisioning summary projection, with at most stage start/terminal events in diagnostics. State this boundary explicitly to avoid a verify-time conflict.

### A7. Slot-pool decisions from 2026-06-10-configurable-task-slots constrain parking
Locked: one global pool, in-memory semaphore is the ONLY admission authority, offer() hot path stays free of DB reads, restart re-offers queued tasks two-phase, shrink never kicks running tasks.
- Evidence: `archive/2026-06-10-configurable-task-slots/design.md` (Context + Goals)
- Relevance: "task slot does NOT release during parking" is consistent with these decisions — but the parked poll loop must not become a second admission authority, and re-enqueue after job exit must go through the existing semaphore/worker path. Cross-reference all four decisions in the design.

### A8. Terminal-race vocabulary from 2026-07-20-harden-boxlite-native-exec-output-drain
Create-in-progress fence persisted before crossing the physical boundary, compare-and-set observed resource id, "late provisioning result cannot resurrect ownership after terminal cleanup has won," cleanup requires provider-backed absence evidence.
- Evidence: `archive/2026-07-20-harden-boxlite-native-exec-output-drain/proposal.md` (What Changes, items 6-7)
- Relevance: stop-during-parking is the same race shape (stop winning vs. clone job exiting vs. resumed worker claiming a new lease). Reuse the fence/CAS/no-resurrection vocabulary and the settlement-vs-output distinction: exit marker = settlement proof, progress file = output stream — never infer success from progress silence.

### A9. Artifact template and capability map
Structural template across all four relevant changes: proposal.md (Why / What Changes / Capabilities / Impact), design.md (numbered Decisions each with "Alternative considered", Risks as [risk] → mitigation, Migration Plan), track-annotated tasks.md, specs/<capability>/spec.md ADDED/MODIFIED deltas, surface-impact.json, verification.md with honest SKIP rows. Expected MODIFIED capabilities: sandbox-provider-port, boxlite-sandbox-provider, guardrails, repo-and-task-management, public-v1-api, mcp-server, frontend-console, task-provisioning-diagnostics, observability/resource-metrics, plus sandbox-readoption for the boot-scan split. Exactly ONE new capability is warranted — the runtime-agnostic detached-job primitive (e.g. sandbox-detached-jobs), mirroring how sandbox-readoption was minted for detached tmux.
- Evidence: `archive/2026-07-16-fix-large-repo-task-provisioning/tasks.md:1-10` + specs/; `archive/2026-06-17-survive-api-redeploy/specs/sandbox-readoption/`; `archive/2026-07-19-harden-task-provisioning-diagnostics/verification.md`
- Relevance: ship the same artifact set; track partitioning precedent (contracts-and-persistence → provider-port → boxlite → guardrails/worker → console/public surfaces → verification) maps cleanly onto the decision list. Reusing capability names keeps deltas mergeable at archive time; the new-capability precedent keeps AgentRuntime out of the spec surface.

### A10. Distilled avoid-list from archive history
(a) Do not rely on NestJS onApplicationBootstrap ordering between providers for the parked-scan vs agent-session re-adoption split (survive-api-redeploy live incident); (b) no second admission authority or DB reads on the offer() hot path (configurable-task-slots); (c) no per-poll progress in diagnostic events (diagnostics ceilings); (d) cleanup/stop must not replace the primary failure cause (diagnostics Decision 4); (e) partial clone/`--depth` was an explicit Non-Goal in fix-large-repo ("preserve full selected-branch history") — keep excluding it.
- Evidence: `archive/2026-07-16-fix-large-repo-task-provisioning/design.md` (Non-Goals, Decision 3); `archive/2026-07-19-harden-task-provisioning-diagnostics/design.md` (Decision 4)
- Relevance: these are traps prior changes either hit in production or fenced off with spec language; cite them as constraints so opsx-verify does not reopen settled decisions.

---

## Implications for the proposal

**Decision (1) — detached job primitive in sandbox-core.** Strongly validated by git-sync (W8) and the codebase seam (C1, C2): one helper change covers BoxLite + AIO and stays runtime-agnostic. Two hard requirements the web route adds: use `setsid` (not bare nohup) because the spawning shell is a short-lived HTTP exec (W9), and make wrapper-waits-on-child an explicit spec requirement — it is simultaneously what enables the exit marker and what prevents zombies regardless of the image's PID 1 (W10). Borrow git-sync's atomic-publish idea so a half-written workspace can never be triaged as success (W8 + boot triage in A3). Mint exactly one NEW capability (e.g. sandbox-detached-jobs) per the sandbox-readoption precedent (A9).

**Decision (2) — `--progress` + marker file parsing.** Cross-ecosystem standard (W1); parser must handle multiple stages, CR-delimited lines, and "unknown" phases before Receiving objects. In-codebase, the percent needs an additive variant on `SandboxWorkspaceProgressEvent` (C13) with the existing best-effort/fire-and-forget semantics — durable state stays authoritative. Set `GIT_HTTP_LOW_SPEED_LIMIT/TIME` on the detached clone as defense-in-depth (W3) so git self-terminates stalls into a clean exit marker.

**Decision (3) — admission-claim parking.** Temporal's Async Activity Completion is the exact analog (W6); the stale-token failure mode it documents is the split-brain to fence, and the fence must live at the DB checkpoint-write point, not only at claim time (W7). Three codebase landmines: (i) parked is a new swimlane in the settlement union AND the claim CTE, and must not burn/reset attempts the way 'queued' does (C6); (ii) the `ownerGeneration === leaseToken` strict-equality check will fence the waker as a zombie unless ownerGeneration is re-stamped or decoupled on re-claim — this is a direct design conflict that needs its own decision (C8); (iii) the parked poll loop lives outside drainClaims' maxInFlight accounting (C5). Spec-wise, MODIFY fix-large-repo's renew-while-active guardrails requirement rather than adding a parallel one, and re-prove its full contention/replay/recovery scenario set (A2). The parked loop must not become a second admission authority; re-enqueue goes through the existing semaphore/worker path (A7).

**Decision (4) — dual-gate liveness (no-progress ~90s + absolute cap ~1h).** Unambiguously the industry pattern: Travis/Buildkite no-output timeout + absolute cap (W4), Temporal Heartbeat + StartToClose (W5). The marker mtime/byte-growth check is a heartbeat timeout; name it that way. It replaces `createOperationDeadline` for the transfer stage only; new knobs follow the `snapshotSandboxProvisioningPolicy` min/max validation pattern (C4). Git-native low-speed abort (W3) makes the external watchdog a backstop rather than sole defense.

**Decision (5) — additive nullable progress on TaskProvisioningSummary.** AIP-151 blesses the shape and adds one refinement: model "unknown" explicitly (not 0%) so the UI can render indeterminate (W11). Field names follow simple-git/nodegit conventions (W2). The schema is `.strict()` and shared by all surfaces, so the contracts change must land before any projection emits it (C11); one projection point fans out to Console//v1/MCP (C12). Follow the diagnostics change's numeric-only/registry/capability-gate/surface-impact.json discipline (A5).

**Decision (6) — provisioning timeline UI.** Category-leader UX (Codespaces stages W13, Coder live logs W12). Zero new transport or backend vocabulary needed: the 4s task-detail poll delivers percent, and the checklist derives from TASK_PROVISIONING_STAGES vs provisioning.stage (C14, C7). Coder's second-log-source regression (W12) argues for wiring the new progress data alongside — not through — the existing checkpoint events. Crucially, per-poll progress must NOT enter the diagnostic event ledger (A6); detached-job lifecycle (started / terminal outcome) goes through the existing diagnostics observer (C15), progress goes on the mutable summary projection only. State this boundary explicitly in the design.

**Decision (7) — boot-scan ownership written down once.** The seam already exists: marker probe belongs in the claim/processor path (durableProtected snapshot + expired-lease reclaim), agent_launch+ stays with readoptSurvivorsOnStartup (C9). The design must cite the survive-api-redeploy bootstrap-ordering incident (042c8ea) as the motivating production bug and must not depend on onApplicationBootstrap ordering (A3, A10a). Exit marker = settlement proof; progress file = output stream; never infer success from progress silence — reuse output-drain's fence/CAS/no-resurrection vocabulary for the stop-vs-exit-vs-resume race (A8), and note stop needs a new parked-aware path since activeClaimRuns has no entry while parked (C10).

**Decision (8) — exclusions.** Codespaces confirms the industry's real slow-clone fix is prebuilds/caching — keeping repo-mirror/partial-clone out of scope is correct positioning; this change is the observability+resilience layer that remains necessary either way (W13). `--depth`/partial clone stays excluded, consistent with fix-large-repo's Non-Goal (A10e). Submodule detach is mechanical reuse of the same primitive at the same seam — cheap to evaluate, safe to defer (C17). The legacy provisioning chain (guardrails.service.ts:2570) must be kept consistent with the durable chain or explicitly retired — flag it in scope either way (C16).

**Process implications.** Before propose: live-spike the setsid+marker primitive in both BoxLite and AIO and record results in this brief's sidecar, per the survive-api-redeploy convention; include the honest first-deploy caveat (tasks mid-clone during the shipping deploy still run under blocking semantics) (A4). Ship the full house artifact set — proposal/design with numbered decisions + "Alternative considered", Risks as [risk] → mitigation, track-annotated tasks.md, capability spec deltas (MODIFIED for existing capabilities per A9's map, ONE new capability for the detached-job primitive), surface-impact.json, verification.md with honest SKIP rows for gated live E2E (A9). Cite the avoid-list (A10) as explicit constraints so verify does not reopen settled decisions.
