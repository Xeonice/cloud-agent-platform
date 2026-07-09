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
When a schedule occurrence is due, the scheduler SHALL create a task using the
stored template with execution mode `headless-exec`. The scheduler SHALL reuse
the existing task creation and admission path, including runtime readiness,
sandbox environment validation, `task.created` audit attribution, guardrails
admission, queued/running lifecycle transitions, delivery behavior, and terminal
settlement.

#### Scenario: Due schedule creates a headless task
- **WHEN** an enabled schedule reaches `nextRunAt`
- **THEN** the scheduler creates one task from the stored template
- **AND** the task response reads back `executionMode = headless-exec`
- **AND** guardrails admits or queues the task through the same semaphore used by
  `/v1` and MCP task creation

#### Scenario: Schedule fire preserves owner attribution
- **WHEN** a schedule owned by account `U` fires
- **THEN** the created task's `task.created` audit event is attributed to `U`
- **AND** owner-scoped runtime credentials and forge delivery credentials resolve
  as they do for a task created directly by `U`

### Requirement: Each schedule occurrence is recorded exactly once
The system SHALL persist a `TaskScheduleRun` record for each claimed occurrence.
The run ledger SHALL include the schedule id, scheduled fire time, status,
optional linked task id, and optional non-secret error text. The database SHALL
enforce uniqueness for `(scheduleId, scheduledFor)` so multiple API processes or
restart races cannot create duplicate tasks for the same occurrence.

#### Scenario: Duplicate claim converges to one run
- **WHEN** two scheduler ticks race to fire the same schedule occurrence
- **THEN** exactly one `TaskScheduleRun` row is committed for that
  `(scheduleId, scheduledFor)`
- **AND** at most one linked task is created for that occurrence

#### Scenario: Failed fire is visible in the run ledger
- **WHEN** a due schedule cannot create a task because the runtime, owner, repo,
  or selected sandbox environment is no longer valid
- **THEN** the system records a failed `TaskScheduleRun` with a non-secret reason
- **AND** it does not create a partially valid task

### Requirement: Scheduler claims due work durably and recovers interrupted fires
The scheduler SHALL use Postgres-backed claim semantics for due schedules. A
claim SHALL only succeed when the schedule is enabled, due, and not currently
leased by another live claim. If the API process crashes after a task row and
schedule-run row commit but before admission, startup recovery SHALL find the
created-but-not-admitted schedule run and call the existing task admission path
exactly once.

#### Scenario: Claimed schedule advances its next run time
- **WHEN** a scheduler tick successfully claims a due schedule
- **THEN** the schedule's `nextRunAt` advances according to its cron expression
  and timezone
- **AND** a concurrent tick observing the old due value cannot claim the same
  occurrence again

#### Scenario: Recovery admits an interrupted scheduled task
- **WHEN** the process crashes after committing a schedule-run row linked to a
  pending task but before calling task admission
- **THEN** startup recovery detects the created schedule run
- **AND** it calls the existing task admission path for the linked task exactly
  once

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
Schedule create, read, update, pause, resume, and delete operations SHALL be
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
occurrences. It SHALL NOT mutate already-created tasks, historical
`TaskScheduleRun` rows, transcripts, delivery state, or active task lifecycle
state.

#### Scenario: Edit leaves running task unchanged
- **WHEN** an operator updates the prompt or recurrence for a schedule while a
  previous scheduled task is running
- **THEN** the running task continues with the task template it was created with
- **AND** future schedule fires use the updated template and recurrence

#### Scenario: Edit recomputes next fire
- **WHEN** an operator changes a schedule recurrence and saves it
- **THEN** the schedule computes a new future `nextRunAt` from the updated
  recurrence and timezone
- **AND** historical run records keep their original scheduled fire times
