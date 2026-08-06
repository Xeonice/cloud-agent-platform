# guardrails Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Concurrency semaphore bounds running tasks
The orchestrator SHALL enforce a maximum number of concurrently running tasks (the slot ceiling). The effective ceiling SHALL resolve as `persisted system setting ?? env MAX_CONCURRENT_TASKS ?? 5`: the persisted system-level setting (see `account-settings`) is authoritative once saved; the env variable `MAX_CONCURRENT_TASKS` is only the first-boot seed used when no persisted value exists. The ceiling SHALL be runtime-mutable without a process restart via a semaphore setter: a non-integer or non-positive value SHALL be rejected without changing the current ceiling; RAISING the ceiling SHALL immediately admit queued tasks in FIFO order until the new capacity is filled or the queue empties (no waiting for the next slot release); LOWERING the ceiling SHALL NOT interrupt, evict, or kill any running task — it SHALL only stop admitting new tasks while the running count exceeds the new ceiling, so the running count converges naturally as tasks release. When the limit is reached, newly created tasks SHALL remain queued rather than provisioning a sandbox, and when a running task reaches a terminal state (completed/failed/cancelled) the orchestrator SHALL admit the next queued task in FIFO order only while the running count is below the ceiling. The admission hot path SHALL NOT read the database: the in-memory ceiling is authoritative and is written only at bootstrap load and on a settings-save push.

#### Scenario: Task over the limit stays queued
- **WHEN** the effective ceiling of tasks are already running and a new task is created
- **THEN** the new task remains in the queued state and no sandbox is provisioned for it

#### Scenario: Freeing a slot admits the next queued task
- **WHEN** a running task reaches a terminal state while at least one task is queued and the running count is below the ceiling after release
- **THEN** the orchestrator provisions the oldest queued task, bringing the running count back to at most the effective ceiling

#### Scenario: Persisted setting overrides the env value
- **WHEN** the process boots with a persisted slot ceiling of N while `MAX_CONCURRENT_TASKS` is set to a different value M
- **THEN** the effective ceiling after bootstrap is N (the persisted value), not M

#### Scenario: Env seeds the ceiling only when no persisted value exists
- **WHEN** the process boots with no persisted slot ceiling
- **THEN** the effective ceiling is the value of `MAX_CONCURRENT_TASKS`, or 5 when the env variable is also unset

#### Scenario: Raising the ceiling promotes queued tasks immediately
- **WHEN** the ceiling is raised from N to N+k while the semaphore holds N running tasks and at least k queued tasks
- **THEN** the k oldest queued tasks are admitted in FIFO order immediately upon the raise, without waiting for any running task to release its slot

#### Scenario: Lowering the ceiling never evicts running tasks
- **WHEN** the ceiling is lowered below the current running count
- **THEN** no running task is interrupted, evicted, or transitioned by the resize; no new task is admitted while the running count exceeds the new ceiling; and as running tasks reach terminal states the running count converges down to the new ceiling, after which FIFO admission resumes

#### Scenario: Invalid ceiling value is rejected without effect
- **WHEN** the semaphore setter is invoked with zero, a negative number, or a non-integer
- **THEN** the call is rejected and the current ceiling, running set, and queue are unchanged

### Requirement: Wall-clock deadline force-fails a task
A task MAY carry a wall-clock deadline, supplied via the task create request (`deadlineMs`) and passed to concurrency admission (`admit(taskId, deadlineMs)`) so the deadline watcher arms. When a running task passes its deadline, the orchestrator SHALL transition it to `failed`, invoke `SandboxProvider.teardownSandbox()` for the task, and free its concurrency slot. Teardown is a **port-level** call: per design D9 the deferred minimal Docker provider documents it as a no-op (Docker is the deploy plane, not the per-task execution sandbox), while a future OS-isolating provider performs a real teardown through the same port. For the AIO provider, `teardownSandbox()` is STOP-ONLY (it stops and RETAINS the container, performing the pre-stop `/home/gem/.codex` trim + `auth.json` clear), so the frozen container survives for read-only session-history replay; the slot is still freed.

#### Scenario: Task exceeding its deadline is failed and torn down
- **WHEN** a running task's wall-clock deadline passes
- **THEN** the orchestrator transitions the task to `failed`, invokes `SandboxProvider.teardownSandbox()` for the task, and releases its concurrency slot

#### Scenario: Deadline teardown retains the container while freeing the slot
- **WHEN** a deadline force-fail invokes `teardownSandbox()` on the AIO provider
- **THEN** the container is stopped-and-retained (not removed) and the task's concurrency slot is still freed

#### Scenario: Task finishing before its deadline is unaffected
- **WHEN** a task reaches a terminal state before its deadline
- **THEN** no deadline-based force-fail is applied

### Requirement: Idle ceiling reclaims wedged tasks
Idle reclamation SHALL be OPT-IN PER TASK and OFF BY DEFAULT. The orchestrator SHALL track a running task's idle time (no terminal output and no agent-hook activity) and reclaim it on exceeding an idle ceiling ONLY when an idle ceiling is in effect for that task. An idle ceiling is in effect when the task carries an explicit per-task `idleTimeoutMs` (supplied via the task create request and passed through concurrency admission), OR when an operator-level global default is configured (`MAX_IDLE_MS`). When NEITHER is present — the default for a task created without an idle timeout in a deployment that has not set `MAX_IDLE_MS` — the task SHALL NOT be idle-tracked and SHALL NEVER be reclaimed for idleness, so a resident continuous-conversation session that is quietly waiting for the next input is not reclaimed. The per-task `idleTimeoutMs` SHALL take precedence over the operator-level default. The idle ceiling is per task (not a single process-wide constant): when armed, the timer is sized to that task's effective ceiling and activity resets it against that same ceiling.

When a configured idle ceiling trips, the integration layer SHALL transition the task to `completed` (the graceful end of a resident session that went quiet), NOT a force-`failed` — idle reclamation of a resident conversation is a normal end of life, distinct from an abnormal death. (This remains distinct from the shorter "awaiting input" notification driven by the `Stop` hook, which does not end the task.) When an idle reclamation tears down the sandbox, `SandboxProvider.teardownSandbox()` is STOP-ONLY for the AIO provider (the container is retained for read-only replay), and the slot is still freed.

#### Scenario: Task without an idle ceiling is never idle-reclaimed
- **WHEN** a task is created without an `idleTimeoutMs` and the deployment has no `MAX_IDLE_MS` configured, then runs silently past any prior 10-minute mark
- **THEN** the orchestrator does NOT idle-track the task and never reclaims it for idleness, holding its slot until it terminates by another path (operator stop, deadline, crash)

#### Scenario: Per-task idle ceiling reclaims an idle task as completed
- **WHEN** a task is created WITH an explicit `idleTimeoutMs` and then produces no terminal output and no hook activity for longer than that ceiling
- **THEN** the orchestrator transitions the task to `completed`, invokes `SandboxProvider.teardownSandbox()` for the task, and frees its slot

#### Scenario: Idle teardown retains the container while freeing the slot
- **WHEN** an idle reclamation invokes `teardownSandbox()` on the AIO provider
- **THEN** the container is stopped-and-retained (not removed) and the task's concurrency slot is still freed

#### Scenario: Operator-level default applies when no per-task value is given
- **WHEN** the deployment configures a global `MAX_IDLE_MS` and a task is created without a per-task `idleTimeoutMs`
- **THEN** the task is idle-tracked at the operator-level default ceiling

#### Scenario: Per-task value overrides the operator-level default
- **WHEN** a task supplies an `idleTimeoutMs` and the deployment also configures `MAX_IDLE_MS`
- **THEN** the task's idle ceiling is its own `idleTimeoutMs`, not the operator-level default

#### Scenario: Activity resets the idle timer against the task's own ceiling
- **WHEN** an idle-tracked task emits terminal output or a hook event before reaching its ceiling
- **THEN** the idle timer resets and the task is not force-failed, re-armed against that task's own ceiling rather than a process-wide constant

### Requirement: Circuit breaker on repeated start/turn failure
The orchestrator SHALL count consecutive agent-failed-to-start (and turn-failure) events for a task and, on reaching a configured threshold, SHALL circuit-break the task to `failed` without further automatic retry, preventing a burn loop. This accumulation applies to PROVISION-TIME / start failures (`agent_failed_to_start`) where a task may legitimately be retried before tripping; it SHALL NOT be the mechanism that reclaims a RUNNING task whose sandbox terminal session has exited. Under the connect-in execution model a running task's terminal WebSocket close is a single terminal event with no automatic re-launch, so that exit is handled by the terminal-exit requirement (which transitions the task and frees its slot on the FIRST exit), not by waiting for a threshold of consecutive failures.

#### Scenario: Threshold consecutive start failures trip the breaker
- **WHEN** a task accumulates the configured number of consecutive agent-start/turn failures
- **THEN** the orchestrator transitions it to `failed` and does not automatically retry

#### Scenario: A success resets the failure counter
- **WHEN** a task records a successful start/turn before reaching the threshold
- **THEN** the consecutive-failure counter resets to zero

#### Scenario: A single running-task exit does not wait for the breaker threshold
- **WHEN** a running task's terminal session exits once (cleanly or with a non-zero code)
- **THEN** the task is transitioned and its slot freed by the terminal-exit handling immediately, rather than remaining `running` until a threshold of consecutive failures is reached

### Requirement: A terminal sandbox exit transitions the task and frees its slot
When a running task's sandbox terminal session terminates (the connect-in terminal WebSocket closes and the orchestrator resolves an exit status), the orchestrator SHALL drive the task to a terminal lifecycle state and release its concurrency slot on that SINGLE exit — it SHALL NOT leave the task in `running` with a held slot. A resolved exit code of zero SHALL transition the task to `completed`; a resolved non-zero exit code SHALL transition the task to `failed`; an abnormal termination (the session never established, or the exit code is unresolvable) SHALL force-fail the task. In every case the orchestrator SHALL invoke `SandboxProvider.teardownSandbox()`, tear down the session-scoped credentials, and free the concurrency slot (admitting the next queued task), reusing the same terminal-teardown path as natural completion. For the AIO provider this `teardownSandbox()` is STOP-ONLY: the container is stopped and RETAINED (not removed), after the pre-stop `/home/gem/.codex` trim + `auth.json` clear, so the frozen `rollout-*.jsonl` survives for read-only session-history replay; the slot is still freed. This closes the gap whereby a cleanly-exited or single-non-zero-exit session previously remained `running` and leaked its slot until idle reclamation or a process restart — a gap that becomes a permanent leak once idle reclamation is off by default.

