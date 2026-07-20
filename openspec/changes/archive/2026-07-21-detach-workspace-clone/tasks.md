<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time.
     CORRECTED partition (apply phase, verified against real file coupling):
     - old 6.4 moved into workspace-git-detach (3.7): the git_clone diagnostics observer
       emission lives in packages/sandbox/src/workspace/git.ts, Track 3's file; leaving it
       in guardrails-ownership would have two concurrent tracks writing the same file.
     - task-surfaces now also depends on guardrails-ownership: 7.3's stop path writes
       guardrails.service.ts / tasks.service.ts, which 6.1-6.3 also write.
     - old 6.5 (cross-track guardrails scenario re-proof) moved to the integration track:
       it spans spec surfaces owned by tracks 3/5/6/7 and its cancel scenario requires
       7.3's parked-aware stop to exist. Integration runs serially after all tracks. -->

## 1. Track: contracts-progress (depends: none)

- [x] 1.1 Add the additive nullable numeric-only `progress` object (percent, receivedObjects/totalObjects, receivedBytes, throughput) to `TaskProvisioningSummary` in `packages/contracts/src/task.ts`, keeping the schema `.strict()`; model indeterminate/unknown explicitly (AIP-151: unknown is never 0%)
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["contracts"]
  - verify: "contracts-registry"
- [x] 1.2 Add contract tests: strict-schema round-trip with progress absent, null, populated, and indeterminate-phase shapes; assert old payloads without the field still parse (contracts-first rollout safety)
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely"]
  - surfaces: ["contracts", "ci"]
  - verify: "contracts-registry"

## 2. Track: sandbox-detached-jobs (depends: none)

