# guardrails

## MODIFIED Requirements

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

## ADDED Requirements

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