#### Scenario: Clean exit completes the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved code of zero
- **THEN** the orchestrator transitions the task to `completed`, tears down its sandbox and session credentials, and frees its concurrency slot

#### Scenario: Non-zero exit fails the task and frees the slot
- **WHEN** a running task's terminal session exits with a resolved non-zero code
- **THEN** the orchestrator transitions the task to `failed`, tears down its sandbox and session credentials, and frees its concurrency slot on that first exit

#### Scenario: Abnormal termination force-fails the task and frees the slot
- **WHEN** a running task's terminal session closes before being established, or its exit code cannot be resolved
- **THEN** the orchestrator force-fails the task, tears down its sandbox, and frees its concurrency slot

#### Scenario: Terminal-exit teardown retains the container while freeing the slot
- **WHEN** a terminal-exit transition invokes `teardownSandbox()` on the AIO provider for a completed, failed, or abnormally-terminated task
- **THEN** the container is stopped-and-retained (not removed) so its `rollout-*.jsonl` survives, and the task's concurrency slot is still freed

#### Scenario: Terminal teardown is idempotent under concurrent close handling
- **WHEN** the exit-driven terminal transition runs while the terminal gateway is also handling the same session's close
- **THEN** the teardown + slot release completes exactly once without error (double-calls to teardown and slot release are tolerated)

### Requirement: Startup recovery reclaims orphaned tasks and re-offers queued tasks
On application bootstrap the orchestrator SHALL perform a THREE-phase recovery so a process restart never strands work AND never needlessly kills a still-running task. Phase 0 (re-adopt): every task persisted as `running` or `awaiting_input` whose `cap-aio-<taskId>` container is still RUNNING AND whose detached codex tmux session (`task<taskId>`) is still alive SHALL be RE-ADOPTED — its provider/connection tracking re-registered, its terminal re-attached, its concurrency slot re-accounted in the semaphore, and its deadline/idle watchers re-armed from the persisted `deadlineMs`/`idleTimeoutMs` — and the task SHALL be KEPT in its current state (NOT transitioned to `failed`). Phase 1 (reclaim): every `running`/`awaiting_input` task that was NOT re-adopted in Phase 0 (its session/sandbox did not survive) SHALL be transitioned to `failed`. Phase 2 (re-offer): after the persisted ceiling override has been loaded into the semaphore, every task persisted as `queued` SHALL be re-offered to the concurrency semaphore in `createdAt` ascending (FIFO) order, restoring each task's persisted per-task guardrail parameters (`deadlineMs`, `idleTimeoutMs`) from its task row; tasks within the remaining capacity (after re-adopted tasks hold their slots) are admitted and the remainder stay queued in that order. A task persisted as `queued` SHALL NOT remain stranded after a restart.

The bootstrap container reap SHALL remove ONLY RUNNING `cap-aio-*` containers that were NOT re-adopted in Phase 0 (i.e. have no matching live task) — it SHALL NOT force-remove re-adopted running containers and SHALL NOT force-remove ALL `cap-aio-*` containers. It SHALL spare STOPPED/retained history containers by filtering on container STATE together with the `cap-aio-*` identity and an age filter, so a Dokploy redeploy or api restart PRESERVES both the re-adopted running task containers and the retained stopped session-history containers rather than wiping them.

#### Scenario: A still-running task is re-adopted, not failed
- **WHEN** the process restarts while the database holds a task in `running` whose `cap-aio-*` container and detached `task<taskId>` tmux session are still alive
- **THEN** bootstrap re-adopts the task (re-attaches its terminal, re-accounts its slot, re-arms its timers) and KEEPS it `running`, rather than transitioning it to `failed`

#### Scenario: A truly-dead running task is failed
- **WHEN** the process restarts while the database holds a `running`/`awaiting_input` task whose detached session did NOT survive (container gone or tmux session dead)
- **THEN** bootstrap transitions that task to `failed` before any queued task is re-offered

#### Scenario: Bootstrap reap spares re-adopted and stopped-retained containers
- **WHEN** the process restarts while RUNNING re-adopted `cap-aio-*` containers, RUNNING orphan `cap-aio-*` containers with no live task, and STOPPED retained history containers all exist
- **THEN** the bootstrap reap removes only the RUNNING orphans with no live task, and does NOT remove the re-adopted running containers or the stopped retained history containers

#### Scenario: Retained stopped containers survive a redeploy
- **WHEN** the api process is redeployed or restarted while stopped retained `cap-aio-*` containers from terminal tasks exist
- **THEN** those stopped containers are still present after bootstrap and remain readable for read-only session-history replay

#### Scenario: Queued tasks are re-offered in FIFO order at startup
- **WHEN** the process restarts while the database holds K tasks in `queued` and the effective post-re-adopt capacity is M
- **THEN** bootstrap re-offers all K tasks to the semaphore in `createdAt` ascending order, the oldest min(K, M) begin admission, and the remaining stay `queued` in that order rather than being lost

#### Scenario: Persisted guardrail parameters are restored on re-offer
- **WHEN** a re-offered queued task was created with a `deadlineMs` and/or `idleTimeoutMs` persisted on its task row
- **THEN** once that task is admitted after the restart, its deadline watcher and idle ceiling arm with those persisted values, identical to a task admitted before the restart

#### Scenario: The persisted ceiling is loaded before queued re-offer
- **WHEN** the process restarts with a persisted ceiling of 2, `MAX_CONCURRENT_TASKS=5`, and 3 queued tasks in the database
- **THEN** the re-offer admits up to the persisted ceiling of 2 (minus any slots held by re-adopted running tasks), not 5, proving the DB override is applied before the queued re-offer runs

### Requirement: Retention cleaner reaps stopped retained sandbox containers
The orchestrator SHALL run a periodic, unref'd retention cleaner (modeled on the existing `CodexDeviceLoginService` sweep) wired in the guardrails layer that removes STOPPED `cap-aio-*` containers under MULTIPLE simultaneous policies, removing a container when ANY policy trips. Policy 1 (age): a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window SHALL be removed, where the retention window is read from account settings (the persisted retention-days value, default 30 days when unset). Policy 2 (free-disk high-water-mark): when host free disk drops below a configured floor, the cleaner SHALL evict OLDEST-stopped `cap-aio-*` containers FIRST until free disk recovers above the floor, even if those containers are younger than the retention window. The cleaner SHALL only remove containers that are STOPPED and carry the `cap-aio-*` identity, and SHALL NEVER remove a RUNNING container. The cleaner SHALL carry an in-process `isRunning` overlap guard so a slow sweep never overlaps the next tick; the single-instance assumption SHALL be stated explicitly (no distributed lock).

#### Scenario: A stopped container past the retention window is reaped
- **WHEN** the cleaner sweeps and finds a stopped `cap-aio-*` container whose stopped age exceeds the configured retention window
- **THEN** the cleaner removes that container

#### Scenario: Retention window is read from settings with a 30-day default
- **WHEN** the cleaner resolves the retention window and no retention-days value is persisted in account settings
- **THEN** it uses a default of 30 days, and when a value IS persisted it uses that persisted value instead

#### Scenario: Low free disk evicts the oldest stopped containers first
- **WHEN** host free disk is below the configured high-water-mark floor and stopped `cap-aio-*` containers younger than the retention window exist
- **THEN** the cleaner removes the OLDEST-stopped containers first until free disk recovers above the floor

#### Scenario: Running containers are never reaped
- **WHEN** the cleaner sweeps while a `cap-aio-*` container is RUNNING, regardless of age or free-disk level
- **THEN** the cleaner does not remove that running container

#### Scenario: Overlapping sweeps are prevented by the in-process guard
- **WHEN** a cleaner sweep is still in progress and the next scheduled tick fires
- **THEN** the second tick is skipped by the `isRunning` guard and only one sweep runs at a time

### Requirement: Terminal teardown captures the task rollout to durable storage
The guardrails service SHALL invoke a best-effort transcript capture at BOTH
terminal chokepoints — `onTerminal` (natural completion) and `forceFail` (all
abnormal causes: deadline, idle, circuit-breaker, abnormal-exit,
provision-failed) — persisting the task's codex rollout to durable storage while
the container is still present, immediately before (or around) the existing
stop-only `teardownSandbox`. The capture SHALL NOT change the stop-only teardown
or slot-free semantics, and SHALL NOT block, delay, or fail them: a capture error
SHALL be logged and swallowed so the terminal transition and slot release proceed
unconditionally.

#### Scenario: Natural completion captures before stop-only teardown
- **WHEN** `onTerminal` fires for a task reaching a natural terminal state
- **THEN** the guardrails service invokes the best-effort transcript capture while the container is still present, then performs the existing stop-only `teardownSandbox`

#### Scenario: Force-fail captures before stop-only teardown
- **WHEN** `forceFail` fires for any abnormal cause (deadline, idle, circuit-breaker, abnormal-exit, provision-failed)
- **THEN** the guardrails service invokes the best-effort transcript capture while the container is still present, then performs the existing stop-only `teardownSandbox`

#### Scenario: Capture failure does not block the terminal transition or slot release
- **WHEN** the transcript capture throws or fails during a terminal teardown
- **THEN** the error is logged and swallowed, and the task's terminal transition, stop-only teardown, and slot release proceed unaffected

### Requirement: Guardrails carry selected provider context through the task lifecycle

After provisioning succeeds, guardrails SHALL retain or resolve the selected
provider run context for terminal monitoring, delivery, transcript capture,
teardown, diagnostic correlation, and slot release. After a provider resource
may have been created but provisioning has not succeeded, guardrails SHALL retain
enough attempt-scoped cleanup ownership to confirm removal or reconcile the
resource without publishing it as a usable successful run. Guardrails SHALL NOT
rediscover a provider by concrete implementation class once a task is
provisioned and SHALL NOT discard partial ownership merely because the task has
already reached a terminal lifecycle state. Automatic exact-owner reconciliation
SHALL use admission-v2's fenced `SandboxRun`; legacy admission SHALL retain only
CAP-generated correlation and cleanup evidence for diagnosis and
SHALL NOT create a second automatic ownership authority.

#### Scenario: Terminal completion uses the owning provider

- **WHEN** a BoxLite-backed task reaches terminal completion
- **THEN** guardrails performs transcript capture, delivery if requested, teardown, diagnostic settlement, and authority-gated slot release through the BoxLite owner context

#### Scenario: Provision failure does not expose a successful owner state

- **WHEN** provider provisioning or runtime preflight fails after a provider resource may have been created
- **THEN** guardrails marks the task failed through the existing provision-failure path and exposes no usable successful provider owner
- **AND** durable ownership remains throughout pending cleanup and is relinquished only after confirmed absence or an atomic terminal-policy failure, while legacy admission records only CAP-generated correlation and bounded cleanup evidence

