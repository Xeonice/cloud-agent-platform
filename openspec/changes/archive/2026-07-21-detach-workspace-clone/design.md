# Design — detach-workspace-clone

## Context

Workspace materialization today runs `git clone` as one synchronous staged shell command under a single 15-minute wall clock (`packages/sandbox/src/workspace/git.ts:479-489`, `DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS`). Four coupled problems follow:

1. **Slot starvation** — the admission claim holds its worker slot (maxInFlight=5, `task-admission.worker.ts:204-265`) for the entire transfer.
2. **Fencing over-reach** — the clone is one long-held HTTP exec; a dropped response cannot prove the guest git process stopped, so both providers force whole-sandbox fencing (`aio-workspace-security.ts:97-127`, `boxlite-workspace-security.ts:259-300`).
3. **Wrong timeout semantics** — a healthy-but-slow clone is killed at 15 minutes while a fully stalled one survives up to 15 minutes.
4. **No progress UX** — the user sees a static stage label only.

Prior changes constrain the solution space (see Research Brief A1–A10): fix-large-repo established the staged materialization state machine and renew-while-active leasing; configurable-task-slots locked "semaphore is the sole admission authority, no DB reads on the offer() hot path"; survive-api-redeploy's 042c8ea incident forbids relying on NestJS `onApplicationBootstrap` ordering; harden-task-provisioning-diagnostics enforces bounded event ceilings and the numeric-only strict-schema discipline.

Stakeholders/surfaces: sandbox-core + both providers, task-admission worker + store, guardrails, contracts (`TaskProvisioningSummary`), Console / Public V1 / MCP, task-provisioning-diagnostics, boot recovery.

## Goals / Non-Goals

**Goals:**

- Detach `workspace_transfer` into a supervised independent job inside the sandbox; short polling execs replace the single long-held connection.
- Park the admission claim during the transfer so worker slots stay useful; resume through the existing semaphore/worker path.
- Replace the transfer-stage single deadline with dual-gate liveness: no-progress heartbeat (~90s) + absolute cap (~1h).
- Surface live clone progress end to end (contracts → API projection → Console/V1/MCP → timeline UI).
- Make boot-scan ownership for parked work explicit and ordering-independent.
- Give stop-task a parked-aware kill path.

**Non-Goals:**

- No repo mirror / prebuild caching (Codespaces-style prebuilds are the eventual speed fix; this change is the observability+resilience layer that stays necessary either way).
- No `--depth` / partial clone — fix-large-repo's "preserve full selected-branch history" Non-Goal is preserved.
- Submodule detach deferred (mechanical reuse of the same primitive at the same seam; separate change).
- No new transport for progress (no SSE/WS for the timeline; the existing 4s poll carries it).
- No per-poll progress events in the diagnostics ledger.

## Decisions

### D1. Detached-job primitive lives in sandbox-core behind the `SandboxGitStageExecutor` seam

One `sandbox-detached-jobs` module in `packages/sandbox-core`, consumed by `materializeSandboxGitWorkspaceStaged` — the hook both BoxLite and AIO already wire identically (`configured-provider.ts:194` / `:344`). Runtime-agnostic by construction: codex and claude-code inherit it with zero per-runtime code.

Launch contract: `setsid` (NOT bare `nohup` — the spawning shell is a short-lived HTTP exec whose session is torn down immediately; W9) starting a wrapper that runs git, **waits on the child**, and writes `/tmp/cap-jobs/<id>/{pid,progress,exit}` marker files. Wrapper-waits-on-child is a spec requirement, not an implementation detail: it is simultaneously what makes the exit marker possible and what prevents zombie accumulation regardless of whether the image's PID 1 reaps orphans (W10).

Workspace publish is atomic (git-sync pattern, W8): clone into a staging path, promote with an atomic rename/flip as the last wrapper step before the exit marker. A half-written tree can therefore never be triaged as success.

*Alternative considered:* per-provider detach implementations (BoxLite exec API vs AIO `/v1/shell/exec`) — rejected: duplicates the primitive, breaks runtime-agnosticism, and the shared hook seam already exists (C2). Also considered a host-side supervisor process — rejected: the job must survive API redeploy, so supervision state must live in the sandbox as files, not in API memory.

### D2. Clone runs detached with `--progress`; stderr is the progress marker; git-native stall abort as defense-in-depth

The detached command is the existing clone builder plus `--progress`, stderr redirected to `/tmp/cap-jobs/<id>/progress`. The host-side poller regex-parses it tolerating: multiple stages (Counting/Compressing/Receiving objects/Resolving deltas), CR-delimited (not LF) lines, and explicit **unknown** phases before "Receiving objects" (W1). `GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME` are set on the job so git self-terminates a stalled transfer into a clean nonzero exit marker (W3) — the external watchdog becomes a backstop, not the only line of defense.

