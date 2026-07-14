# scheduled-tasks Specification

## Purpose
TBD - created by archiving change add-scheduled-tasks. Update Purpose after archive.
## Requirements
### Requirement: Durable schedule definitions for recurring task runs
The system SHALL persist task schedules separately from `Task` rows. A
`TaskSchedule` SHALL hold a stable id, owner account id, repo id, normalized task
template, internal recurrence representation, IANA timezone, enabled state, next
run time, overlap policy, misfire policy, and timestamps. The internal
recurrence representation MAY remain a cron expression used by the scheduler,
but user-facing create/update/read contracts SHALL support recurrence semantics
that do not require ordinary users to understand cron. A schedule SHALL NOT be
modeled as a `TaskStatus`; each fire SHALL create an ordinary `Task` instance
only when the occurrence is due and admitted for creation.

#### Scenario: Schedule is stored without creating a task immediately
- **WHEN** an account creates a valid schedule for a repo, prompt, and supported
  recurrence
- **THEN** the system persists a `TaskSchedule` with the normalized recurrence
  and task template
- **AND** no `Task` row is created until the schedule reaches a due occurrence

#### Scenario: Recurrence is normalized for scheduler execution
- **WHEN** an account creates a schedule using a supported recurrence such as
  weekdays at 09:00 in an IANA timezone
- **THEN** the system normalizes that recurrence into the scheduler's internal
  representation
- **AND** future `nextRunAt` calculations use the normalized representation and
  timezone

#### Scenario: Schedule is not a task lifecycle state
- **WHEN** the task status enum is inspected after scheduled tasks are added
- **THEN** it contains no `scheduled` status
- **AND** scheduled work is represented by `TaskSchedule` and
  `TaskScheduleRun` records before a concrete task is created

### Requirement: Schedule fire creates a headless task through the existing admission path

When a schedule occurrence is due, the scheduler SHALL first run the same
owner/runtime/environment/model preparation used by direct task creation outside
the occurrence write transaction. On successful preparation it SHALL create a
task using the stored template with execution mode `headless-exec` and reuse the
existing task row/admission path, including runtime readiness, sandbox
environment validation, `task.created` audit attribution, guardrails admission,
queued/running lifecycle transitions, delivery behavior, and terminal
settlement. A permanent pre-task failure or exhausted transient catalog retry
SHALL be represented by the run ledger without creating a partially valid Task.

#### Scenario: Due valid schedule creates a headless task

- **WHEN** an enabled schedule reaches `nextRunAt` and current preflight succeeds
- **THEN** the scheduler creates one task from the stored template
- **AND** the task response reads back `executionMode = headless-exec`
- **AND** guardrails admits or queues the task through the same semaphore used by
  `/v1` and MCP task creation

#### Scenario: Operator dispatches a schedule immediately

- **WHEN** an operator manually dispatches a schedule before its next normal fire
  time and current preflight succeeds
- **THEN** the system creates one task from the stored template through the same
  headless admission path
- **AND** the run is recorded at the actual manual dispatch time
- **AND** a future `nextRunAt` remains unchanged so the normal scheduled occurrence
  can still fire
- **AND** when `nextRunAt` is already due, it advances to the next future occurrence
  so the same due cycle is not claimed again

#### Scenario: Schedule fire preserves owner attribution

- **WHEN** a schedule owned by account `U` fires and creates a Task
- **THEN** the task's `task.created` audit event is attributed to `U`
- **AND** owner-scoped runtime credentials and forge delivery credentials resolve
  as they do for a task created directly by `U`

#### Scenario: Pre-task model failure does not create a partial Task

- **WHEN** a scheduled occurrence has a permanently unavailable model or exhausts bounded catalog retries
- **THEN** the run ledger records the safe terminal error and no Task row or task-owned execution sandbox is created

### Requirement: Each schedule occurrence is recorded exactly once