### Requirement: Provider preflight happens before long-running admission is committed

Static provider preflight and selected runtime/image preflight SHALL run before a task is treated as successfully admitted to a long-running sandbox session. A failed preflight SHALL fail the task with a distinct provider preflight reason and SHALL release or avoid consuming the concurrency slot.

#### Scenario: BoxLite image preflight fails before launch
- **WHEN** the selected BoxLite image is missing required runtime tooling
- **THEN** the task fails with a provider preflight error before terminal launch and credential injection

#### Scenario: Failed preflight releases the slot
- **WHEN** a task has been admitted but provider preflight fails
- **THEN** guardrails releases the task's concurrency slot and offers the next queued task according to existing FIFO rules

### Requirement: Bootstrap recovery delegates to provider registry

Startup recovery SHALL re-adopt or reclaim running tasks by asking the owning provider or compatible readoption providers, not by scanning only local AIO container names. The bootstrap reap SHALL spare running tasks that a provider re-adopts and SHALL spare stopped retained artifacts from every provider.

#### Scenario: BoxLite running task is re-adopted on restart
- **WHEN** the API restarts while a BoxLite-backed task is running and its detached session is alive
- **THEN** bootstrap re-adopts the task through the BoxLite provider and keeps it running

#### Scenario: Bootstrap reap is not AIO-only
- **WHEN** bootstrap recovery encounters AIO and BoxLite sandboxes
- **THEN** it delegates ownership and cleanup decisions to provider registry/retention surfaces
- **AND** it does not force-remove provider artifacts solely because they are not `cap-aio-*` containers

### Requirement: Teardown is provider-specific and idempotent

Guardrails SHALL call teardown through the owning provider's selected run context,
durable owner, or attempt-scoped cleanup owner. Provider teardown SHALL be
idempotent. The Task lifecycle MAY settle after the bounded teardown disposition,
but durable work whose authoritative `SandboxRun.status = deleting` SHALL retain
its lease and concurrency slot until removal/absence is confirmed or the
configured terminal reconciliation policy atomically sets the run to `failed`
and relinquishes ownership. Legacy admission MAY release only its process-local
slot after bounded best-effort teardown because it has no fenced automatic
cleanup owner. Guardrails SHALL persist cleanup-attempt evidence as a secondary
outcome, MUST preserve any primary provisioning or runtime failure, and SHALL
make failed or unconfirmed cleanup eligible for bounded reconciliation.
Reconciliation SHALL stop after confirmed absence or its configured terminal
policy and SHALL never reclassify the task's primary outcome. Exact-owner
automatic reconciliation SHALL apply only when durable `SandboxRun` ownership is
available; legacy cleanup evidence SHALL remain queryable without authorizing a
new automated delete.

`SandboxRun.status` SHALL remain the cleanup authority: `deleting` represents
pending cleanup, confirmed `removed`/absence represents success, and `failed`
represents only an atomic terminal-policy decision that relinquishes ownership.
Additional
fields MAY record cleanup attempt count, last safe result/cause, and observation
time, but SHALL NOT create a parallel cleanup state machine. A single physical
provider delete/confirm failure updates those fields and leaves a durable run
deleting; it remains secondary to the primary task failure. An
ownership/lease/database authorization or acknowledgement failure remains an
orchestration coordination error so durable recovery semantics are preserved.

#### Scenario: Repeated BoxLite teardown is safe

- **WHEN** terminal close handling and force-fail handling both attempt to tear down the same BoxLite-backed task
- **THEN** the provider teardown runs safely at most once in effect
- **AND** guardrails releases the applicable slot exactly once only after confirmed removal or the admission mode's explicit terminal cleanup policy

#### Scenario: Cleanup failure cannot replace provisioning failure

- **WHEN** provider provisioning fails and task teardown also fails
- **THEN** guardrails preserves the provisioning failure as the primary task and attempt outcome
- **AND** the physical cleanup-attempt failure is recorded independently while durable canonical cleanup remains pending for reconciliation

#### Scenario: Unconfirmed durable cleanup retains capacity ownership

- **WHEN** durable teardown cannot confirm provider sandbox absence and its SandboxRun remains deleting
- **THEN** Guardrails may settle the Task lifecycle but retains the durable work lease and concurrency slot
- **AND** only confirmed removal or an atomic terminal-policy failure relinquishes that ownership

#### Scenario: Legacy teardown has no durable cleanup authority

- **WHEN** legacy admission reaches its bounded best-effort teardown disposition without confirmed absence
- **THEN** Guardrails records honest pending or failed cleanup evidence and releases only the process-local slot
- **AND** it does not fabricate a SandboxRun owner or schedule exact-owner reconciliation

#### Scenario: Reconciliation confirms an orphan is gone

- **WHEN** a terminal attempt retains pending cleanup ownership and a later reconciliation confirms provider resource absence
- **THEN** guardrails marks cleanup succeeded with a server timestamp
- **AND** it leaves the task's terminal status and primary outcome unchanged

### Requirement: Durable task admission is leased, idempotent, and restart-recoverable

Guardrails admission SHALL consume a durable work item uniquely associated with
the committed Task rather than the originating HTTP/MCP request lifetime. A
worker SHALL claim work with a database lease, re-read the Task's terminal and
version fence plus immutable preparation inputs, create or resume the matching
diagnostic attempt, and renew the lease while a long provider operation is
active — except during a detached workspace transfer, where the worker SHALL
release its slot and park instead of renewing while blocked: the claim settles
as `parked`, the worker slot returns to the pool, the detached clone job
continues in the sandbox, and a lightweight marker-watching loop that runs
outside the admission worker pool's in-flight accounting observes the job. The
parked loop SHALL NOT be a second admission authority: on job exit the task
SHALL re-enter admission only through the existing semaphore/worker claim path
under a new lease token. Sandbox ownership SHALL survive parking — the
ownership generation SHALL be re-stamped from, or decoupled from, the resuming
claim's lease token so a legitimately resumed worker is not fenced as a zombie
— while durable checkpoint writes SHALL enforce lease fencing so a superseded
(zombie) holder's write bearing a stale lease token is rejected at the write
point. A parked settlement SHALL NOT burn, increment, or reset the attempt
counter.

Concurrent workers under one valid claim SHALL NOT admit the same task
twice, duplicate diagnostic operation outcomes, or leave more than one live
provider sandbox for the task. When an expired lease is newly claimed after an
open running/provider diagnostic attempt, recovery SHALL close that prior
attempt as interrupted with an indeterminate outcome and SHALL create the next
task-local attempt before further provider work; it SHALL correlate or readopt a
proven existing sandbox without merging the old and new attempts' events.
Reclaiming accepted or capacity-queued work with no diagnostic attempt SHALL NOT
open one until running capacity is won. Retryable infrastructure failures SHALL use a bounded
persisted retry policy and a new task-local diagnostic attempt number;
deterministic capacity/config/auth/ref failures SHALL settle the current attempt
and task with their structured cause rather than retry forever.

A durable capacity-queued claim SHALL NOT create a new diagnostic attempt merely
because it is claimed again for promotion. A diagnostic attempt opens only when
running capacity is won and provider processing is about to begin. A park/resume
cycle within one transfer SHALL continue the same diagnostic attempt. Terminal
recovery SHALL continue the existing attempt and SHALL mark absent/incomplete
evidence partial rather than inventing a replacement. Repeated lease-expiry
attempt detail SHALL obey the diagnostic task-level bound and explicit overflow
summary without changing admission's own retry or recovery policy.

On application bootstrap, unfinished accepted/admitting work, parked work, and
active or cleanup-pending diagnostic attempts SHALL be recovered in addition to
the existing running-task re-adoption and queued-task re-offer phases. Parked
work SHALL be recovered by the claim/processor path probing the detached job's
markers: alive keeps it parked, an exit marker settles it from the recorded
exit code, and an unprovable job fails the attempt without inferring success.
Recovery
SHALL preserve the effective concurrency ceiling and SHALL use provider
idempotency/readoption when a sandbox was created before a worker crash. An
active attempt whose lease has expired SHALL be closed as interrupted before the
new claim creates its next attempt. A cancelled or otherwise terminal task SHALL
never be re-admitted, and a late
superseded worker SHALL report and tear down any sandbox it no longer owns while
preserving the winning attempt's outcomes.

#### Scenario: Two workers contend for one admission

- **WHEN** two workers attempt to claim the same accepted task concurrently
- **THEN** only one holds the valid lease and enters guardrails admission
- **AND** if it wins running capacity, exactly one concurrency slot, one active diagnostic attempt, and at most one live provider sandbox are owned by the task
- **AND** otherwise the queued task owns no diagnostic attempt or provider sandbox

#### Scenario: Parked transfer releases the worker slot

- **WHEN** a claim's workspace transfer starts as a detached job and the claim settles as parked
- **THEN** the worker slot is released and another accepted task can be claimed into it while the clone continues
- **AND** the parked marker-watching loop does not count against the admission pool's in-flight ceiling

#### Scenario: Job exit resumes through the admission path only

- **WHEN** the detached clone job writes its exit marker while the claim is parked
- **THEN** the task re-enters admission through the existing semaphore/worker claim path with a new lease token
- **AND** the parked loop itself performs no admission, launch, or provider settlement

#### Scenario: Resumed worker survives the ownership check

- **WHEN** a worker resumes a parked task under a new lease token
- **THEN** the post-provision ownership verification accepts the resumed worker (ownership generation re-stamped or decoupled)
- **AND** the resumed worker is not failed as a lost lease

#### Scenario: Zombie holder is fenced at the checkpoint write

- **WHEN** a superseded worker holding the pre-parking lease token attempts a durable checkpoint write after the task resumed under a new lease
- **THEN** the write is rejected by the lease fence at the write point
- **AND** the winning attempt's state and events are preserved unmerged

#### Scenario: Parking never burns attempts

- **WHEN** a task parks during transfer and later resumes to completion
- **THEN** the admission attempt counter and diagnostic attempt number are the same as before parking
- **AND** the park/resume cycle appears within one diagnostic attempt

#### Scenario: Restart recovers parked work via marker probe

- **WHEN** the API restarts while a task is parked behind a detached transfer
- **THEN** the claim/processor recovery probes the job markers and keeps it parked if alive, settles it from the exit marker if exited, or fails the attempt if unprovable
- **AND** success is never recorded without an exit marker

#### Scenario: Worker crashes after sandbox creation

