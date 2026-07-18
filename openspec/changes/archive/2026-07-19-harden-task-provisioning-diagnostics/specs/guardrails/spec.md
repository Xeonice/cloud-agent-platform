## ADDED Requirements

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

## MODIFIED Requirements

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