Progress reporting reuses the existing best-effort `reportProgress` semantics (C13): a new additive variant on `SandboxWorkspaceProgressEvent` carries percent/objects/bytes; durable work state remains authoritative; a dropped progress write is never an error.

*Alternative considered:* `GIT_PROGRESS_DELAY`/porcelain machine-readable progress — git has no machine-readable clone progress; stderr regex is the cross-ecosystem norm (simple-git, git-js, python wrappers).

### D3. Admission-claim parking: new `parked` settlement; poll loop outside maxInFlight; re-enqueue through the existing semaphore

While the detached job runs, the claim settles as `parked` — a new swimlane in the settlement union AND the claim CTE (`task-admission.types.ts:8-19`, `prisma-task-admission.store.ts:90-157`). Parked does **not** burn or reset attempts the way `queued` does (C6): parking is not a retry event.

A lightweight poll loop lives outside `drainClaims`' maxInFlight accounting (C5) and only watches markers. On job exit it re-enqueues the task through the existing semaphore/worker path with a **new lease token**. The parked loop is never a second admission authority (configurable-task-slots constraint, A7): it observes and re-enqueues; only the semaphore admits.

Zombie fencing follows Temporal's stale-task-token pattern (W6): the fence is enforced at the DB checkpoint-write point in guardrails, not only at claim time (W7). A superseded holder waking up finds its writes rejected.