- **WHEN** a worker exits after the provider creates the task sandbox but before admission work is marked complete
- **THEN** an expired-lease re-claim closes that worker's attempt as interrupted, creates the next attempt, and reuses or readopts the provider-idempotent sandbox, or safely removes a superseded duplicate
- **AND** the task continues without consuming two slots or merging operation outcomes from the two attempts

#### Scenario: Restart recovers accepted work

- **WHEN** the API restarts with committed admission work still accepted or leased by an expired worker
- **THEN** bootstrap or poll recovery makes it claimable in durable order
- **AND** accepted or capacity-queued work remains without a diagnostic attempt until it wins running capacity
- **AND** an expired open running/provider attempt is preserved as interrupted/indeterminate before the new claim creates the next attempt
- **AND** existing running-task re-adoption and queued FIFO semantics remain intact

#### Scenario: Queue promotion does not consume a diagnostic attempt

- **WHEN** capacity-queued durable work is claimed again and promoted under the same durable work lineage
- **THEN** Guardrails opens or reuses exactly one diagnostic attempt only as running provider processing begins
- **AND** queue polling or promotion does not increment diagnostic attempt history by itself

#### Scenario: Cancellation fences a late worker

- **WHEN** a task becomes cancelled while its worker is blocked in provider provisioning
- **THEN** the post-boundary status/version check prevents runtime launch
- **AND** teardown and diagnostic cleanup settlement run idempotently, while durable slot release occurs exactly once only after authoritative cleanup settlement

#### Scenario: A scheduled retry creates a new diagnostic attempt

- **WHEN** the bounded retry policy schedules another provider attempt after a retryable failure
- **THEN** the failed attempt remains terminal and the retry receives the next attempt number
- **AND** event replay within either attempt cannot merge or duplicate events across attempt identities

#### Scenario: Expired lease re-claim advances the diagnostic attempt

- **WHEN** a worker newly claims admission work whose previous lease and diagnostic attempt expired while active
- **THEN** the prior attempt becomes interrupted with an indeterminate outcome and the new claim receives the next attempt number
- **AND** any proven existing provider sandbox is correlated or readopted without reusing the prior attempt identity

### Requirement: Guardrails owns diagnostic attempt lifecycle across every admission mode

Guardrails SHALL create a diagnostic attempt only after legacy or durable
admission wins running capacity and before provider selection or the first
provider boundary, SHALL pass that attempt's emitter through
all provider and host-runtime setup operations, and SHALL settle the attempt
exactly once after its primary and cleanup outcomes are known. The legacy
synchronous path and durable worker path SHALL use the same attempt recorder,
stage vocabulary, failure classifier, and cleanup disposition. HTTP or MCP
disconnect SHALL NOT cancel, discard, or detach diagnostic settlement from the
accepted task. Task cancellation SHALL fence subsequent provider work and SHALL
settle the attempt as cancelled only after cleanup has been attempted.

Task cancellation SHALL synchronously fence later provider boundaries and
signal task-owned in-flight provider work to stop. The committed Task terminal
transition SHALL be the linearization point for choosing the diagnostic primary,
structured failure log, and audit projection. After provider settlement,
Guardrails SHALL revalidate that terminal winner before projecting any
provisioning failure. If cancellation won, Guardrails SHALL settle the primary
as cancelled, preserve cleanup as an independent outcome, clear runtime state,
and SHALL NOT force-fail, launch an agent, or emit a competing terminal audit.
Cleanup SHALL use provider-backed evidence even when the legacy owner has not
yet reached running state.

Committed/unclaimed and capacity-queued durable work SHALL remain observable
through the canonical admission state and task diagnostic-version expectation
with `coverage = not_started`; Guardrails SHALL NOT fabricate a provider attempt.
Queue polling and promotion under the same durable work lineage SHALL open exactly
one diagnostic identity only when running provider processing begins. An expired
open running/provider claim SHALL create the next identity, and terminal recovery
SHALL continue existing evidence or report it partial/unavailable.

#### Scenario: Legacy request disconnect preserves the attempt

- **WHEN** a legacy task-create request disconnects while provider provisioning continues
- **THEN** Guardrails continues recording and eventually settles the task-owned diagnostic attempt
- **AND** later authorized reads can observe the same attempt without relying on the disconnected request log

#### Scenario: Durable and legacy paths classify the same injected failure equally

- **WHEN** the same provider runtime-setup failure is injected once through legacy admission and once through durable admission
- **THEN** both attempts record the same safe stage, operation outcome, and primary cause
- **AND** neither path falls back to provider prose or a mode-specific diagnostic format

#### Scenario: Cancellation waits for cleanup disposition

- **WHEN** a task is cancelled while its provider operation is active
- **THEN** Guardrails fences later launch work, requests provider cleanup, and records its cleanup disposition
- **AND** it settles the attempt as cancelled without losing a cleanup failure

#### Scenario: Capacity wait is visible without a fabricated provider attempt

- **WHEN** accepted durable work is unclaimed or waiting for a running slot
- **THEN** the task exposes its accepted/queued admission state and not-started diagnostic coverage
- **AND** Guardrails opens no provider attempt until running capacity is won

#### Scenario: Cancellation wins while legacy provisioning is active

- **WHEN** task cancellation commits while a legacy provider create or workspace operation is active
- **THEN** Guardrails aborts the task-owned provider signal, fences every later external boundary, and retains cancelled as the only terminal lifecycle outcome
- **AND** late provider success or failure cannot launch runtime, force-fail the task, or overwrite its diagnostic primary

#### Scenario: Cancellation settles diagnostics after truthful cleanup

- **WHEN** the cancelled provider continuation and terminal cleanup converge
- **THEN** the attempt records one cancelled primary plus the provider-confirmed cleanup outcome
- **AND** it does not remain active or report cleanup succeeded before physical evidence exists

### Requirement: No provisioning chain retains blocking transfer semantics

The system SHALL NOT retain a second provisioning chain with divergent
workspace-transfer semantics. The legacy provisioning chain SHALL either route
through the same detached-transfer, dual-gate, and parking implementation as
the durable chain, or be removed; either way, after this change no code path
SHALL execute a workspace transfer as a single blocking exec under the single
15-minute deadline.

#### Scenario: Every surviving chain uses the detached path

- **WHEN** a task provisions through any provisioning chain that exists after this change
- **THEN** its workspace transfer executes as a detached job under dual-gate liveness
- **AND** no chain applies the legacy single-deadline blocking transfer

### Requirement: Admission mode is chosen by an explicit total policy over the capability gate

Choosing between the durable and legacy admission pipelines SHALL be a single
named policy that consumes the deployment-capability gate's full result, not a
boolean flattening of it. The policy SHALL be a total mapping over the gate's
closed reasons, so that introducing a new closed reason without deciding its
consequence fails to compile rather than silently inheriting a default. A gate
provider that is absent SHALL resolve to its own named outcome, distinct from
every reason a present gate can report. The chosen mode SHALL still be read
exactly once per acceptance and frozen for every later decision including the
transaction write.

This requirement governs how the mode is chosen and what the choice carries. It
does not change which mode is chosen: an unproven capability continues to resolve
to the legacy pipeline.

#### Scenario: A closed gate resolves through the policy carrying its reason

- **WHEN** a task is accepted while the capability gate reports closed with a
  reason such as `deployment_attestation_expired`
- **THEN** the policy SHALL resolve the admission mode to legacy and the resolved
  decision SHALL carry that reason, rather than reducing the gate result to a
  boolean before choosing

#### Scenario: An absent gate provider is distinguishable from a closed gate

- **WHEN** a task is accepted in a context where no admission gate provider is
  wired
- **THEN** the policy SHALL resolve to legacy under a named outcome that is not
  any of the gate's closed reasons, so a dependency-injection regression is not
  reported as a legitimately closed gate

#### Scenario: An open gate resolves to durable admission unchanged

- **WHEN** a task is accepted while the capability gate is open
- **THEN** the policy SHALL resolve the admission mode to durable, and the frozen
  mode SHALL drive the same acceptance, transaction, and diagnostic behaviour as
  before this change

#### Scenario: A new closed reason cannot be added without deciding its consequence

- **WHEN** a closed reason is added to the deployment-capability gate without a
  corresponding entry in the policy
- **THEN** the project SHALL fail to typecheck, rather than compiling and letting
  the new reason inherit an unstated fallback

### Requirement: The legacy admission pipeline sits behind a declared port

The legacy admission pipeline SHALL live outside the guardrails orchestrator in a
directory of its own, and the coupling between them SHALL be explicitly declared
in BOTH directions. That pipeline is the synchronous provisioning and run-start
path taken when the capability gate is not open, together with the helpers that
maintain its state and the process-local state itself — including the parts of
that state which the shared terminal-settlement path reads.

Every guardrails operation the pipeline depends on SHALL be named on a port the
pipeline declares, and every operation the orchestrator invokes on the pipeline
SHALL be named on a port the pipeline declares, so that neither surface can widen
without the widening being written down. No pipeline state SHALL remain reachable
from the orchestrator except through those declarations, so that deleting the
directory leaves no orphaned state behind and the remaining call sites are
reported by the compiler. The extraction SHALL NOT introduce a directory
dependency cycle: the module layout contract's permitted-cycle list SHALL remain
empty.

Behaviour SHALL be preserved exactly. The legacy and durable paths SHALL continue
to share one attempt recorder, stage vocabulary, failure classifier, and cleanup
disposition, and terminal settlement, slot release, cancellation fencing, and
diagnostic settlement SHALL be indistinguishable from their behaviour before the
extraction.

#### Scenario: Guardrails reaches the legacy pipeline only through a declared port

- **WHEN** the guardrails orchestrator drives a task admitted in legacy mode
- **THEN** it SHALL invoke the legacy pipeline through a declared entry port
  rather than through a concrete implementation type, and the pipeline SHALL
  obtain every orchestrator operation it needs from its own declared port rather
  than by reaching into orchestrator internals

#### Scenario: No pipeline state is left behind in the orchestrator

- **WHEN** the legacy pipeline's process-local state is inspected after the
  extraction
- **THEN** every container SHALL live in the extracted directory, and the shared
  terminal-settlement path SHALL reach that state only through the entry port, so
  that removing the directory cannot leave state without an owner

#### Scenario: Existing guardrails behaviour is unchanged by the extraction

- **WHEN** the existing guardrails test suite runs against the extracted structure
- **THEN** every test SHALL pass without being rewritten to accommodate the new
  arrangement, including the terminal-settlement, cancellation, provisioning-
  failure, and slot-release cases

#### Scenario: The extraction does not create a directory cycle

- **WHEN** the module layout gate runs after the legacy pipeline has been moved to
  its own directory
- **THEN** it SHALL report no violation with an empty permitted-cycle list, so the
  new directory and guardrails do not depend on each other outside module
  composition

