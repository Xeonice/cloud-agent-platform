# Verification Report — detach-workspace-clone

Date: 2026-07-20 (pass 1), 2026-07-21 (pass 2 — current)
Pass: verify (three-way routing adjudication)

## Pass 2 verdict summary (2026-07-21, current)

- Raw findings received: 0. Machine-routed public findings: 0 (the public-surface machinery ran without protocol errors this pass). Mandatory public findings: 0.
- Reopened as code tasks: 0.
- Spec defects: 0 new. The pass-1 archive-blocking verification-protocol defect is **RESOLVED** (see below).
- Reclassified MET: 2 requirement ids formerly reopened as code gaps (V.1/V.2) plus the 18 advisory static traces now stand as MET — all 20 requirement ids in this change re-trace end-to-end as satisfied.

### Pass 2 re-trace of the previously reopened gaps (not rubber-stamped)

1. **guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable** — now MET. Task 10.1 wired the parked settlement into the production chain, verified by direct code trace: `GuardrailsService.processDurableAdmission` passes `workspaceTransferDetachment: this.buildWorkspaceTransferDetachment(claim)` into the provision context (`apps/api/src/guardrails/guardrails.service.ts:986-987`); `runDetachedWorkspaceTransfer` throws `SandboxWorkspaceTransferDetachedSignal` immediately after launching the detached job when `detachment.park === true` (`packages/sandbox/src/workspace/git.ts:988`, resume path `:953`); the provider-center router deliberately re-throws the signal (`packages/sandbox/src/provider-center/router.ts:454`); guardrails converts it to `{ kind: 'parked', stage: 'workspace_transfer', job }` (`guardrails.service.ts:1061-1066`); the worker's parked branch persists `store.park()` then `registerParkedClaim` (`apps/api/src/task-admission/task-admission.worker.ts:708-729`), releasing the maxInFlight slot. The parked poll loop and `killParkedTask` are therefore production-reachable. Test evidence: `dist/task-admission/*.spec.js` + `dist/guardrails/*.spec.js` — 176/176 pass, including "production guardrails chain parks a detaching transfer and restart-recovers it through the expired-lease claim + marker triage".
2. **sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption** — now MET. Task 10.2 wired the marker probe into the claim/processor path: a claim resuming a parked row carries `parkedLeaseToken` from the store claim CTE (`apps/api/src/task-admission/prisma-task-admission.store.ts:200,508-545`); `buildWorkspaceTransferDetachment` attaches `resume.triage = triageParkedAdmissionMarkers` for exactly those claims (`guardrails.service.ts:1965-1982`); the resume path in `git.ts` gathers pid/exit/progress marker evidence through the sandbox exec seam and delegates the three-way decision BEFORE any relaunch (`packages/sandbox/src/workspace/git.ts:890-954`): `settle_from_exit` settles the stage from the exit marker (a finished clone is never re-run from scratch), `fail_attempt` fails typed/closed, `keep_parked` re-parks via the detached signal. Both same-process resume and API-restart recovery ride the same expired-lease claim branch, so there is no `onApplicationBootstrap` ordering dependence; the tmux half (`readoptSurvivorsOnStartup` excluding unfinished-admission candidates) was already met in pass 1. Test evidence: same 176/176 suite plus `packages/sandbox/test/detached-workspace-transfer.test.mjs` (24/24, incl. resume-settles-from-exit-marker, unprovable-fails-attempt, blocking-resume-re-enters-poll-without-relaunch) and `staged-workspace-git.test.mjs` (pass).

### Pass 2 resolution of the pass-1 blocking protocol defect

The pass-1 defect ("Unable to resolve a complete public-surface base diff. Set CAP_PUBLIC_SURFACE_BASE_SHA or configure a branch upstream", all 20 flagged requirements) is resolved at the root cause: the worktree is no longer detached-HEAD — it is on branch `detach-workspace-clone` with upstream `origin/main` (`git status -sb`, `branch.<name>.merge = refs/heads/main`), and `scripts/public-surface-files.mjs` now resolves and runs cleanly. Consistently, this pass's machine-routed public findings list is empty (pass 1 surfaced the protocol failure as 20 machine-routed `metadata-validation-failed` findings; pass 2 surfaced none). The 18 pass-1 "advisory static traces" below are therefore promoted to full MET verdicts, and the archive gate's condition 1 is cleared.

## Pass 1 verdict summary (2026-07-20, superseded)

- Raw findings received: 20 (all machine-routed public findings, `metadata-validation-failed`, route=spec-defect, blocking).
- Reopened as code tasks (independent re-trace found real production gaps): 2 — see `tasks.md` Track: verify-reopened.
- Spec defects (archive-blocking, verification-protocol): all 20 ids — see `design.md` Open Questions.
- Reclassified MET: 0. The machine-routed public findings may not be reclassified; the static verdicts below are folded here as **advisory static traces**, not as satisfying verdicts. Every requirement still requires the public-surface dynamic pass to run (currently impossible: `CAP_PUBLIC_SURFACE_BASE_SHA` unresolved).