The system SHALL persist one `TaskScheduleRun` identity for each claimed
occurrence. The run ledger SHALL include the schedule id, scheduled fire time,
status, optional linked task id, optional non-secret error text, nullable stable
error code, and additive retry metadata. The database SHALL enforce uniqueness
for `(scheduleId, scheduledFor)` so multiple API processes, retry attempts, or
restart races update the same occurrence and create at most one Task. A
pre-task retrying occurrence SHALL persist an immutable normalized task-template
snapshot so a later schedule edit cannot change the intent being retried.

#### Scenario: Duplicate claim converges to one run

- **WHEN** two scheduler ticks race to fire or retry the same schedule occurrence
- **THEN** exactly one `TaskScheduleRun` row exists for that
  `(scheduleId, scheduledFor)`
- **AND** at most one linked task is created for that occurrence

#### Scenario: Permanent failed fire is visible in the run ledger

- **WHEN** a due schedule cannot create a task because the runtime, owner, repo,
  selected sandbox environment, or selected model is permanently invalid
- **THEN** the system records a failed `TaskScheduleRun` with stable safe reason
- **AND** it does not create a partially valid task

#### Scenario: Transient catalog failure updates the same run

- **WHEN** the effective model catalog is temporarily unavailable across one or more bounded attempts
- **THEN** each attempt updates the same run identity and retry metadata
- **AND** eventual success links at most one Task while exhaustion terminally fails that same run

### Requirement: Scheduler claims due work durably and recovers interrupted fires

The scheduler SHALL use Postgres-backed claim semantics for due and retrying
schedules. A claim SHALL only succeed when the schedule is enabled, due or ready
for its persisted retry, and not currently leased by another live claim. A
successful Task-creating or terminal-failure claim SHALL advance schedule cadence.
A transient catalog failure SHALL instead durably retain the same nominal
occurrence, set a bounded retry time/lease, and defer cadence advancement until
success or retry exhaustion. If the API process crashes after a task row and
schedule-run row commit but before admission, startup recovery SHALL find the
created-but-not-admitted run and call the existing task admission path exactly
once. It SHALL also resume a retrying pre-task occurrence at its persisted retry
time without creating a duplicate row.

#### Scenario: Task-creating claim advances its next run time

- **WHEN** a scheduler tick successfully claims a due schedule and atomically creates its Task
- **THEN** the schedule's `nextRunAt` advances according to its recurrence and timezone
- **AND** a concurrent tick observing the old due value cannot claim the same occurrence again

#### Scenario: Transient catalog claim retains the occurrence

- **WHEN** a claimed due occurrence encounters `runtime_model_catalog_unavailable` within its retry horizon
- **THEN** the same run stores `retrying` plus its next retry time, and cadence does not advance yet
- **AND** another worker cannot retry it before the persisted lease/retry time

#### Scenario: Recovery admits an interrupted scheduled task

- **WHEN** the process crashes after committing a schedule-run row linked to a
  pending task but before calling task admission
- **THEN** startup recovery detects the created schedule run
- **AND** it calls the existing task admission path for the linked task exactly
  once

#### Scenario: Recovery resumes a pre-task retry

- **WHEN** the process restarts with a retrying model-catalog occurrence and no linked Task
- **THEN** it retries at or after the persisted retry time against the same occurrence identity
- **AND** it creates at most one Task if preparation later succeeds

#### Scenario: Startup immediately checks overdue schedules

- **WHEN** the API process starts with one or more overdue enabled schedules
- **THEN** the scheduler registers its recurring poller and immediately runs a due
  scan without waiting for the first polling interval
- **AND** a recovery or due-scan error is logged without preventing application
  startup or later polling

