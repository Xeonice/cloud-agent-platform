# Proposal: detach-workspace-clone

## Why

`git clone` during workspace materialization runs today as one synchronous staged shell command under a single 15-minute wall clock (`packages/sandbox/src/workspace/git.ts:479-489`, `DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS`): a large-repo clone blocks its admission worker slot (maxInFlight=5) for the entire transfer, one long-held HTTP exec against the sandbox means a dropped response cannot prove the guest git process stopped (forcing whole-sandbox fencing), a healthy-but-slow clone is killed at 15 minutes while a stalled one survives up to 15 minutes, and the user sees only a static stage label with no transfer progress. This change detaches the clone into a supervised independent job in the sandbox, parks the admission claim so slots stay useful, replaces the single deadline with dual-gate liveness (no-progress heartbeat + absolute cap — the Travis/Buildkite/Temporal standard), and surfaces live clone progress end to end.

## What Changes

- **Detached-job primitive in sandbox-core** (`packages/sandbox-core`), behind the existing `SandboxGitStageExecutor` seam so BoxLite and AIO inherit it identically and it stays runtime-agnostic (codex/claude-code for free). Jobs launch via `setsid` (not bare `nohup` — the spawning shell is a short-lived HTTP exec whose session is torn down) with a wrapper that waits on the child and writes `/tmp/cap-jobs/<id>/{pid,progress,exit}` marker files. Wrapper-waits-on-child is a spec requirement: it is what makes the exit marker possible and prevents zombies regardless of the image's PID 1. Workspace publish is atomic (git-sync pattern) so a half-written tree can never be triaged as success.
- **Clone runs detached with `--progress`**, stderr redirected to the progress marker and regex-parsed (stage transitions, CR-delimited lines, explicit "unknown" phases before Receiving objects). `GIT_HTTP_LOW_SPEED_LIMIT/TIME` set as defense-in-depth so git self-terminates stalled transfers into a clean exit marker.
- **Admission-claim parking**: while the detached clone runs, the claim releases its worker slot via a new `parked` settlement (new swimlane in the settlement union and claim CTE; parked does NOT burn/reset attempts the way `queued` does). A lightweight poll loop outside `drainClaims`' maxInFlight accounting watches markers; on exit the task re-enqueues through the existing semaphore/worker path with a new lease token — the parked loop is never a second admission authority. Zombie holders are fenced at the DB checkpoint-write point (Temporal stale-task-token pattern). Resolves the direct conflict with the strict `ownerGeneration === leaseToken` equality check in `guardrails.service.ts` (re-stamp or decouple on re-claim — design decision).
- **Dual-gate liveness replaces the 15-minute wall clock for the transfer stage**: a no-progress heartbeat gate (~90s of no marker byte-growth/mtime advance) plus an absolute cap (~1h), replacing `createOperationDeadline` for `workspace_transfer` only; new knobs follow the `snapshotSandboxProvisioningPolicy` min/max validation pattern.
- **Clone progress on `TaskProvisioningSummary`**: one additive nullable numeric-only progress object (percent, receivedObjects/totalObjects, bytes/throughput — simple-git/nodegit field conventions; AIP-151 "unknown ≠ 0%" modeled explicitly) on the strict shared schema, landed contracts-first, projected once in `task-response.ts` and fanning out to Console, Public V1, and MCP. Per-poll progress is explicitly NOT routed into diagnostic events (bounded-ceiling rule); job lifecycle (started/terminal) goes through the existing diagnostics observer.
- **Provisioning timeline UI**: task-detail stage checklist derived from `TASK_PROVISIONING_STAGES` vs `provisioning.stage` with a live transfer progress bar, delivered over the existing 4s poll — zero new transport or backend vocabulary. The existing `TaskProvisioningStatus` card is upgraded in the same pass to show the transfer percent on compact surfaces.
- **Boot-scan ownership written down once**: provisioning-level marker probe (alive → keep parked / exited → settle from exit marker / unknown → fail) lives in the claim/processor path alongside the `durableProtected` snapshot; agent_launch+ re-adoption stays with `readoptSurvivorsOnStartup`. No dependence on NestJS `onApplicationBootstrap` ordering (the survive-api-redeploy 042c8ea incident). Exit marker = settlement proof; progress file = output stream; success is never inferred from progress silence.
- **Parked-aware stop**: stop-task gains a path that kills the detached job via the pid marker then runs the existing fence/cleanup chain (today `abortTask` only reaches active claim runs), reusing output-drain's fence/CAS/no-resurrection vocabulary for the stop-vs-exit-vs-resume race.
- The legacy provisioning chain (`guardrails.service.ts:2570`) is kept consistent with the durable chain or explicitly retired — in scope either way.
- **Exclusions**: no repo mirror/prebuild caching, no `--depth`/partial clone (fix-large-repo Non-Goal preserved), submodule detach deferred (mechanical reuse of the same primitive at the same seam).

