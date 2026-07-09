## MODIFIED Requirements

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

## ADDED Requirements

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