### Requirement: Missed fires and overlaps use explicit policies
Schedules SHALL support a missed-fire policy and an overlap policy. The default
missed-fire policy SHALL be `fire-once`: after downtime, the scheduler fires at
most one overdue occurrence and then advances to the next future time. The
default overlap policy SHALL be `skip`: if a prior task created by the same
schedule is still non-terminal, the due occurrence is recorded as skipped and no
new task is created. An explicit `enqueue` overlap policy SHALL allow creating
another task and leaving guardrails to queue it if capacity is exhausted.

#### Scenario: Downtime catches up only once by default
- **WHEN** an enabled schedule is overdue by several cron intervals after API
  downtime
- **THEN** the scheduler records at most one due occurrence for the missed period
- **AND** it advances `nextRunAt` to the next future fire time

#### Scenario: Default overlap skips while prior task is active
- **WHEN** a schedule with `overlapPolicy = skip` is due while a previous task
  from that schedule is still pending, queued, running, or awaiting input
- **THEN** the scheduler records the occurrence as skipped for overlap
- **AND** it creates no new task for that occurrence

#### Scenario: Enqueue overlap creates another ordinary task
- **WHEN** a schedule with `overlapPolicy = enqueue` is due while a previous
  task from that schedule is still active
- **THEN** the scheduler creates another headless task from the template
- **AND** the existing guardrails semaphore decides whether that task runs
  immediately or remains queued

### Requirement: Schedule management is owner-scoped
Schedule create, read, update, pause, resume, dispatch, and delete operations SHALL be
scoped to the owning account. A principal without an account owner SHALL NOT
create schedules. API keys SHALL manage schedules for their owning account.
Schedule reads SHALL NOT expose schedules owned by a different account through
ordinary owner-scoped endpoints. Schedule responses SHALL include non-secret
task template details and user-facing recurrence metadata or summaries so
clients can render schedules without exposing scheduler internals.

#### Scenario: Owner creates and reads own schedule
- **WHEN** an account creates a schedule and then lists schedules
- **THEN** the list includes that schedule
- **AND** the schedule response includes non-secret task template details and a
  recurrence summary or descriptor
- **AND** the response does not expose claim leases or other scheduler internals

#### Scenario: Ownerless principal cannot create a schedule
- **WHEN** a legacy ownerless principal attempts to create a schedule
- **THEN** the request is rejected before any schedule row is created

#### Scenario: Different account cannot manage the schedule
- **WHEN** account B attempts to update, pause, resume, or delete a schedule
  owned by account A
- **THEN** the request is rejected or treated as not found
- **AND** account A's schedule remains unchanged

### Requirement: Schedule task templates are normalized and revalidated
The system SHALL validate schedule task templates against the same task create
contract used for direct task creation. Schedule creation SHALL resolve omitted
sandbox environment selection to the owner's current effective selection and
store that normalized value so later account default changes do not silently
alter the schedule. Each fire SHALL revalidate repo existence, owner validity,
runtime readiness, and selected sandbox environment readiness before creating a
task.

#### Scenario: Omitted environment is captured at schedule creation
- **WHEN** an account creates a schedule without an explicit
  `sandboxEnvironmentId`
- **THEN** the system stores the effective environment selection resolved at
  schedule creation time
- **AND** later account default-image changes do not alter that schedule
  template

#### Scenario: Fire fails closed when template is no longer valid
- **WHEN** a schedule fires after its repo was deleted or its selected sandbox
  environment is no longer ready
- **THEN** the scheduler records a failed schedule run
- **AND** it does not create a task with fallback behavior that differs from
  direct task creation validation

### Requirement: Schedule recurrence supports product presets
The system SHALL accept a user-facing recurrence descriptor for common recurring
task patterns. Supported descriptors SHALL include daily, weekdays, weekly, and
monthly recurrences at a local wall-clock time in an IANA timezone. The system
SHALL validate descriptor fields before persisting or updating a schedule.

#### Scenario: Weekday recurrence is accepted
- **WHEN** an account creates a schedule with a weekdays recurrence at `09:00`
  in `Asia/Shanghai`
