## MODIFIED Requirements

### Requirement: Console manages scheduled tasks
The authenticated console SHALL provide recurring task management for the
current account. Operators SHALL create recurring work from the same task
creation surfaces used for immediate task dispatch by choosing a "run once" or
"run repeatedly" mode. The `/schedules` route SHALL be an overview and
management surface for existing recurring automation definitions: operators can
list schedules, inspect recent schedule runs, open linked tasks, pause and
resume schedules when those controls are available, edit future schedule
settings through the task creation form, and delete a schedule after
confirmation. The console SHALL present schedules as recurring automation
definitions, not as task statuses, and SHALL NOT expose cron expressions to
ordinary operators.

#### Scenario: Operator creates a recurring task from task fields
- **WHEN** the operator selects "run repeatedly" while submitting the task
  creation form with repo, prompt, recurrence, timezone, runtime, environment,
  delivery, skills, idle timeout, and deadline selections
- **THEN** the console calls the schedule create API with those fields
- **AND** the created schedule appears in the schedule overview without creating
  an immediate task unless the recurrence is due

#### Scenario: Operator creates an immediate task from the same surface
- **WHEN** the operator selects "run once" while submitting the task creation
  form
- **THEN** the console calls the existing task create API
- **AND** no schedule definition is created

#### Scenario: Schedules overview does not create schedules
- **WHEN** the operator opens `/schedules`
- **THEN** the page shows existing recurring task definitions and their recent
  run state
- **AND** it does not render a standalone schedule creation form or a "new
  schedule" action

#### Scenario: Operator edits future schedule settings
- **WHEN** the operator chooses to edit a schedule from `/schedules`
- **THEN** the console opens the task creation form in edit-recurring mode with
  the schedule's task template and recurrence prefilled
- **AND** saving updates the existing schedule for future fires without creating
  an immediate task

#### Scenario: Operator pauses and resumes a schedule
- **WHEN** the operator pauses an enabled schedule
- **THEN** the console calls the pause API and the schedule no longer fires
  future occurrences while paused
- **AND** when the operator resumes it, the console calls the resume API and the
  schedule computes a future `nextRunAt`

#### Scenario: Operator views schedule runs and opens tasks
- **WHEN** the operator opens a schedule's recent run history
- **THEN** the console shows each occurrence status, scheduled fire time, and
  linked task when one exists
- **AND** selecting a linked task navigates to the ordinary `/tasks/$taskId`
  session or replay route

### Requirement: Schedule list reflects next fire and enabled state
The schedule list SHALL show each schedule's name or prompt summary, repo,
runtime, enabled/paused state, human-readable recurrence summary, timezone, next
run time, overlap policy, and last run outcome when available. The list SHALL
refresh on the same kind of lightweight polling used by task/dashboard surfaces
so operators can see recent fires without a manual reload. The list SHALL NOT
display raw cron expressions.

#### Scenario: Schedule list shows next run
- **WHEN** the operator opens the schedule management view
- **THEN** each schedule row shows its next run time, timezone, enabled state,
  recurrence summary, and latest run outcome when present
- **AND** the row does not show a cron expression

#### Scenario: Custom recurrence does not expose cron
- **WHEN** a schedule was created from a cron expression that cannot be mapped
  to the console's supported recurrence presets
- **THEN** the schedule row shows an opaque custom recurrence summary and the
  next run time
- **AND** it does not show the raw cron expression

#### Scenario: Schedule list refreshes after a fire
- **WHEN** a schedule fires while the management view is open
- **THEN** the list refreshes and shows the updated next run time and latest run
  outcome

## ADDED Requirements

### Requirement: Task creation surfaces support recurring mode
The task creation dialog and the full-page advanced task creation route SHALL
let operators choose whether the submitted task runs once or repeatedly. The
repeated mode SHALL reuse the same task-template controls as immediate task
creation and SHALL add recurrence controls that do not require cron syntax.

#### Scenario: Recurrence controls use human choices
- **WHEN** the operator configures repeated execution
- **THEN** the console offers supported human-readable recurrence choices such
  as daily, weekdays, weekly, or monthly at a local time
- **AND** it submits recurrence fields rather than a user-entered cron string

#### Scenario: Existing task template controls are shared
- **WHEN** the operator switches between run-once and run-repeatedly modes
- **THEN** repo, prompt, runtime, sandbox environment, delivery, skills, idle
  timeout, and deadline selections remain in one shared task-template form
- **AND** the selected mode only changes the submit target and recurrence
  controls