### Requirement: Degrading to the legacy pipeline is attributable at the point of acceptance

A resolution to the legacy pipeline SHALL record, at the decision point, the
reason the deployment could not prove the durable-admission capability.
Attribution SHALL reuse the existing
capability-status and diagnostic surfaces rather than introducing a new persisted
schema: the read-only deployment-capability endpoint remains the authority for the
gate's current state, and per-attempt diagnostics continue to record the admission
mode.

#### Scenario: A degraded acceptance states which capability was unproven

- **WHEN** an acceptance resolves to legacy because the capability gate is closed
- **THEN** the recorded decision SHALL identify the unproven capability and the
  closed reason, so an operator reading it does not have to independently query
  the gate to learn why this task took the legacy path

#### Scenario: Attribution adds no persisted schema

- **WHEN** the attribution is added
- **THEN** the deployment-capability endpoint response and the persisted
  provisioning-diagnostic schemas SHALL be unchanged

### Requirement: Guardrails publishes domain events without changing lifecycle behavior

Guardrails orchestration SHALL publish domain events at its existing seams. Publishing SHALL NOT change, block, delay, reorder, or fail any existing lifecycle transition: a publish error SHALL be swallowed so the transition, the teardown, and the slot release proceed unconditionally.

An existing synchronous collaborator call (audit, runner-minutes accounting, transcripts, provisioning diagnostics, metrics projection) SHALL be removed only when the change removing it proves, with an executable test, that the same recorded semantics are still produced by another declared owner — one of exactly three forms: (1) a registered subscriber of a published event that carries every consumed field, (2) a second writer of the same row identity, or (3) a directly-read single owner, admissible only under the five preconditions stated below. A call whose semantics no other owner produces SHALL be retained unchanged. Publishing by itself SHALL NOT be treated as such a proof under any of the three forms.

The third form covers a removal in which no event and no second write is involved at all: state the orchestrator used to hold moves to a declared owner, and the consumer that used to read it through the orchestrator reads it from that owner instead. It SHALL be admissible only when the removing change establishes, by measurement rather than assertion, that every one of the following holds:

- **The removed call is a read.** It records nothing — it writes no row, publishes no event, emits no metric, mutates no state — and the orchestrator does not branch on its result. A call that records anything, or whose result steers orchestration, SHALL use form (1) or form (2).
- **The state has exactly one owner after the move.** No second construction site, module-level mutable instance, or duplicated copy of that state survives anywhere in the tree, so "the same recorded semantics" is the same object's state rather than a second reconstruction of it.
- **No forwarder remains.** The orchestrator retains no method, getter, property, or re-export whose body only forwards to that owner: the removed read face disappears from the tree entirely. A renamed, wrapped, or deprecated-but-live face SHALL NOT count as removed, and a symbol-reference count that falls because a face was renamed rather than deleted SHALL be treated as a forged burn-down.
- **The consumer calls the owner directly.** Every consumer that used to read through the orchestrator SHALL import the owner's declared `*.port.ts` and resolve it through the DI token that file exports. Routing the read back through the orchestrator, or through a third context's service, SHALL NOT count as direct.
- **The proof binds the real implementation.** The executable test SHALL be a characterization test that feeds the consumer's real derivation from the real owner's state and pins the consumer's complete output — not a selected field — against its pre-change output for the same inputs. A test in which either the owner or the derivation is a double SHALL NOT be accepted as the proof.

Absent all five preconditions the third form SHALL NOT be invoked, and the call SHALL be retained unchanged and adjudicated as retained. "Something else probably covers it" is not a proof under any of the three forms.

The bus SHALL be injected into `GuardrailsService` as an `@Optional()` **trailing** constructor parameter (the 11th), so that positional `new GuardrailsService(...)` construction outside `apps/api/src/guardrails/` continues to compile and run unchanged.

#### Scenario: Publishing failure does not disturb the transition

- **WHEN** a task reaches a terminal state while the injected bus's `publish` throws
- **THEN** the task still transitions to its terminal status, its timers are still cleared, its runner-minutes interval is still ended, its slot is still released, and the publish error is logged and swallowed

#### Scenario: Behaviour is identical with no bus injected

- **WHEN** `GuardrailsService` is constructed without the bus argument (the positional form used outside the guardrails directory) and the full lifecycle is exercised
- **THEN** every transition, teardown, audit call, and slot release behaves exactly as before this change, with no null-reference error

#### Scenario: Retained collaborator calls are still made

- **WHEN** a task is admitted, started, provisioned, and settled with the bus injected
- **THEN** every retained audit, runner-minutes, transcript, diagnostics, and metrics call is invoked exactly as many times as before this change

#### Scenario: A removed call's rows are still produced

- **WHEN** the operation behind a removed collaborator call is exercised on the integrated tree
- **THEN** the audit rows that call used to produce are still recorded, by the owner named in the adjudication artifact, under the same row identity

#### Scenario: The bus is the trailing constructor parameter

- **WHEN** the `GuardrailsService` constructor signature is inspected
- **THEN** the bus is the last parameter, is marked `@Optional()`, and the preceding 10 parameters keep their existing order and types

#### Scenario: Publishing is gated by the cutover toggle

- **WHEN** the escape-hatch environment value disables publishing and a full task lifecycle is exercised
- **THEN** zero events are published, and every retained synchronous collaborator call still runs

#### Scenario: A read-only face is removed under a directly-read single owner

- **WHEN** the orchestrator's forwarding read accessor over running intervals is deleted; the interval state has exactly one owner in the runner-metrics context with no second construction site; no method, getter, or re-export forwarding to that owner survives in `GuardrailsService`; the reading consumer obtains intervals by importing the owner's `*.port.ts` and resolving its DI token; and a characterization test pins the consumer's complete derived output, computed by the real derivation over the real owner's intervals, against its pre-change output for the same intervals
- **THEN** the removal is admissible under the third owner form, the dependency-budget ratchet records the collaborator's symbol-reference count falling by exactly the one deleted read, the cross-context-import gate shows the consumer's import naming the `*.port.ts` file, and every retained write call site still runs at its original seam

#### Scenario: A write-side removal cannot use the third form

- **WHEN** a change proposes to delete a collaborator call that records something — an audit row, a provisioning-diagnostic write, a transcript capture, or a metrics increment — and offers as its proof only that the state now has a single owner which some consumer reads directly
- **THEN** the third form does not apply, because the removed call is not a read; the removal is refused and the call is retained unchanged unless the change proves a registered subscriber of a published event carrying every consumed field, or a second writer of the same row identity

#### Scenario: A read the orchestrator branches on is not eligible

- **WHEN** the removed call is a read whose result the orchestrator itself reads and branches on before continuing the lifecycle
- **THEN** the third form does not apply, because moving the state does not preserve the orchestration decision the read fed, and the call is retained unchanged

### Requirement: TaskRunStarted is published at exactly three declared points