- **THEN** the system accepts the recurrence
- **AND** it computes the next fire from that weekday wall-clock rule

#### Scenario: Invalid recurrence is rejected
- **WHEN** an account creates or updates a schedule with an invalid local time,
  timezone, weekday, or monthly day
- **THEN** the request is rejected before any schedule definition is changed

#### Scenario: Cron compatibility remains available
- **WHEN** an existing API client creates or updates a schedule with a valid
  cron expression and timezone through a compatibility path
- **THEN** the system continues to accept that request
- **AND** schedule reads provide a non-cron recurrence summary for ordinary
  clients

### Requirement: Schedule updates affect future fires only

Updating a schedule SHALL change the schedule definition used for future
unclaimed occurrences. It SHALL NOT mutate already-created tasks, transcripts,
delivery state, active task lifecycle state, or the immutable normalized task
template snapshot of an already claimed/retrying occurrence. An automatic
retrying occurrence SHALL make no attempt while its schedule is paused; after
resume it MAY continue from the same snapshot only within its bounded retry
horizon, otherwise it SHALL terminally fail without a Task.

#### Scenario: Edit leaves running task unchanged

- **WHEN** an operator updates the prompt or recurrence for a schedule while a
  previous scheduled task is running
- **THEN** the running task continues with the task template it was created with
- **AND** future unclaimed schedule fires use the updated template and recurrence

#### Scenario: Edit does not mutate a retrying occurrence

- **WHEN** an operator changes the model, prompt, environment, or runtime while an occurrence is retrying catalog preflight
- **THEN** that claimed occurrence retains the normalized template snapshot captured on its first attempt
- **AND** later unclaimed occurrences use the updated schedule template

#### Scenario: Pause prevents automatic retry work

- **WHEN** an automatic occurrence is retrying and the schedule is paused
- **THEN** no retry attempt or Task creation occurs while disabled
- **AND** resume either continues the same snapshot within its retry horizon or terminally expires it without a Task

#### Scenario: Edit recomputes next fire

- **WHEN** an operator changes a schedule recurrence and saves it
- **THEN** the schedule computes a new future `nextRunAt` from the updated
  recurrence and timezone for unclaimed work
- **AND** historical and already-claimed run records keep their original scheduled fire times

### Requirement: Schedule templates persist requested runtime models

Schedule create and update contracts SHALL accept the canonical optional
`taskTemplate.model`, normalize and persist it with the rest of the template,
and return it on schedule reads. Omission SHALL remain runtime-default intent.
Create/update SHALL validate an explicit model against the schedule owner's
current runtime/environment context outside the schedule write transaction and
SHALL leave the schedule unchanged when validation fails.

#### Scenario: Explicit model is saved in a schedule template

- **WHEN** an owner creates or updates a schedule with an available explicit model
- **THEN** the normalized template and schedule response retain that exact selector

#### Scenario: Invalid update does not mutate an existing schedule

- **WHEN** an owner updates a schedule to a model that is unavailable or whose catalog cannot be obtained
- **THEN** the update returns the stable model-domain failure
- **AND** the previous schedule definition, next-fire state, and run ledger remain unchanged

#### Scenario: Omitted scheduled model remains dynamic default intent

- **WHEN** a schedule template omits `model`
- **THEN** every created task also stores null requested model and lets that fire's effective runtime default apply

### Requirement: Every schedule fire revalidates an explicit model before task creation

Each due, manual-dispatch, or recovered not-yet-created occurrence SHALL resolve
and validate an explicit template model against the then-current owner,
credential, policy, runtime, and environment before creating its Task row.
Validation SHALL occur outside the occurrence claim/write transaction. A model
that was valid when the schedule was saved SHALL not bypass revalidation after
CLI, environment, credential, policy, or provider changes.

#### Scenario: Future fire uses a still-available model