## Capabilities

### New Capabilities

- `sandbox-detached-jobs`: runtime-agnostic detached-job primitive — `setsid` launch, wrapper wait, pid/progress/exit marker layout, marker-probe triage semantics, atomic workspace publish, and the stop/kill contract. (Mirrors how `sandbox-readoption` was minted for detached tmux.)

### Modified Capabilities

- `sandbox-provider-port`: workspace materialization contract gains the detached-job execution path and progress-reporting variant (percent/objects/bytes) on the workspace progress event; transfer-stage timeout semantics change from single deadline to dual-gate liveness.
- `boxlite-sandbox-provider`: BoxLite stage execution for `workspace_transfer` moves from one blocking exec to detached job + short polling execs; dropped-poll no longer forces sandbox fencing (exit/pid markers provide settlement proof). AIO follows via the shared hook.
- `guardrails`: MODIFY fix-large-repo's "leased, idempotent, restart-recoverable" requirement — renew-while-active during transfer becomes release-slot-and-park with new-lease re-enqueue; ownership generation survives parking; checkpoint writes enforce lease fencing; re-prove the contention/expired-lease/restart/cancel scenario set.
- `repo-and-task-management`: task admission settlement union and claim query gain `parked`; parked tasks resume without attempt burn; stop-task reaches parked tasks.
- `public-v1-api`: `TaskProvisioningSummary` gains the additive nullable progress object (strict schema, contracts-first).
- `mcp-server`: same summary projection surfaces progress through task tools.
- `frontend-console`: task detail renders the provisioning stage timeline + live clone progress.
- `task-provisioning-diagnostics`: detached-job lifecycle events (start + one terminal event per job) added; per-poll progress explicitly excluded from the event ledger.
- `sandbox-readoption`: boot recovery scan-ownership split codified — marker probe owned by the admission claim/processor path, tmux re-adoption unchanged for agent_launch+.

## Impact

- **Packages**: `packages/sandbox-core` (new detached-jobs module; progress event variant; dual-gate policy knobs), `packages/sandbox` (`workspace/git.ts` clone/stage loop; deployment-environment knobs), `packages/sandbox-provider-boxlite` + `packages/sandbox-provider-aio` (stage executor polling; workspace-security fencing relaxation), `packages/contracts` (`task.ts` strict summary schema — must land before any projection emits).
- **API**: `apps/api/src/task-admission/*` (settlement union, claim CTE, worker parked loop, cancellation port), `apps/api/src/guardrails/guardrails.service.ts` (ownership/lease fencing, both progress chains at lines 941 and 2570), `apps/api/src/tasks/` (task-response projection, stop path, boot scan split), `apps/api/src/task-provisioning-diagnostics/`.
- **Web**: `apps/web` task detail — provisioning timeline component over the existing 4s poll.
- **Data**: additive columns/state on the admission-work row for `parked` + progress snapshot; no destructive down-migration.
- **Rollout caveat**: tasks mid-clone during the deploy that ships parking still run under old blocking semantics; first deploy should land when the queue is quiet. Progress field follows the capability-gate discipline for mixed-version rollout; rollback closes the gate first.
- **Prior-change constraints honored**: single global slot pool / semaphore as sole admission authority (configurable-task-slots), diagnostics event ceilings (harden-task-provisioning-diagnostics), no bootstrap-ordering dependence (survive-api-redeploy), full-history clone preserved (fix-large-repo).