`TaskRunStarted` SHALL be published at exactly the three seams that begin a run's runner-minutes interval, and nowhere else: (1) the readoption recovery path that restores a running task after restart, (2) the legacy inline path `startRunningAfterCapacity`, and (3) the durable path `armDurableRuntime`. Each SHALL publish exactly once per run start, adjacent to that path's existing `runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it.

#### Scenario: Readoption publishes once

- **WHEN** startup recovery readopts a task that was running before restart
- **THEN** exactly one `TaskRunStarted` is published for that task and the existing `recordStart` call still runs

#### Scenario: The legacy path publishes once

- **WHEN** a task enters RUNNING through `startRunningAfterCapacity`
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `admissionMode: legacy`

#### Scenario: The durable path publishes once

- **WHEN** a task's durable runtime is armed through `armDurableRuntime`
- **THEN** exactly one `TaskRunStarted` is published for that task, carrying `admissionMode: durable`

#### Scenario: Re-arming the durable runtime does not publish twice

- **WHEN** `armDurableRuntime` is invoked a second time for a task whose runtime is already armed and it early-returns
- **THEN** no second `TaskRunStarted` is published for that task

#### Scenario: There is no fourth publish point

- **WHEN** the tree is searched for `TaskRunStarted` publish call sites
- **THEN** exactly three are found, and each sits in one of the three declared paths

### Requirement: TaskSettled is published only at the terminal fence

`TaskSettled` SHALL be published at exactly one seam: the terminal fence that records a task's own terminal status (`fenceTerminal`). The second `runnerMinutes.recordEnd` call site — the admission-runtime teardown in `clearAdmissionRuntime` — is NOT a terminal settlement, and it SHALL NOT publish `TaskSettled`. Both `recordEnd` call sites SHALL remain in place and unchanged.

#### Scenario: The terminal fence publishes once with the terminal status

- **WHEN** a task reaches `completed`, `failed`, or `cancelled` and `fenceTerminal` runs
- **THEN** exactly one `TaskSettled` is published carrying that terminal status, and the existing `recordEnd` call still runs

#### Scenario: Admission-runtime teardown publishes nothing

- **WHEN** `clearAdmissionRuntime` runs for a superseded legacy provisioning attempt whose task has not reached a terminal status
- **THEN** zero `TaskSettled` events are published, while the existing `recordEnd`, connection removal, and session unregistration still happen

#### Scenario: A superseded attempt does not fabricate a settlement

- **WHEN** a legacy provisioning attempt is discarded as superseded and the task is subsequently settled for real
- **THEN** exactly one `TaskSettled` is published for that task in total, and it carries the real terminal status rather than the teardown moment

#### Scenario: There is exactly one publish point

- **WHEN** the tree is searched for `TaskSettled` publish call sites
- **THEN** exactly one is found and it is inside the terminal fence

### Requirement: SandboxProvisioned is published on both provisioning paths after the provider boundary succeeds

`SandboxProvisioned` SHALL be published on exactly the two orchestration paths that cross the provider boundary: the durable path in `GuardrailsService` and the legacy path in the inline admission pipeline. Each SHALL publish once, only after `provider.provision(...)` has returned successfully and the resulting connection has been registered, using the environment snapshot and selected-run data already in hand — no new data pipeline SHALL be introduced to populate the payload.

#### Scenario: The durable path publishes after a successful provision

- **WHEN** the durable orchestration completes `provider.provision(...)`, re-verifies ownership, and registers the connection
- **THEN** exactly one `SandboxProvisioned` is published carrying the task id, sandbox reference, provider family, and the environment snapshot already built for the provision context

#### Scenario: The legacy path publishes after a successful provision

- **WHEN** the inline admission pipeline completes `provider.provision(...)` and registers the connection
- **THEN** exactly one `SandboxProvisioned` is published for that task

#### Scenario: A failed provision publishes nothing

- **WHEN** `provider.provision(...)` throws, is cancelled, or unwinds for a detaching transfer
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: A superseded provision publishes nothing

- **WHEN** the ownership re-check after `provision(...)` shows the attempt lost its fence and the sandbox is discarded
- **THEN** zero `SandboxProvisioned` events are published for that attempt

#### Scenario: No new pipeline is added to build the payload

- **WHEN** the diff at both publish points is inspected
- **THEN** the payload is assembled from values already present at that seam (provision plan environment, selected run, connection reference), with no new provider call, no new database read, and no new resolver

### Requirement: TaskAdmitted is published on both admission paths

`TaskAdmitted` SHALL be published on exactly the two admission paths: the durable path, once the capacity reservation has committed the task's transition, and the legacy path, once `admit()` has determined its outcome. Each event SHALL carry the transition token that fenced that admission, the resulting admission outcome (`running` or `queued`), and the `admissionMode` discriminant. A refused or superseded reservation SHALL NOT publish `TaskAdmitted`.

#### Scenario: The durable path publishes on a committed reservation

- **WHEN** the durable reservation commits a transition to `running` or `queued`
- **THEN** exactly one `TaskAdmitted` is published carrying that outcome, `admissionMode: durable`, and the transition token minted for that reservation

#### Scenario: The legacy path publishes on its admission outcome

- **WHEN** `admit()` resolves to `running` or `queued` on the legacy path
- **THEN** exactly one `TaskAdmitted` is published carrying that outcome and `admissionMode: legacy`

#### Scenario: A superseded reservation publishes no admission

- **WHEN** the durable reservation returns the `superseded` outcome and the lease transition is rolled back
- **THEN** zero `TaskAdmitted` events are published for that attempt

#### Scenario: Repeated in-flight admission publishes once

- **WHEN** `admit()` is called concurrently for the same task and the second call joins the in-flight admission promise
- **THEN** exactly one `TaskAdmitted` is published for that admission

### Requirement: TaskSuperseded is published once per observation at three declared producer boundaries

`TaskSuperseded` SHALL be published where a supersession is actually observed, at exactly three producer boundaries: (1) the durable capacity reservation returning the `superseded` outcome, (2) the durable admission transition returning `superseded`, and (3) the inline admission pipeline run returning `superseded`. The pipeline's multiple internal `superseded` early-returns SHALL NOT each publish: a single pipeline run SHALL produce at most one `TaskSuperseded`. Each event SHALL carry only what the observer holds — the superseded task id, the fence token the loser held, and the observation-point discriminant — and SHALL NOT carry any superseder identity.

#### Scenario: A superseded reservation publishes once

- **WHEN** the durable capacity reservation returns the `superseded` outcome
- **THEN** exactly one `TaskSuperseded` is published carrying the observation point for that boundary and the fence token the loser held

#### Scenario: A superseded admission transition publishes once

- **WHEN** the durable admission transition returns `superseded`
- **THEN** exactly one `TaskSuperseded` is published carrying that boundary's observation point

#### Scenario: One pipeline run publishes at most one supersession

- **WHEN** an inline pipeline run reaches its `superseded` outcome after passing more than one internal supersession check
- **THEN** exactly one `TaskSuperseded` is published for that run

#### Scenario: No superseder is fabricated

- **WHEN** any published `TaskSuperseded` payload is inspected
- **THEN** it contains no field naming the superseding task, lease, worker, or request — because no observation point in the code holds that handle

#### Scenario: A non-superseded outcome publishes nothing

- **WHEN** a pipeline run or reservation completes with any outcome other than `superseded`
- **THEN** zero `TaskSuperseded` events are published for it

### Requirement: Existing guardrails behavior is proven unchanged by characterization

Behavioral equivalence SHALL be proven as characterization against a baseline **measured live on this change's own tree**, not copied from an earlier change: `apps/api/src/guardrails/` holds 135 `test()` cases across 6 `*.spec.ts` files (57 + 54 + 15 + 3 + 3 + 3) and 8 `.test.mjs` assertion scripts, which are counted and reported separately from the spec files.

Behavioural assertions SHALL NOT be edited. An assertion that pins a *synchronous call order inside one method* MAY be rewritten, and every such rewrite SHALL be classified in the change's task ledger as either (a) an implementation detail — replaced by a result assertion over the set of audit rows the completed operation produced — or (b) a real requirement — re-expressed against the new seam and never relaxed. Each ledger entry SHALL record three things: the order the original assertion pinned, why that order no longer holds after the change, and the invariant the replacement pins. An assertion SHALL NOT be deleted, weakened into a count, or made order-insensitive beyond the single justified source of reordering. Outside `apps/api/src/guardrails/`, the only permitted edit to a `*.spec.ts` remains adding or omitting the trailing optional bus argument in a positional `new GuardrailsService(...)` construction, except where a test's own subject is changed by this change, in which case it SHALL be rewritten under the same (a)/(b) ledger.

Under this change's scope the three real audit assertion hotspots — `guardrails-durable-launch-decision.spec.ts` (46 audit assertions, including its two ordering assertions), `delivery-results-surfaced-and-audited.test.mjs` (61 audit assertions, a hand-written inline mirror of `deliverResult`), and `guardrails.service.spec.ts` (14 audit assertions, including the interleaving one pinned by an `auditStarted` flag) — SHALL pass **unmodified**. If any of them requires an edit, the change altered behaviour and the change is what is wrong, not the test.

#### Scenario: The stated baseline matches the tree

- **WHEN** the `test()` cases in `apps/api/src/guardrails/*.spec.ts` and the `.test.mjs` scripts are counted on the integrated tree
- **THEN** the counts are 135 across 6 spec files with the stated per-file distribution, and 8 `.test.mjs` scripts, all passing

#### Scenario: The three audit hotspots are unmodified

- **WHEN** the change's diff is filtered to `guardrails-durable-launch-decision.spec.ts`, `delivery-results-surfaced-and-audited.test.mjs`, and `guardrails.service.spec.ts`
- **THEN** zero of the three files appear in the diff, and all three pass on the integrated tree

#### Scenario: The negative force-fail assertions still hold

- **WHEN** a remote observation or a cancelled winner takes a task's terminal state
- **THEN** guardrails writes zero force-fail audit rows, and both existing negative assertions pass unmodified

#### Scenario: Every rewritten assertion carries a classified ledger entry

- **WHEN** any assertion in the repository is rewritten by this change
- **THEN** the task ledger holds an entry for it classified (a) or (b), recording the pinned order, why it no longer holds, and the invariant the replacement pins

#### Scenario: The inline source mirror moves with its subject

- **WHEN** the handling of a collaborator call that the hand-written mirror reproduces is changed
- **THEN** `delivery-results-surfaced-and-audited.test.mjs` is updated in the same commit with its per-argument assertion strength preserved — and when that handling is unchanged, the mirror is untouched

#### Scenario: Source-text-scanning tests keep their per-file strength

- **WHEN** a source-text-scanning test must be updated because a file it scans changed
- **THEN** the update keeps its per-file assertions rather than relaxing them to an aggregate total, and the run of the wiring and audit text-scanning scripts stays green

### Requirement: Every guardrails audit symbol reference is adjudicated in a durable artifact

The change SHALL produce a durable adjudication artifact in its change directory carrying **exactly one row per `this.audit` symbol reference** measured live in `apps/api/src/guardrails/guardrails.service.ts` before the change — nine rows, at lines 1197, 2063, 2067, 2770, 3529, 3778, 3787, 3806, and 3815. Each row SHALL carry: `file:line`; the collaborator method the reference belongs to (or the guard it forms); that method's declared return type; whether the caller reads and branches on the result; the persistence tier (`batch` or `blocking-strict`); the verdict (`CALL`, `EVENT`, or `REMOVED`); the covering event type when the verdict is `EVENT`; the refusal criterion name when the verdict is `CALL`; and the proven other owner when the verdict is `REMOVED`.

Adjudication SHALL scan in both directions: each row SHALL also name the inbound dependents of that write — the runtime paths and tests that depend on its timing or its result — and not only the outbound call.

#### Scenario: Row count matches the live symbol count

- **WHEN** the artifact's rows are counted and the dependency-budget ratchet reports the live `this.audit` count on the pre-change tree
- **THEN** both are 9, and the number of rows not marked `REMOVED` equals the live count measured on the integrated tree

#### Scenario: No row is left unadjudicated

- **WHEN** each row is read
- **THEN** it carries a verdict, a tier, and — for a `CALL` verdict — exactly one of the three declared refusal criterion names; zero rows carry a blank verdict, a blank tier, or an unattributed refusal

#### Scenario: Every EVENT verdict names a payload that carries every consumed field

- **WHEN** the verdicts are tallied on the integrated tree
- **THEN** zero rows are `EVENT`, each recorded against the field that no catalog payload carries — the force-fail `cause`, the exit `code`/`abnormal`/`tail`, the provisioning `stage`/`attempt`, and the change-request `url`/`number`/`reused`

#### Scenario: The inbound direction is recorded for the acknowledgement rows

- **WHEN** the rows for `recordProvisioningFailure` and `recordTaskCancellation` are read
- **THEN** each names the dependent runtime path (terminal admission recovery throwing the checkpoint coordination error so the running work stays leased and reclaimable) and the existing test that asserts it, rather than only naming the guardrails call

#### Scenario: The inbound direction is recorded for the delivery row

- **WHEN** the row for `recordChangeRequest` is read
- **THEN** it names the hand-written inline source mirror in `delivery-results-surfaced-and-audited.test.mjs` as a dependent that cannot fail on its own if the call's handling changes

### Requirement: An audit call is removed only under a proven per-stage owner, and at most one is removed

This change SHALL remove **at most one** `this.audit` symbol reference: the provider-composite provisioning-progress hint at `guardrails.service.ts:1197`. The removal SHALL be conditional on an executable proof that, for **every** provisioning stage each provider family reports through `onProvisioningProgress`, an audit row with the dedupe identity `task.provisioning:{taskId}:{attempt}:{stage}` is still recorded by the admission worker after the hint is gone. If any reported stage has no such worker-owned row, the hint SHALL be retained, adjudicated `CALL`, and the recorded dependency-budget count SHALL stay at 9.

The other eight references SHALL be byte-identical to their pre-change form. The private `recordAudit` helper SHALL be retained, because three of its call sites (`:2066`, `:2769`, `:3528`) survive this change; retaining it SHALL NOT leave an uncalled private method. No removed call SHALL be relocated into a feature-flag branch: this change introduces no second live path, and its escape hatch is a version rollback.

#### Scenario: The coverage proof is executable and per-stage

- **WHEN** the coverage proof runs
- **THEN** it enumerates the provisioning stages each provider family reports through `onProvisioningProgress` and asserts, for each one, an audit row written under the matching `task.provisioning:{taskId}:{attempt}:{stage}` dedupe identity by the admission worker

#### Scenario: An uncovered stage blocks the removal

- **WHEN** a stage reported by a provider family has no admission-worker checkpoint under the same dedupe identity
- **THEN** the hint at `guardrails.service.ts:1197` remains in the tree, its adjudication row reads `CALL`, and the recorded `this.audit` count remains 9

#### Scenario: The remaining references are untouched

- **WHEN** the diff of `guardrails.service.ts` is filtered to lines containing `this.audit`
- **THEN** it shows at most one deletion hunk and zero modification hunks, and the surviving references keep their existing line content

#### Scenario: No private helper is orphaned

- **WHEN** the call sites of the private `recordAudit` helper are counted on the integrated tree
- **THEN** the count is at least 3 and the helper is retained, so the change leaves behind no uncalled private method

#### Scenario: The removal is unconditional, not flag-gated

- **WHEN** the tree is searched for a conditional branch that re-invokes a removed audit call when a toggle is closed
- **THEN** zero matches are found, and the symbol-reference count reflects deleted code rather than code parked behind a disabled branch

#### Scenario: Comments added near publish points carry no quoted event name

- **WHEN** the change's added comment lines in `guardrails.service.ts` are searched for quoted catalog event names
- **THEN** zero matches are found, so the whole-file occurrence counts asserted by the publishing spec stay pinned

### Requirement: The runner-minutes read face is removed under a proven owner while every write is retained

This change SHALL remove **exactly one** `this.runnerMinutes` symbol reference — the read inside
the forwarding accessor at `guardrails.service.ts:3880` (`return this.runnerMinutes.intervals();`)
— and SHALL retain all five write references: `recordStart` at `:1824`, `:2917`, `:3286` and
`recordEnd` at `:2319`, `:3264`. The removal is made under **form (3), the directly-read single
owner**, of the standing removal precondition — the form this change's `MODIFIED` delta adds,
because the two pre-existing forms (a registered event subscriber, or a second writer of the same
row identity) are both write-side and neither describes this removal. This change SHALL establish
all five of form (3)'s preconditions by measurement: the removed call is a read that records
nothing and that the orchestrator does not branch on; the interval state has exactly one owner
after the move; no forwarder remains on the orchestrator; the consumer (`MetricsService`) imports
the owner's `*.port.ts` and resolves its DI token rather than routing through guardrails; and the
proof is a characterization test binding the real implementation, pinning `deriveRunnerMinutes`'
complete output over the same intervals. Publishing a domain event SHALL NOT be offered as any
part of that proof, and no write reference SHALL be removed by this change.

#### Scenario: Exactly one reference is deleted

- **WHEN** the diff of `guardrails.service.ts` is filtered to lines containing `this.runnerMinutes`
- **THEN** it shows exactly one deletion hunk — the accessor's `return this.runnerMinutes.intervals();`
  — and zero modification hunks

#### Scenario: The five write call sites survive with byte-identical statements

- **WHEN** the surviving `this.runnerMinutes` lines are compared with their pre-change text
- **THEN** all five are byte-identical (`this.runnerMinutes.recordStart(taskId);` three times and
  `this.runnerMinutes.recordEnd(taskId);` twice), and each still sits inside the same method it
  sat in before

#### Scenario: The other owner is proven by execution, not asserted

- **WHEN** the removal's proof is inspected
- **THEN** it is the executable characterization test over the real `deriveRunnerMinutes` fed by
  the new owner's `intervals()`, and no part of the proof rests on an event having been published

#### Scenario: No write reference is opportunistically removed

- **WHEN** the live `this.runnerMinutes` symbol-reference count in `guardrails.service.ts` is
  measured on the integrated tree
- **THEN** it is exactly 5 — not fewer — so the change did not quietly widen its scope past the
  read face

#### Scenario: Added comments carry no quoted event name

- **WHEN** the change's added comment lines in `guardrails.service.ts` are searched for quoted
  catalog event names
- **THEN** zero matches are found, so the whole-file occurrence counts asserted by the publishing
  spec's text-scanning assertions stay pinned

### Requirement: "In place and unchanged" governs the seam, and this change keeps the call text byte-identical anyway

The existing "in place and unchanged" constraints on the runner-minutes call sites SHALL be read
as governing the **seam** — which method the call sits in, its position relative to the publish,
and the fact that it still runs — and NOT the identity of the object the call is dispatched on.
Those constraints are that `TaskRunStarted` is published "adjacent to that path's existing
`runnerMinutes.recordStart(taskId)` call, and SHALL NOT replace or move it", and that "Both
`recordEnd` call sites SHALL remain in place and unchanged".
Because this change keeps the accessed member name `runnerMinutes` and changes only how the
orchestrator obtains the object behind it — the data field becomes a private getter over two
differently-named backing members, one resolved from DI and one an injector-less fallback — the
five call-site statements remain byte-identical, so the seam reading is not exercised at the byte
level by this change and neither existing requirement needs to be restated. Renaming the accessed
member SHALL NOT be used to make a ratchet count fall, since the R11 counter is a `\b`-anchored
regex over the exact symbol `this.runnerMinutes` and a rename would be a forged burn-down. The
backing members SHALL NOT be named such that they match that regex, and — because the R11 counter
scans raw source text without stripping comments — no comment this change adds to
`guardrails.service.ts` SHALL contain the literal `this.runnerMinutes`, which would silently
restore the count the deletion removed.

#### Scenario: Each publish stays adjacent to its retained recordStart

- **WHEN** each of the three declared `TaskRunStarted` publish points is read on the integrated
  tree
- **THEN** the retained `runnerMinutes.recordStart(taskId)` call is still in the same method, on
  the same side of the publish as before, and no call site moved into a different method

#### Scenario: Both recordEnd sites still run at their original seams

- **WHEN** `fenceTerminal` runs for a task reaching a terminal status, and `clearAdmissionRuntime`
  runs for a superseded legacy attempt whose task has not reached a terminal status
- **THEN** each invokes `recordEnd` exactly once as before, and `clearAdmissionRuntime` still
  publishes zero `TaskSettled`

#### Scenario: The measured symbol string is unchanged

- **WHEN** all five surviving call sites are inspected after the change
- **THEN** the accessed symbol is still `this.runnerMinutes`, so the recorded count reflects a
  deleted reference rather than a symbol the ratchet regex stopped matching

#### Scenario: Only the member's declaration is restructured, never its call sites

- **WHEN** the diff hunks touching the `runnerMinutes` member are read
- **THEN** every edited line is part of its declaration — the data field is replaced by a private
  getter plus two backing members — zero call-site lines are edited, and the member's accessed
  name is unchanged

#### Scenario: The resolution plumbing does not re-introduce the symbol

- **WHEN** the ratchet's own `measureSource` is run over the post-change file
- **THEN** it counts exactly 5 occurrences of `this.runnerMinutes`, and neither the getter body,
  the backing member declarations, the `onModuleInit` resolution, nor any comment this change adds
  contributes an occurrence

### Requirement: The orchestrator constructor and its positional construction sites are untouched

`GuardrailsService` SHALL keep exactly its existing 11 constructor parameters in their existing
order and types, with the `@Optional()` bus still last, so that the 24 positional
`new GuardrailsService(...)` sites across 17 files (12 of them outside `apps/api/src/guardrails/`)
compile and run unchanged. The site count is measured, not asserted, and it moves under this
requirement's own nose: it was 22 across 15 files, then 23 across 16 when a later change added an
integration test that constructs the orchestrator positionally, and it is 24 across 17 now that this
change's transcript-ordering assertion constructs one too. The numbers here were re-counted live on
the integrated tree rather than carried forward — the previously recorded "12 of them outside" was
already one ahead of a live count of 11 when it was written, which is exactly how a stale count makes
a future change mis-scope the blast radius of touching the signature. The `runnerMinutes` member SHALL be usable from the moment an instance
exists under BOTH DI construction and positional construction: an instance built positionally,
with no injector from which to resolve the port, SHALL still answer `recordStart`, `recordEnd`,
and `intervals()` without a null-reference error, because existing reflective unit assertions
call `intervals()` on positionally constructed instances. The injector-less fallback SHALL be
initialized by a field initializer, which the compiler emits before the constructor body runs, so
it is in place before any collaborator the constructor builds can reach the member.

Removing any of the three collaborator parameters is OUT of scope for a change that keeps this
requirement, and the reason is measured rather than stylistic: **20** of those construction sites
pass a value in the transcripts position or beyond, **16** of them across **9** files outside
`apps/api/src/guardrails/`, and one of them is `guardrails.service.spec.ts`, which a standing
requirement freezes at zero diff. The threshold that produces those numbers SHALL be stated with
them, because it is where this count goes wrong: `transcripts` is the EIGHTH parameter, so the
affected set is every site passing at least eight arguments — including the six that pass exactly
eight, whose final argument IS the transcripts value. Counting from nine instead silently drops
those six and understates the blast radius by a quarter, which is precisely the mis-scoping this
requirement exists to prevent. A change that needs the parameters gone SHALL modify this requirement
in the same commit as the signature.

#### Scenario: The constructor signature is unchanged

- **WHEN** the `GuardrailsService` constructor signature is compared with its pre-change form
- **THEN** it has the same 11 parameters in the same order and types, the bus is still the last
  parameter and still `@Optional()`, and zero of the 24 positional construction sites were edited
  to pass a ledger or port argument

#### Scenario: A positionally constructed instance still accounts for runner minutes

- **WHEN** a `GuardrailsService` is constructed positionally (no injector available) and a task is
  admitted, started, and settled
- **THEN** the start and end are recorded and `runnerMinutes.intervals()` returns the closed
  interval, with no null-reference or undefined-field error at any point in the lifecycle

#### Scenario: The reflective internals assertions pass unmodified

- **WHEN** `apps/api/src/guardrails/guardrails.service.spec.ts` is run on the integrated tree
- **THEN** it passes with zero diff lines, including its seven reflective
  `internals.runnerMinutes.intervals()` assertions (14 occurrences of the identifier, at
  `:1375`/`:1380`, `:3011`/`:3021`, `:3072`/`:3078`, `:3132`/`:3136`, `:3199`/`:3207`,
  `:3274`/`:3280`, `:3341`/`:3347`)

#### Scenario: The recorded site count matches a live count

- **WHEN** the tree is searched for `new GuardrailsService(` outside comment lines
- **THEN** the number of construction sites and the number of files containing them equal the counts
  this requirement states, so a change reading this requirement to scope a signature edit is reading
  a live number

### Requirement: Test doubles of the removed accessor are restated and every rewrite is ledgered

Every test double that stubs the removed accessor SHALL be restated against the port in the same
commit as the removal, preserving its existing fixture values and per-assertion strength. There
are four such doubles: `apps/api/src/metrics/metrics.verify.test.mjs:468` and `:537`,
`apps/api/src/metrics/task-resource.test.mjs:137`, and
`apps/api/src/metrics/terminal-diagnostics-metrics.service.spec.ts:71`. `terminal-diagnostics-metrics.service.spec.ts` is a `*.spec.ts` outside
`apps/api/src/guardrails/` whose own subject this change alters, so it SHALL carry an
(a)/(b)-classified entry in the change's assertion-rewrite ledger. The ledger SHALL be present in
the change directory even when it holds a single entry, and a ledger with no entries SHALL state
"zero entries" explicitly rather than being omitted.

#### Scenario: Every stub moves to the port with its strength intact

- **WHEN** the four stub sites are read on the integrated tree
- **THEN** each supplies intervals through a runner-minutes port double instead of a fake
  guardrails accessor, and each keeps the same fixture values and the same assertions it had
  before this change

#### Scenario: The changed-subject spec carries a classified ledger entry

- **WHEN** the change's assertion-rewrite ledger is read
- **THEN** it holds an entry for `terminal-diagnostics-metrics.service.spec.ts` classified (a) or
  (b), recording what the original assertion pinned, why it no longer holds, and the invariant the
  replacement pins

#### Scenario: The ledger is never silently empty

- **WHEN** the ledger holds no entries
- **THEN** it says "zero entries" in the change directory rather than the section being absent

#### Scenario: No guardrails-directory test is edited

- **WHEN** the change's diff is filtered to `apps/api/src/guardrails/*.spec.ts` and
  `apps/api/src/guardrails/*.test.mjs`
- **THEN** zero files appear

### Requirement: The phase-4 numeric acceptance target is replaced by criteria that each name their gate

The phase-4 acceptance target expressed as a guardrails line count SHALL be replaced, in the plan
documents that state it, by structural criteria. The replacement SHALL be performed by this change
rather than deferred, because this change is what measures the gap: the target's own baseline is
stale by the drift of a single earlier phase-4 commit, and the collaborator burn-down route cannot
reach the number under any accounting rule. Every replacement criterion SHALL name the command or
gate that decides it and SHALL state whether that gate exists today; a criterion with no gate SHALL
carry the concrete work that would give it one, so the plan never again carries a criterion nothing
can measure. Two candidate criteria SHALL be recorded as rejected with their reasons: symbol
references burning to zero (unreachable, since the orchestrator legitimately keeps naming
collaborators it still calls) and a bare "forwardRef cycle to zero" (no gate measures it, because
the layout check exempts cycles formed only of composition files). The line count SHALL be retained
as reported trend data in each change's outcome table, and SHALL NOT be an acceptance criterion.

#### Scenario: Every plan document stating the numeric target is updated in the same change

- **WHEN** the plan documents are searched for the numeric guardrails line target after this change
- **THEN** zero of them state it as an acceptance criterion, every occurrence that remains is
  explicitly labelled a historical review-time baseline, and the archived change directories are
  left untouched because they are immutable records

#### Scenario: Each replacement criterion names a gate and its status

- **WHEN** the replacement acceptance criteria are read
- **THEN** each names the command or CI step that decides it and is marked as either measurable
  today with no code change, or requiring a named gate addition, and none is left with an
  unspecified means of measurement

#### Scenario: The rejected candidates are recorded, not silently dropped

- **WHEN** the replacement text is read
- **THEN** it names both rejected candidate criteria and why each fails, so a later change does not
  re-propose them

#### Scenario: The line count survives as trend data only

- **WHEN** a phase-4 change's outcome table is read
- **THEN** it still reports the guardrails line count before and after, and no acceptance criterion
  anywhere depends on that number crossing a threshold

### Requirement: The remaining collaborator groups are scoped by a durable precondition graph and measured outcome table

This change SHALL produce a durable artifact in its change directory that scopes every remaining
phase-4 node — legacy inline-admission retirement, diagnostics (`provisioningDiagnosticRecorder` 4
+ `provisioningDiagnosticWriteGate` 4), transcript (`this.transcripts` 2), metrics-projection (2),
and the orchestration-body split — with (1) a precondition graph naming, per node, what must land
before it and why, and (2) an outcome table whose columns are the dimensions THIS change actually
measured: guardrails line delta, R11 count delta, r7 cross-context delta, forwardRef cycle edges
affected, and test files changed. Every cell describing this change SHALL be a number measured live
on the integrated tree; every cell describing a future node SHALL be labelled a prediction and
SHALL name the measurement that would confirm or refute it. Where a node's position in the graph
rests on a product decision rather than a measurement, the artifact SHALL say so in those words and
SHALL NOT present the decision as a finding.

#### Scenario: This change's row is measured, not predicted

- **WHEN** the artifact's row for the runner group is read
- **THEN** each of its five cells carries a number measured on the integrated tree — the guardrails
  line count before and after, `this.runnerMinutes` 6 → 5, r7 `guardrails.service.ts` 9 → 8, and
  0 forwardRef cycle edges removed — and none of them is marked as a prediction

#### Scenario: Every remaining node has a precondition edge or an explicit "none"

- **WHEN** the precondition graph is read
- **THEN** legacy inline-admission retirement is the root node with precondition "none"; the
  diagnostics node names it as the edge that removes the pass-through at
  `guardrails.service.ts:731`/`:732`; the transcript and metrics-projection nodes each say "none"
  explicitly, so their position is visibly a sequencing choice rather than a dependency; and the
  orchestration-body split names the nodes it waits on

#### Scenario: The diagnostics ceiling is recorded as two measured floors, never one number

- **WHEN** the diagnostics entry is read
- **THEN** it records **8 → 4 while legacy is alive** and **8 → 2 after legacy retires**, states
  that **8 → 0 is unreachable** without modifying the requirement that pins the bus as the
  eleventh constructor parameter with the preceding ten unchanged — because
  `guardrails.service.ts:654`/`:657` are the ninth and tenth — and carries none of these as an
  unqualified "burns to zero"

#### Scenario: Each remaining node carries a recommended shape with its evidence

- **WHEN** the diagnostics and transcript entries are read
- **THEN** each names one recommended migration shape — for diagnostics, inverting the write gate
  into an injected no-op recorder paired with extracting the two private wrapper methods, rather
  than extracting a service — with the evidence behind the recommendation, and the transcript entry
  records that it is not a file move: the runtime-registry token is provided but not exported by
  the tasks module, a controller imports back into the moved unit, the r7 entries are path-keyed so
  the move re-keys rather than shrinks them, and an undeclared new directory is a hard gate failure
  rather than a finding

#### Scenario: The acceptance gap is stated with the criteria that replace it

- **WHEN** the artifact is read for the phase-4 acceptance target
- **THEN** it states the current guardrails line count, the measured span of what collaborator
  burn-down can remove under both a conservative and an aggressive accounting rule with the rule
  named, and the residual orchestration-body remainder — and it records that the numeric target has
  been replaced by structural criteria, each of which names the gate or command that decides it and
  whether that gate exists today

#### Scenario: Predicted cells are falsifiable

- **WHEN** any predicted cell in the outcome table is read
- **THEN** it names the command or measurement that will confirm or refute it, rather than
  standing as an unfalsifiable estimate

### Requirement: Three collaborator groups leave the orchestrator together, each at its own measured floor

This change SHALL remove references to three collaborators in one commit series, and SHALL record a
SEPARATE floor for each rather than one headline number, because the three floors have three
different causes. The floors are: provisioning diagnostics from 8 to **4**, transcripts from 2 to
**1**, and metrics-projection from 2 to **2 — unmoved**. Every count SHALL be established by running
the dependency-budget gate's own measurement over the post-change file, never by counting deleted
lines, and never by grepping the identifier a collaborator used to have.

The metrics-projection floor is **2, the same 2 it started at**, and saying so is the point. The port
extraction renamed that collaborator's symbol; the orchestrator kept naming it exactly as often as
before. A count that falls because an identifier was renamed is a forged burn-down, and an entry
retired on that basis leaves a live coupling with nothing measuring it. What this change delivers for
that group is a change of FORM — a bare module import became a port import, which is what moves the
cross-context ratchet — not a removal.

The transcript floor is **1, not 0**, and the reason SHALL be recorded rather than left as an
unexplained shortfall: the orchestrator's transcript capture is awaited at both terminal chokepoints
BEFORE the stop-only sandbox teardown, so that the archive write happens while the container still
exists. That happens-before is carried by the awaited call itself. Removing the call would move a
correctness guarantee into an ordering the framework does not promise, so the awaited call SHALL be
retained and only the optional-reference guard beside it SHALL disappear. A change that reports this
group as burned down, or that removes the awaited call in exchange for an event, SHALL be refused.

The diagnostics floor is **4, not 2**, because the two constructor parameters survive: the
orchestrator still passes both into the legacy inline-admission adapter, and that pass-through is
out of this change's scope. The floor moves to 2 only after legacy retirement.

#### Scenario: Each group's post-change count is measured, not inferred

- **WHEN** the dependency-budget gate's measurement function is run over the post-change
  `guardrails.service.ts`
- **THEN** it reports provisioning-diagnostics recorder 2, write gate 2, transcripts 1, and
  metrics-projection 2 — the last measured against the collaborator's NEW symbol, since measuring the
  old one would report a zero that only the rename produced — and each of those numbers appears in the
  change's records with the command that produced it

#### Scenario: The awaited transcript capture survives at its seam

- **WHEN** a task reaches a terminal state through either terminal chokepoint
- **THEN** the transcript capture is still awaited to completion BEFORE the stop-only teardown runs,
  the surviving reference is that awaited call, and the transition, teardown, and slot release still
  proceed unconditionally when capture fails

#### Scenario: The diagnostics pass-through into legacy is untouched

- **WHEN** the orchestrator's construction of the legacy inline-admission pipeline is read
- **THEN** it still passes both the diagnostic recorder and the write gate, so both constructor
  parameters remain live and the group's floor is 4 rather than 2

#### Scenario: No group is reported as burned down

- **WHEN** the change's records describing the three outcomes are read
- **THEN** none of the three is described as burned down or as reaching zero, and in particular
  metrics-projection is described as unmoved at 2 with its entry retained, because its old symbol's
  zero was a rename rather than a removal

