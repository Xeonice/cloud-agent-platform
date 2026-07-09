## ADDED Requirements

### Requirement: Console manages scheduled tasks
The authenticated console SHALL provide schedule management for the current
account. Operators SHALL be able to list schedules, create a schedule from the
same task-template fields used by task creation, pause and resume a schedule,
delete a schedule after confirmation, and inspect recent schedule runs. The
console SHALL present schedules as recurring automation definitions, not as task
statuses.

#### Scenario: Operator creates a schedule from task fields
- **WHEN** the operator submits the schedule form with repo, prompt, recurrence,
  timezone, runtime, environment, delivery, skills, idle timeout, and deadline
  selections
- **THEN** the console calls the schedule create API with those fields
- **AND** the created schedule appears in the schedule list without creating an
  immediate task unless the recurrence is due

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

### Requirement: Schedule UI surfaces missed and skipped fires honestly
The console SHALL display failed and skipped schedule runs as schedule-run
outcomes rather than fabricating task rows. Overlap skips, invalid owner/runtime
failures, deleted repos, and invalid sandbox environments SHALL be visible in
the run history with non-secret reasons returned by the API.

#### Scenario: Skipped overlap is visible without a task link
- **WHEN** a schedule occurrence is skipped because the prior scheduled task is
  still active
- **THEN** the schedule run history shows a skipped-overlap outcome
- **AND** it shows no linked task id for that occurrence

#### Scenario: Failed fire shows a non-secret reason
- **WHEN** a schedule occurrence fails before task creation
- **THEN** the run history shows a failed outcome and the non-secret API reason
- **AND** it does not link to a fabricated task

### Requirement: Schedule list reflects next fire and enabled state
The schedule list SHALL show each schedule's name or prompt summary, repo,
runtime, enabled/paused state, cron expression, timezone, next run time, overlap
policy, and last run outcome when available. The list SHALL refresh on the same
kind of lightweight polling used by task/dashboard surfaces so operators can see
recent fires without a manual reload.

#### Scenario: Schedule list shows next run
- **WHEN** the operator opens the schedule management view
- **THEN** each schedule row shows its next run time, timezone, enabled state,
  and latest run outcome when present

#### Scenario: Schedule list refreshes after a fire
- **WHEN** a schedule fires while the management view is open
- **THEN** the list refreshes and shows the updated next run time and latest run
  outcome