*Alternative considered:* keep the slot and renew-while-active with a longer deadline (fix-large-repo's original design) — rejected: it is exactly the slot-starvation problem being fixed. Also considered a dedicated "clone worker pool" — rejected: second admission authority, contradicts the locked one-global-pool decision.

### D4. Ownership survives parking by re-stamping `ownerGeneration` at re-claim, inside the fencing checkpoint write

Direct conflict (C8): sandbox ownership freezes `ownerGeneration = claim.leaseToken` and post-provision verifies **strict equality** (`guardrails.service.ts:922-925`, `956-962`) — "wake with a new lease token" would fence the legitimate resumed worker as a zombie.

Resolution: on re-claim after parking, `ownerGeneration` is re-stamped to the new lease token in the same durable checkpoint write that fences the old token. The write is atomic and conditional (compare against the parked generation), so exactly one waker can ever re-stamp; a stale waker's re-stamp attempt fails the compare and it self-terminates. Strict equality checks remain untouched everywhere else.

*Alternative considered:* decouple `ownerGeneration` from `leaseToken` into an independent generation counter — rejected: larger blast radius (every existing equality site must be audited and re-proven), while re-stamp-at-reclaim keeps the invariant "current owner generation === current lease token" true at all times and confines the change to one transition.

### D5. Dual-gate liveness replaces the single deadline — for `workspace_transfer` only

Two gates, industry-standard semantics (Travis/Buildkite no-output timeout, W4; Temporal Heartbeat + StartToClose, W5):

- **Heartbeat gate (~90s default):** no byte-growth/mtime advance on the progress marker for the window → job is declared stalled and killed via pid marker.
- **Absolute cap (~1h default):** guards against progress-detection bugs and pathological servers.

This replaces `createOperationDeadline` for the transfer stage only; all other stages keep the existing deadline machinery (C4). New knobs (heartbeat window, absolute cap) follow the `snapshotSandboxProvisioningPolicy` min/max validation pattern and flow through the same deployment-environment path as `gitCloneTimeoutMs`.

*Alternative considered:* just raise the 15-minute deadline — rejected: preserves both failure modes (healthy-slow killed at the new limit; stalled survives to the new limit). Heartbeat-only with no cap — rejected: a progress-parser bug could park a task forever.

### D6. Progress is an additive nullable numeric-only object on `TaskProvisioningSummary`, landed contracts-first

One nullable progress object added to the strict shared schema (`packages/contracts/src/task.ts:139-152`): percent, receivedObjects/totalObjects, receivedBytes, throughput — field conventions from simple-git/nodegit (W2), numeric-only per the diagnostics-change discipline (A5). "Unknown" is modeled explicitly (AIP-151, W11): pre-"Receiving objects" phases report indeterminate, never 0%, so the UI can distinguish indeterminate from zero.

Because the schema is `.strict()`, the contracts change must land before any projection emits the field — otherwise projection fails closed (C11). Exactly one server-side projection point (`taskProvisioningSummary()` in `task-response.ts`) fans out to Console, Public V1, and MCP (C12); the payload is persisted on the admission-work row and mapped there once. Mixed-version rollout follows the deployment capability-gate discipline; rollback closes the gate first.

*Alternative considered:* a separate progress endpoint — rejected: three surfaces would need three integrations; the single-projection fan-out already exists and the 4s poll already carries the summary.

### D7. Hard boundary: progress on the mutable summary; job lifecycle in diagnostics; never per-poll events

Per-poll progress is explicitly NOT routed into diagnostic events — the diagnostics ledger has bounded per-attempt ceilings and excludes per-tick events by spec (A6). The detached job emits exactly: one started event and one terminal event per job through the existing diagnostics observer (`git_clone` descriptor, C15). Progress lives only on the mutable provisioning-summary projection. Stating this boundary here is deliberate so opsx-verify does not reopen it.

### D8. Timeline UI derives from existing vocabulary over the existing 4s poll

Task-detail renders a stage checklist derived from `TASK_PROVISIONING_STAGES` order vs `provisioning.stage`, plus a live transfer progress bar (determinate when percent known, indeterminate otherwise). Delivery: the existing `TASK_DETAIL_POLL_INTERVAL_MS = 4000` poll — zero new transport, zero new backend vocabulary (C14). Progress data is wired **alongside**, not through, the existing checkpoint events (Coder's second-log-source regression #14257 is the cautionary tale, W12).

### D9. Boot-scan ownership written down once; no bootstrap-ordering dependence

The recovery split maps onto seams that already exist (C9):

- **Provisioning-level marker probe** — owned by the admission claim/processor path, alongside the `durableProtected` snapshot. Triage: pid alive → keep parked; exit marker present → settle from it; unknown → fail the attempt.
- **agent_launch+ re-adoption** — stays with `readoptSurvivorsOnStartup`, unchanged.

No dependence on NestJS `onApplicationBootstrap` ordering between providers — the survive-api-redeploy 042c8ea split-brain incident is the motivating production bug (A3, A10a). Settlement semantics: **exit marker = settlement proof; progress file = output stream; success is never inferred from progress silence.**

### D10. Parked-aware stop reuses the fence/CAS/no-resurrection vocabulary

While parked there is no `activeClaimRuns` entry, so `abortTask` cannot reach the task today (C10). Stop gains a parked path: kill the detached job via the pid marker, then run the existing fence/cleanup chain. The stop-vs-exit-vs-resume race is the same shape as output-drain's terminal races (A8): stop persists its fence before crossing the physical boundary, resource observation is compare-and-set, and a late clone success can never resurrect ownership after terminal cleanup has won. Cleanup never replaces the primary failure cause (A10d).

### D11. Legacy provisioning chain handled explicitly

The legacy `snapshotSandboxProvisionContext` chain (`guardrails.service.ts:2570`) also passes `onWorkspaceProgress`. It is kept consistent with the durable chain (line 941) or explicitly retired — in scope either way (C16). Leaving it drifting would reproduce the survive-api-redeploy class of split-brain bug.

## Risks / Trade-offs

- [Progress-parser misses a git stderr format variant → heartbeat gate sees no growth and kills a healthy clone] → mtime advance counts as heartbeat even when parsing fails; `GIT_HTTP_LOW_SPEED_*` means git itself distinguishes stall from slow; parser treats unparsed lines as "unknown phase, still alive".
- [Stale waker after re-claim (Temporal stale-token failure mode) writes with the old generation] → fencing enforced at the DB checkpoint-write point; conditional re-stamp in D4 admits exactly one waker.
- [Parked poll loop drifts into being a second admission authority] → spec language: the loop only observes markers and re-enqueues via the semaphore; it never admits, never touches slots, never reads DB on the offer() hot path (A7).
- [Boot ordering between marker probe and tmux re-adoption regresses (042c8ea class)] → single-owner split codified in D9; neither path depends on `onApplicationBootstrap` ordering; parked recovery rides the claim query's expired-lease branch.
- [Half-written workspace triaged as success after crash] → atomic publish (D1): the tree only becomes visible after the flip that precedes the exit marker.
- [Diagnostics ceiling breach from progress chatter] → D7 boundary: exactly start + one terminal event per job; per-poll data never enters the ledger.
- [Mixed-version rollout: old console/clients meet new progress field, or new console meets old API] → additive nullable field on a strict schema landed contracts-first; capability gate for emission; rollback closes the gate first (A5).
- [Zombie processes in images whose PID 1 does not reap] → wrapper-waits-on-child is a spec requirement (D1), making reaping independent of the image.
- [Legacy chain (2570) forgotten] → in-scope task with explicit keep-consistent-or-retire outcome (D11).

## Migration Plan

1. Contracts first: `TaskProvisioningSummary` progress object + additive progress-event variant land before any emitter.
2. Data: additive columns/state for `parked` + progress snapshot on the admission-work row; no destructive down-migration.
3. sandbox-core detached-jobs primitive + provider polling paths; dual-gate knobs with policy validation.
4. Admission worker: parked settlement, claim CTE, poll loop, re-stamp-at-reclaim, parked-aware stop, boot marker probe.
5. Surfaces: projection in `task-response.ts`, then Console timeline (V1/MCP inherit automatically).
6. **First-deploy caveat (honest, per A4):** tasks mid-clone during the deploy that ships parking still run under old blocking semantics; land the first deploy when the queue is quiet.
7. Rollback: close the progress capability gate first; `parked` rows recover via the existing expired-lease claim branch (a rolled-back API treats them as expired leases and retries under blocking semantics).

## Open Questions

- Exact default values for the heartbeat window (~90s) and absolute cap (~1h) — confirm against real large-repo clone traces before freezing knob defaults.
- Whether the legacy provisioning chain (D11) is retired in this change or kept consistent — decide at apply time based on remaining callers.
- Marker directory lifecycle (`/tmp/cap-jobs/<id>/`) on job completion: eager cleanup vs leave-for-diagnostics until sandbox teardown.
- **[RESOLVED 2026-07-21, verify pass 2 — no longer archive-blocking]** The defect below is closed at the root cause: the worktree is no longer detached-HEAD (branch `detach-workspace-clone` with upstream `origin/main` is configured), `scripts/public-surface-files.mjs` resolves and runs cleanly, and the pass-2 public-surface run produced zero `metadata-validation-failed` findings. The two doubly-blocked code gaps (Track: verify-reopened 10.1/10.2) are also implemented and re-verified MET (see `verification-report.md`, pass 2). Original record kept for audit:
- **[verify spec-defect, ARCHIVE-BLOCKING — public-surface verification protocol]** All 20 requirements in this change are flagged public-surface dynamic in task metadata, but the deterministic public-surface CLI could not run for ANY of them: "Unable to resolve a complete public-surface base diff. Set CAP_PUBLIC_SURFACE_BASE_SHA or configure a branch upstream" (findingType `metadata-validation-failed`). The declared verification protocol is therefore currently untestable as specified — every dynamic verdict is vacuously refuted and every static trace is advisory-only. Until `CAP_PUBLIC_SURFACE_BASE_SHA` is set (or a branch upstream is configured in this detached-HEAD worktree) and the public-surface pass re-runs, the change carries an unverifiable public-impact declaration and archive MUST stay gated. Affected requirement ids (all blocking): boxlite-sandbox-provider/boxlite-enforces-resolved-disk-capacity-and-a-separate-git-deadline; frontend-console/task-detail-renders-a-provisioning-timeline-with-live-transfer-progress; frontend-console/the-provisioning-status-card-surfaces-transfer-progress; guardrails/durable-task-admission-is-leased-idempotent-and-restart-recoverable; guardrails/no-provisioning-chain-retains-blocking-transfer-semantics; mcp-server/mcp-task-reads-surface-the-shared-provisioning-progress; public-v1-api/public-task-and-repository-reads-project-provisioning-truth-safely; repo-and-task-management/admission-settlement-supports-a-parked-state; repo-and-task-management/operator-can-stop-a-running-or-queued-task; repo-and-task-management/task-reads-expose-safe-provisioning-progress-and-failure-causes; sandbox-detached-jobs/a-wrapper-waits-on-the-job-child-and-writes-the-exit-marker; sandbox-detached-jobs/detached-jobs-survive-the-launching-exec-session; sandbox-detached-jobs/jobs-are-killable-through-the-pid-marker-with-no-resurrection; sandbox-detached-jobs/jobs-expose-a-pid-progress-exit-marker-layout; sandbox-detached-jobs/marker-probe-triages-a-job-three-ways; sandbox-detached-jobs/workspace-producing-jobs-publish-atomically; sandbox-provider-port/workspace-materialization-reports-bounded-stages-and-typed-failures; sandbox-provider-port/workspace-transfer-reports-parsed-clone-progress; sandbox-readoption/boot-recovery-scan-ownership-is-split-between-marker-probe-and-tmux-re-adoption; task-provisioning-diagnostics/detached-job-lifecycle-is-bounded-events-per-poll-progress-is-excluded. Note: this is a verification-protocol defect, not by itself proof of code defects — but independent re-trace ALSO reopened two real code gaps (see Track: verify-reopened in tasks.md: guardrails parked wiring V.1, boot marker probe V.2), so those two ids are blocked twice.