- [x] 2.1 Create the `sandbox-detached-jobs` module in `packages/sandbox-core`: `setsid` launch command builder plus a wrapper that runs the child, waits on it, and writes `/tmp/cap-jobs/<id>/{pid,progress,exit}` marker files (wrapper-waits-on-child is the spec requirement — exit marker + zombie prevention independent of image PID 1)
  - requirements: ["sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session", "sandbox-detached-jobs/a-wrapper-waits-on-the-job-child-and-writes-the-exit-marker", "sandbox-detached-jobs/jobs-expose-a-pid-progress-exit-marker-layout"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.2 Implement marker-probe triage with the three-way contract: pid alive → running/keep parked; exit marker present → settle from it; neither provable → fail the attempt; exit marker = settlement proof, progress file = output stream, success never inferred from progress silence
  - requirements: ["sandbox-detached-jobs/marker-probe-triages-a-job-three-ways"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.3 Implement atomic workspace publish for workspace-producing jobs: clone into a staging path, atomic rename/flip as the last wrapper step before the exit marker (half-written tree can never be triaged as success)
  - requirements: ["sandbox-detached-jobs/workspace-producing-jobs-publish-atomically"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.4 Implement the kill contract: kill via pid marker, idempotent, with no-resurrection guarantee after terminal settlement
  - requirements: ["sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.5 Add the additive clone-progress variant (percent/objects/bytes) on `SandboxWorkspaceProgressEvent`, preserving best-effort `reportProgress` semantics (dropped write is never an error; durable state stays authoritative)
  - requirements: ["sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress", "sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.6 Add dual-gate liveness knobs (no-progress heartbeat window ~90s, absolute cap ~1h) following the `snapshotSandboxProvisioningPolicy` min/max validation pattern
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 2.7 Unit tests: launch survives session teardown semantics, marker layout, triage three-way, atomic publish ordering, kill idempotence
  - requirements: ["sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session", "sandbox-detached-jobs/a-wrapper-waits-on-the-job-child-and-writes-the-exit-marker", "sandbox-detached-jobs/jobs-expose-a-pid-progress-exit-marker-layout", "sandbox-detached-jobs/marker-probe-triages-a-job-three-ways", "sandbox-detached-jobs/workspace-producing-jobs-publish-atomically", "sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 3. Track: workspace-git-detach (depends: sandbox-detached-jobs)

- [x] 3.1 Extend the clone builder in `packages/sandbox/src/workspace/git.ts` with `--progress` and `GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME` on the detached job; stderr redirected to the progress marker
  - requirements: ["sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.2 Implement the host-side git stderr progress parser: multiple stages (Counting/Compressing/Receiving objects/Resolving deltas), CR-delimited lines, explicit unknown phases before "Receiving objects"; unparsed lines count as "unknown phase, still alive"
  - requirements: ["sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.3 Replace `createOperationDeadline` for the `workspace_transfer` stage only with dual-gate liveness (heartbeat = progress-marker byte-growth/mtime advance; absolute cap as backstop); all other stages keep the existing deadline machinery
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.4 Rework `materializeSandboxGitWorkspaceStaged` behind the `SandboxGitStageExecutor` seam: launch detached job + short polling execs replace the single long-held exec; emit progress via the new event variant
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress", "sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.5 Plumb heartbeat/cap knobs through the deployment-environment path alongside `gitCloneTimeoutMs`
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 3.6 Tests: parser fixtures across git stderr variants, dual-gate scenarios (healthy-slow survives, stalled killed at heartbeat, cap backstop), staged loop over the detached path
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"
- [x] 3.7 Detached-job diagnostics: exactly one started + one terminal event per job through the existing observer (`git_clone` descriptor in `packages/sandbox/src/workspace/git.ts`); per-poll progress never enters the event ledger (bounded-ceiling rule)
  - requirements: ["task-provisioning-diagnostics/detached-job-lifecycle-is-bounded-events-per-poll-progress-is-excluded"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 4. Track: provider-polling (depends: workspace-git-detach)

- [x] 4.1 BoxLite: `workspace_transfer` stage execution moves to detached job + short polling execs; relax `boxlite-workspace-security` so a dropped poll settles from pid/exit markers instead of forcing whole-sandbox fencing
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.2 AIO: inherit the same detached path via the shared configured-provider hook; relax `aio-workspace-security` fencing identically
  - requirements: ["sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures", "sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 4.3 Provider tests: dropped-poll-then-marker-settlement, fencing no longer triggered by transient exec loss, kill path reaches the guest job
  - requirements: ["boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline", "sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 5. Track: admission-parking (depends: sandbox-detached-jobs)

- [x] 5.1 Additive Prisma migration: `parked` state plus progress-snapshot columns on the admission-work row; no destructive down-migration
  - requirements: ["repo-and-task-management/admission-settlement-supports-a-parked-state"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.2 Add `parked` to the settlement union (`task-admission.types.ts`) and the claim CTE (`prisma-task-admission.store.ts`); parked does not burn or reset attempts; parked rows recover via the existing expired-lease claim branch
  - requirements: ["repo-and-task-management/admission-settlement-supports-a-parked-state", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.3 Implement the lightweight parked poll loop outside `drainClaims` maxInFlight: observes markers only; on job exit re-enqueues through the existing semaphore/worker path with a new lease token; never admits, never touches slots, never reads DB on the offer() hot path
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "repo-and-task-management/admission-settlement-supports-a-parked-state"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.4 Persist the latest progress snapshot onto the admission-work row from the poll loop (source for the summary projection)
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "repo-and-task-management/admission-settlement-supports-a-parked-state"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.5 Add the cancellation port so stop can reach parked claims (kill-via-pid-marker seam exposed to the tasks layer)
  - requirements: ["sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection", "repo-and-task-management/operator-can-stop-a-running-or-queued-task"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 5.6 Worker/store tests: park → resume lifecycle, attempts semantics vs `queued`, new-lease re-enqueue, API-restart recovery through the expired-lease branch
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "repo-and-task-management/admission-settlement-supports-a-parked-state"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 6. Track: guardrails-ownership (depends: admission-parking)

- [x] 6.1 Re-stamp `ownerGeneration` to the new lease token at re-claim inside the same durable checkpoint write that fences the old token — atomic conditional compare against the parked generation so exactly one waker succeeds; strict equality checks elsewhere untouched (`guardrails.service.ts:922-925`, `956-962`)
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 6.2 Enforce lease fencing at the DB checkpoint-write point (Temporal stale-task-token pattern): a superseded holder's writes are rejected and it self-terminates
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 6.3 Keep the durable progress chain (line 941) and the legacy `snapshotSandboxProvisionContext` chain (line 2570) consistent — carry the progress variant through both, or explicitly retire the legacy chain (decide at apply per D11; no drifting chain remains)
  - requirements: ["guardrails/no-provisioning-chain-retains-blocking-transfer-semantics"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"

## 7. Track: task-surfaces (depends: contracts-progress, admission-parking, guardrails-ownership)

- [x] 7.1 Project the persisted progress snapshot into the nullable progress object in `taskProvisioningSummary()` (`task-response.ts`) — single projection point fanning out to Console, Public V1, and MCP; emission behind the deployment capability gate for mixed-version rollout
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "mcp-server/mcp-task-reads-surface-the-shared-provisioning-progress"]
  - surfaces: ["contracts", "public-v1", "mcp"]
  - verify: "public-surface-fast"
- [x] 7.2 Codify the boot-scan ownership split: provisioning-level marker probe owned by the admission claim/processor path alongside the `durableProtected` snapshot (alive → keep parked / exit marker → settle / unknown → fail attempt); `readoptSurvivorsOnStartup` unchanged for agent_launch+; no `onApplicationBootstrap` ordering dependence
  - requirements: ["sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption", "guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 7.3 Parked-aware stop: kill the detached job via the pid marker then run the existing fence/cleanup chain; stop persists its fence before crossing the physical boundary, resource observation is compare-and-set, late clone success never resurrects ownership; cleanup never replaces the primary failure cause
  - requirements: ["repo-and-task-management/operator-can-stop-a-running-or-queued-task", "sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 7.4 Tests: projection shapes across Console/V1/MCP payloads (progress absent vs populated vs indeterminate), boot triage three-way, stop-vs-exit-vs-resume race
  - requirements: ["repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes", "public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely", "mcp-server/mcp-task-reads-surface-the-shared-provisioning-progress"]
  - surfaces: ["public-v1", "mcp", "ci"]
  - verify: "public-surface-fast"

## 8. Track: console-timeline (depends: contracts-progress)

- [x] 8.1 Task-detail provisioning timeline: stage checklist derived from `TASK_PROVISIONING_STAGES` order vs `provisioning.stage`, delivered over the existing `TASK_DETAIL_POLL_INTERVAL_MS` 4s poll (no new transport)
  - requirements: ["frontend-console/task-detail-renders-a-provisioning-timeline-with-live-transfer-progress"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.2 Live transfer progress bar: determinate when percent is known, indeterminate for unknown phases (never rendered as 0%); wired alongside, not through, existing checkpoint events
  - requirements: ["frontend-console/task-detail-renders-a-provisioning-timeline-with-live-transfer-progress"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.3 Upgrade the existing `TaskProvisioningStatus` card to show the transfer percent alongside state/stage/attempt when the summary carries a known percent; unchanged rendering when the progress object is absent (same never-0% rule)
  - requirements: ["frontend-console/the-provisioning-status-card-surfaces-transfer-progress"]
  - surfaces: ["public-v1"]
  - verify: "openapi-playground"
- [x] 8.4 Web tests/states: timeline rendering across stages, progress bar determinate/indeterminate/absent, card percent vs unchanged fallback, graceful handling when the API omits the progress field (old backend)
  - requirements: ["frontend-console/task-detail-renders-a-provisioning-timeline-with-live-transfer-progress", "frontend-console/the-provisioning-status-card-surfaces-transfer-progress"]
  - surfaces: ["public-v1", "ci"]
  - verify: "openapi-playground"

## 9. Track: integration (depends: workspace-git-detach, provider-polling, admission-parking, guardrails-ownership, task-surfaces, console-timeline)

- [x] 9.1 Re-prove the guardrails scenario set: contention, expired-lease, restart, cancel, plus stale-waker-after-reclaim fencing and diagnostics ceiling assertions (spans guardrails/admission/tasks spec surfaces owned by multiple tracks; cancel requires 7.3's parked-aware stop)
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable", "guardrails/no-provisioning-chain-retains-blocking-transfer-semantics", "repo-and-task-management/admission-settlement-supports-a-parked-state", "repo-and-task-management/operator-can-stop-a-running-or-queued-task"]
  - surfaces: ["contracts", "ci"]
  - verify: "api-mcp"

## 10. Track: verify-reopened (depends: none)

- [x] 10.1 Wire the parked settlement into the production admission chain: `GuardrailsService.processDurableAdmission` never returns `{ kind: 'parked', job }`, so `TaskAdmissionWorker`'s parked branch (task-admission.worker.ts:708-729), `store.park()`, the parked poll loop, and `killParkedTask` are all production-unreachable — `provision()` blocks the maxInFlight worker slot for the entire workspace transfer, leaving the D3 slot-parking goal (scenarios "Parked transfer releases the worker slot", "Parking never burns attempts", "Restart recovers parked work via marker probe") undelivered. Extend the provider/provision seam so a detaching workspace transfer hands back a `TaskAdmissionParkedJobPort` and guardrails settles the claim as parked instead of blocking through `runDetachedWorkspaceTransfer`.
  - requirements: ["guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
- [x] 10.2 Wire the boot-time marker probe into the claim/processor path: `triageParkedAdmissionMarkers` (fenced-task-admission.processor.ts:53) has zero production call sites — `processDurableAdmissionOnce` never triages resumed parked rows (alive → keep parked / exit marker → settle stage / unknown → fail attempt), so a restart during a detached clone recovers only via the expired-lease running/retrying branch and re-runs the transfer from scratch instead of settling from the exit marker. Invoke the three-way triage from the claim path for parked-source claims (depends on V.1 making parked rows reachable).
  - requirements: ["sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption"]
  - surfaces: ["contracts"]
  - verify: "api-mcp"
