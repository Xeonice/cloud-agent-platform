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
active. Concurrent workers under one valid claim SHALL NOT admit the same task
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
running capacity is won and provider processing is about to begin. Terminal
recovery SHALL continue the existing attempt and SHALL mark absent/incomplete
evidence partial rather than inventing a replacement. Repeated lease-expiry
attempt detail SHALL obey the diagnostic task-level bound and explicit overflow
summary without changing admission's own retry or recovery policy.

On application bootstrap, unfinished accepted/admitting work and active or
cleanup-pending diagnostic attempts SHALL be recovered in addition to the
existing running-task re-adoption and queued-task re-offer phases. Recovery
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
