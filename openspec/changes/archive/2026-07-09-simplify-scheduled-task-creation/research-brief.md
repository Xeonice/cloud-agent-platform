## Research Brief

### Current State

- The archived `add-scheduled-tasks` change introduced durable schedules, run
  ledgers, schedule provenance, `/v1/schedules`, and a console schedule
  management page.
- The schedule data model and contracts currently require `cronExpression` and
  `timezone` for creation and expose `cronExpression` in schedule responses.
- The console `/schedules` route currently owns schedule creation/editing and
  includes a visible `Cron` input plus a table column that prints the raw cron
  expression.
- Task creation surfaces (`NewTaskDialog` and `/tasks/new`) create only
  immediate tasks through `createTaskMutation`; they do not branch to schedule
  creation.
- Existing task read behavior already links schedule-created work back to an
  ordinary task through schedule provenance. Each successful fire is an
  independent task opened through `/tasks/$taskId`.

### Product Decisions From Exploration

- Recurring work should be created from the normal task creation flow, not from
  the `/schedules` overview page.
- Users should choose "run once" or "run repeatedly" while defining a task.
- Users should configure recurrence through human controls such as daily,
  weekdays, weekly, or monthly at a local time. The console must not expose cron
  syntax.
- `/schedules` is an overview and management surface: list all recurring task
  definitions, inspect recent runs, open linked tasks, pause/resume if retained,
  edit future settings via the task-creation form, and delete schedules.
- Editing a schedule should reuse the same task form in an edit-recurring mode.
  Saving updates the schedule definition for future fires and never mutates
  already-created task instances.
- Delete is for retiring automation, not the primary correction path.

### Existing Specs Affected

- `frontend-console`: currently says operators can create schedules from the
  schedule management view and that the list shows cron expressions. This must
  change.
- `scheduled-tasks`: storage may keep cron internally, but schedule creation and
  response semantics need a user-facing recurrence abstraction or derived
  recurrence summary so clients are not forced to understand cron.
- `public-v1-api`: `/v1/schedules` currently documents schedule DTOs around
  cron. To keep API clients aligned with the product model, add recurrence DTOs
  while preserving cron as internal/compatibility behavior.

### Implementation Implications

- Add recurrence helpers that convert supported recurrence selections to cron
  and a timezone. Keep the scheduler's existing cron-based next-run computation.
- Add a display formatter that summarizes schedule recurrence without printing
  cron. For schedules whose cron cannot be mapped to supported presets, display
  an opaque custom recurrence summary plus next-run time rather than the raw
  expression.
- Refactor task creation form state and payload building so immediate tasks and
  recurring schedules share task-template controls.
- Remove schedule creation/edit form from `/schedules`; keep list, status,
  recent runs, task links, edit action, and delete confirmation.