## Blocking protocol defect (pass 1 — RESOLVED in pass 2, see above)

The deterministic public-surface CLI failed with "Unable to resolve a complete public-surface base diff. Set CAP_PUBLIC_SURFACE_BASE_SHA or configure a branch upstream." for all 20 public-surface-flagged requirements. Until the base SHA is configured and the dynamic pass re-runs, archive cannot accept the sidecar's public-impact claims. This is recorded as an archive-blocking spec defect in `design.md` Open Questions.

## Independent re-trace results

Each raw-unmet requirement was re-traced against the actual code (not rubber-stamped). Two genuine production gaps were found; the remaining 18 static traces held up under re-trace.

### Reopened (real code problems)

1. **guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable** — the parked half of the requirement is production-unreachable. Verified directly: the only production `TaskAdmissionProcessor` is `FencedTaskAdmissionProcessor` → `GuardrailsService.processDurableAdmission` (`apps/api/src/task-admission/task-admission.module.ts:62-65`), and `processDurableAdmissionOnce` / `processDurableAdmissionAfterCapacity` (`apps/api/src/guardrails/guardrails.service.ts:741-1028`) only ever return `{kind:'queued'|'succeeded'|'cancelled'|failure}` — never `{kind:'parked', job}`. The worker's parked branch (`apps/api/src/task-admission/task-admission.worker.ts:708-729`), `store.park()`, the parked poll loop, and `killParkedTask` are therefore dead in production; `provision()` blocks the maxInFlight slot for the entire transfer. Scenarios "Parked transfer releases the worker slot", "Parking never burns attempts", and "Restart recovers parked work via marker probe" cannot occur. The lease/contention/fencing/restart scenarios (non-parked) DO hold and are proven by passing suites (101/101 across worker/store/guardrails specs). Reopened as task V.1.
2. **sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption** — half met, half unwired. The tmux-exclusion half is real (`readoptSurvivorsOnStartup` skips unfinished-admission candidates; ordered bootstrap starts the worker last). But `triageParkedAdmissionMarkers` (`apps/api/src/task-admission/fenced-task-admission.processor.ts:53`) has zero production call sites (grep-verified), and since nothing ever parks (see above), the marker-probe half of the split cannot execute; a restart mid-clone recovers via the expired-lease running branch and re-runs the transfer from scratch, never settling from an exit marker. Reopened as task V.2.

### Advisory static traces that held (folded as met-as-written pending the dynamic pass)

These re-traced end-to-end as satisfied at the static level; they remain blocked solely by the protocol defect above.