- **WHEN** an occurrence fires and its explicit selector remains in the current effective catalog
- **THEN** exactly one normal headless task is created with that requested model and follows the ordinary admission path

#### Scenario: Model disappears before a future fire

- **WHEN** an occurrence fires after its explicit selector is removed from the effective catalog
- **THEN** the occurrence records `runtime_model_not_available`
- **AND** it terminally consumes that occurrence without a Task row or task-owned execution sandbox, after reclaiming any catalog probe

#### Scenario: Catalog is unavailable at fire time

- **WHEN** an explicit-model occurrence cannot obtain the effective catalog
- **THEN** the occurrence records retrying `runtime_model_catalog_unavailable` and a bounded next retry time for the same occurrence
- **AND** it creates neither a Task row nor a task-owned execution sandbox, after reclaiming any catalog probe

#### Scenario: Transient catalog outage recovers

- **WHEN** catalog discovery succeeds on a bounded retry before the occurrence retry horizon is exhausted
- **THEN** the same ledger occurrence creates at most one normal Task and transitions to created

#### Scenario: Catalog retries are exhausted

- **WHEN** the retry attempt/time bound is exhausted without a catalog
- **THEN** that occurrence transitions to terminal failed with `runtime_model_catalog_unavailable`, scheduling advances according to its cadence/misfire policy, and no late Task may be created for it

#### Scenario: Manual dispatch acknowledges its persisted pre-task outcome

- **WHEN** a manual dispatch encounters a permanently unavailable model or transient catalog outage
- **THEN** the dispatch persists one terminal-failed or retrying run respectively and returns the normal Schedule response containing that `latestRun`
- **AND** REST and MCP do not return a transport error after accepting and persisting the occurrence

#### Scenario: Closed deployment gate prevents occurrence acceptance

- **WHEN** an explicit-model occurrence becomes due on a model-aware N scheduler or is manually dispatched to N while `task-model-selection-v1` is closed
- **THEN** an automatic worker leaves it unclaimed and manual dispatch returns the synchronous retryable gate error before accepting an occurrence
- **AND** no Task, new occurrence row, catalog probe, or cadence advance is produced

### Requirement: Pre-task schedule failures are structured and exactly-once

Schedule run responses SHALL add a nullable stable `errorCode`, additive
`retrying` status, nullable `retryAt`, and retry-attempt metadata alongside the
existing safe error text so clients can distinguish permanent model failures
from transient catalog failures. Claiming, updating, or retrying an occurrence
SHALL preserve the existing unique occurrence identity and SHALL not create a
duplicate run or more than one Task. A terminal failed occurrence SHALL never
create a late Task. Raw adapter diagnostics and secrets SHALL not be persisted
in the ledger.

#### Scenario: Model failure is machine-readable

- **WHEN** a scheduled occurrence fails before task creation because of model validation
- **THEN** its latest-run and run-list representations contain the stable model-domain `errorCode` and safe message with no task id

#### Scenario: Catalog retry is machine-readable

- **WHEN** a scheduled occurrence is waiting to retry a transient catalog outage
- **THEN** its latest-run and run-list representations show `retrying`, `runtime_model_catalog_unavailable`, retry attempt metadata, and `retryAt` with no task id

#### Scenario: Scheduler recovery resumes one retrying occurrence

- **WHEN** the scheduler restarts after a catalog retry was durably recorded
- **THEN** recovery waits until the persisted retry time and updates the same ledger occurrence
- **AND** it does not create a duplicate run or more than one Task

#### Scenario: Scheduler recovery does not duplicate a terminal failure

- **WHEN** the scheduler restarts after a permanent model failure or exhausted catalog retry was durably recorded
- **THEN** recovery does not create a Task or second ledger entry for that occurrence

#### Scenario: Recovery of an already-created task preserves its model

- **WHEN** an occurrence already has a Task row and startup recovery resumes admission
- **THEN** recovery uses that Task's persisted requested model without recataloging it as a new occurrence