- **boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline** — disk-size parse/bounds/ineligibility, resolved snapshot→`disk_size_gb`, capacity probe, and the separate Git deadline for delivery/push all trace as evidenced; the detached transfer's dual-gate is distinct from the retained single Git deadline per design.
- **frontend-console/task-detail-renders-a-provisioning-timeline-with-live-transfer-progress** — timeline checklist + live progress bar over the existing 4s poll; unknown percent never rendered as 0%; graceful degrade on absent summary; 17/17 component tests pass.
- **frontend-console/the-provisioning-status-card-surfaces-transfer-progress** — percent suffix only during `workspace_transfer` with a known percent; card unchanged otherwise; 14/14 tests pass.
- **mcp-server/mcp-task-reads-surface-the-shared-provisioning-progress** — all four MCP task ops delegate to the same `TasksService`/`listTaskPage` + `taskResponseFromRecord` projection with `mcp.outputProjection:'canonical'` and zero schema relaxation; e2e MCP tests assert provisioning parity. Minor coverage gap (no MCP-layer test with a populated numeric progress sub-object) does not block the primary scenario given byte-identical schemas.
- **guardrails/no-provisioning-chain-retains-blocking-transfer-semantics** — both durable and legacy chains reach the identical shared `createConfiguredWorkspaceMaterializationHook`, which unconditionally injects `detachedTransfer`; the blocking single-exec branch in `git.ts` is unreachable from `createConfiguredSandboxProvider` (proven dead by the test that must delete the field to exercise it). Note: production runs the detached transfer synchronously *within* provision (polling execs, dual-gate) — that satisfies this requirement's letter (no single blocking exec under the 15-min wall clock) even though slot-parking is separately unmet (V.1).
- **public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely** — strict shared schemas, single projection point, closed failure union, unchanged repo reads, single operations manifest; conformance suite incl. secret-canary non-leak assertions passes.
- **repo-and-task-management/operator-can-stop-a-running-or-queued-task** — fence-before-kill ordering, idempotent stop, no-resurrection all proven by passing suites. The "stopping a parked task" scenario is currently exercised via the active-claim cancellation path (cancellationSignal → `killAndSettle` → pid-marker kill of the detached clone), since parked claims cannot exist yet (V.1); the detached clone is still killed via its pid marker on stop, so the primary scenario is not blocked.
- **repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes** — strict numeric-only progress, fail-closed projection, `parked`→`running` vocabulary, platform-dependency failure classification, additive migration all trace cleanly.
- **repo-and-task-management/admission-settlement-supports-a-parked-state** — the settlement itself (distinct durable state, attempt-preserving park, expired-lease-only reclaim, additive migration) is implemented and store-tested as written. Production reachability of parking is the separate V.1 gap in guardrails; this requirement's own scenarios (support in the store/claim CTE/migration) are met-as-written.
- **sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures** — stable stages, one started + one terminal diagnostic, secret-free payloads, dual-gate liveness with bounded policy validation, cleanup-in-all-paths; 17/17 + staged-git suites pass.
- **sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress** — tolerant CR-aware parser, explicit-indeterminate (never 0%), best-effort delivery never settling the stage, `GIT_HTTP_LOW_SPEED_*` defense-in-depth; all scenario tests pass.
- **sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session** — `setsid` (never nohup), pid-marker-before-return, single shared implementation (zero setsid/nohup in either provider package), unit+functional tests pass. Session-survival under launcher-teardown remains for the dynamic pass.
- **sandbox-detached-jobs/a-wrapper-waits-on-the-job-child-and-writes-the-exit-marker** — foreground child, exactly-once tmp+rename exit marker, exit-marker-only settlement; functional shell tests pass. No explicit process-table zombie assertion (dynamic-pass item, non-blocking).
- **sandbox-detached-jobs/jobs-expose-a-pid-progress-exit-marker-layout** — `/tmp/cap-jobs/<id>/{pid,progress,exit}` layout, pid readable before launch returns, non-blocking mid-flight probe; 16/16 functional tests pass.
- **sandbox-detached-jobs/marker-probe-triages-a-job-three-ways** — alive/exited/unknown triage failing closed, exit-marker-only settlement, caller enforcement in the git.ts poll loop; tests pass. (The *admission-layer* mirror of this triage is the unwired half of V.2 — the sandbox-layer requirement itself is met.)
- **sandbox-detached-jobs/workspace-producing-jobs-publish-atomically** — same-filesystem sibling staging, publish-before-exit-marker, kill-the-group prevents late success markers; functional tests prove killed-mid-transfer and failed-child non-publish.
- **sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection** — TERM→KILL group kill, exit-marker-first idempotent kill, single-settle control flow; tests pass. Minor doc/impl mismatch: `reconcileSandboxDetachedJobSettlement`'s docstring claims caller-side enforcement but it has no production call sites — the guarantee actually lives in `runDetachedWorkspaceTransfer`'s single-settle-then-return flow. Met-as-written with a minor gap that does not block the primary scenario; fix the docstring (or wire the CAS helper) opportunistically.
- **task-provisioning-diagnostics/detached-job-lifecycle-is-bounded-events-per-poll-progress-is-excluded** — exactly one started + one terminal event per job, progress routed only to `onProgress`, timeoutMs from the gate's own window, no raw text/URLs on events; tests assert all of it.

## Gap findings

All 17 requirements across all 10 spec files in the `detach-workspace-clone` change have traceable implementation (confirmed by direct code inspection, not just tasks.md checkboxes): `packages/sandbox-core/src/detached-jobs.ts` for the detached-job primitive, `packages/sandbox/src/workspace/git.ts` for progress parsing and low-speed guards, `packages/sandbox-provider-boxlite/src/boxlite-client.ts` for `disk_size_gb`, `apps/api/src/task-admission/*` + `apps/api/src/guardrails/guardrails.service.ts` + `apps/api/src/tasks/tasks.service.ts` for parked admission/boot-split, `apps/api/src/tasks/task-response.ts` for the single progress projection, `apps/web/src/components/task-provisioning-timeline.tsx` / `task-provisioning-status.tsx` for the frontend, and `apps/api/src/mcp/mcp-tools.ts` (delegating through the shared `PUBLIC_V1_OPERATIONS`/task-response projection) for MCP/Public V1 parity.

```json
[]
```

Adjudicator amendment to the gap statement (pass 1): "traceable implementation" holds for all requirements, but this pass's re-trace shows two implementations are not *wired to production traffic* — guardrails never emits the parked settlement (V.1) and the admission-layer marker triage is never invoked (V.2). Traceability ≠ reachability; both are now tracked as open code tasks.

Pass 2 gap findings: none reported (`[]`), and the pass-1 reachability amendment no longer applies — both V.1 and V.2 are wired to production traffic (traced and test-proven above). Traceability and reachability now coincide for all 17 requirements across all 10 spec files.

## Scope findings

No scope-creep found.

I did a file-by-file comparison of every staged/unstaged change under this working tree (34 staged files across contracts, sandbox-core, sandbox, sandbox-provider-boxlite/aio, apps/api guardrails/tasks/task-admission, apps/web components, plus new untracked files like `packages/sandbox-core/src/detached-jobs.ts`, `apps/web/src/components/task-provisioning-timeline.tsx`, and the Prisma migration) against every requirement/scenario in `openspec/changes/detach-workspace-clone/specs/*/spec.md` and the task list in `tasks.md`.

Every implemented behavior I inspected traces cleanly to a specific task (1.1–9.1) and a spec scenario:

- Detached-job primitives (`packages/sandbox-core/src/detached-jobs.ts`) → `sandbox-detached-jobs/spec.md`
- Git stderr progress parser + dual-gate deadline pause/resume (`packages/sandbox/src/workspace/git.ts`) → `sandbox-provider-port/spec.md`
- BoxLite/AIO marker-settled exec relaxation → `boxlite-sandbox-provider/spec.md`
- Admission `parked` state, store `park`/`parkedHeartbeat`/`releaseParked`, worker's parked poll loop → `repo-and-task-management/spec.md` + `guardrails/spec.md`
- Ownership re-stamp at reclaim + shared workspace-progress chain (`guardrails.service.ts`) → `guardrails/spec.md`
- Boot-scan triage split (`fenced-task-admission.processor.ts`) → `sandbox-readoption/spec.md`
- Parked-aware stop (`tasks.service.ts`) → `repo-and-task-management/spec.md`
- Progress projection + capability gate (`task-response.ts`, `deployment-capability.ts`, `task.ts`) → `repo-and-task-management/spec.md` + `public-v1-api/spec.md` + `mcp-server/spec.md`
- Timeline/progress-bar/card UI (`task-provisioning-timeline.tsx`, `task-provisioning-status.tsx`) → `frontend-console/spec.md`, including the "numeric facts (percent, objects, bytes or throughput)" detail line that's explicitly named in the requirement text.

No debug leftovers (`console.log`/`debugger`/TODO) were introduced, and `surface-impact.json` accurately describes the touched public surfaces. I found no behavior implemented beyond what the specs call for.

Pass 2 scope findings: an independent second review of every diff under this working tree (contracts, sandbox-core, sandbox, sandbox-provider-boxlite/aio, apps/api guardrails/tasks/task-admission, apps/web components, the new detached-jobs/parked-triage/timeline files, and the Prisma migration) against every requirement and scenario in `openspec/changes/detach-workspace-clone/specs/*/spec.md` again found no behavior implemented beyond what the specs call for. Every piece traces cleanly: `packages/sandbox-core/src/detached-jobs.ts` → `sandbox-detached-jobs/spec.md` (setsid launch, marker layout, triage, atomic publish, kill); `packages/sandbox/src/workspace/git.ts` (parser, dual-gate pause/resume, detached transfer loop) → `sandbox-provider-port/spec.md`; the BoxLite/AIO marker-settled relaxation → `boxlite-sandbox-provider/spec.md`; `apps/api/src/task-admission/*` (`parked` state, `park`/`parkedHeartbeat`/`releaseParked`, parked poll loop) → `repo-and-task-management/spec.md` + `guardrails/spec.md`; `guardrails.service.ts` (ownership re-stamp, shared progress chain, D3/D9/D11 seams) → `guardrails/spec.md`; `fenced-task-admission.processor.ts` + `parked-admission-triage.ts` → `sandbox-readoption/spec.md`; parked-aware stop in `tasks.service.ts` → `repo-and-task-management/spec.md`; `task-response.ts` + `packages/contracts/src/{task,deployment-capability}.ts` → `repo-and-task-management/spec.md` + `public-v1-api/spec.md` + `mcp-server/spec.md`; the timeline/status components → `frontend-console/spec.md`; Prisma migration `20260720090000_add_task_admission_parking` is additive only. No debug leftovers in the new/changed production files. This corroborates the pass-1 conclusion above.

## Archive gate status

CLEAR (pass 2, 2026-07-21). Both pass-1 blocking conditions are resolved:

1. Verification-protocol defect: resolved — the worktree now has branch `detach-workspace-clone` with upstream `origin/main`, the public-surface CLI resolves its base diff and runs cleanly, and the pass-2 machine-routed public findings list is empty (zero `metadata-validation-failed`).
2. Code gaps: Track: verify-reopened tasks 10.1 and 10.2 are implemented and checked; `guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable` and `sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption` re-verified as MET (code trace + 176/176 api specs + 24/24 detached-transfer suite).
