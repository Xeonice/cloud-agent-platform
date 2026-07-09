## Why

Scheduled task creation currently asks operators to leave the task creation flow,
duplicate the task fields in `/schedules`, and type cron syntax. That exposes an
internal scheduling representation instead of the product intent: "run this task
once" versus "run this task repeatedly."

## What Changes

- Move recurring task creation into the existing task creation surfaces as a
  "run once / run repeatedly" choice.
- Replace console cron inputs and cron table display with human recurrence
  controls and summaries, such as daily, weekdays, weekly, or monthly at a local
  time.
- Reposition `/schedules` as an overview and management page for existing
  recurring tasks: list schedules, inspect recent runs, open linked task
  sessions, pause/resume if retained, edit future settings, and delete after
  confirmation.
- Route schedule editing back through the same task form in an edit-recurring
  mode; saving updates only future fires and never mutates historical or running
  task instances.
- Keep cron as an internal scheduler representation and compatibility detail, but
  do not require ordinary console users to understand or enter cron.
- Preserve the existing execution model: every successful schedule fire creates
  an independent ordinary task that is opened from `/tasks/$taskId`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `frontend-console`: recurring task creation moves into task creation surfaces;
  `/schedules` becomes an overview/manage surface and no longer exposes cron or
  hosts a standalone create form.
- `scheduled-tasks`: schedules gain a user-facing recurrence abstraction while
  the scheduler may continue using cron internally for next-fire computation.
- `public-v1-api`: schedule contracts add recurrence-oriented request/response
  fields for product clients while preserving backward compatibility for
  existing cron-based clients.

## Impact

- Web console:
  - Update `NewTaskDialog` and `/tasks/new` to support immediate versus
    recurring task submission.
  - Remove new/create form behavior from `/schedules`; keep overview, recent
    runs, task links, edit, pause/resume, and delete flows.
  - Add recurrence controls and human recurrence summaries.
- Contracts/API:
  - Add recurrence DTOs and validation helpers that convert supported recurrence
    selections to the existing scheduler representation.
  - Return enough recurrence metadata or summaries for clients to render
    schedules without showing cron.
  - Preserve existing cron fields for compatibility unless a later breaking API
    version removes them.
- Scheduler/storage:
  - Continue using persisted schedule definitions, run ledgers, and cron-based
    next-run calculation internally.
  - Ensure schedule edits affect only future occurrences.
- Tests:
  - Add focused contract tests for recurrence validation/conversion.
  - Add API tests proving recurrence creation maps to stored schedules.
  - Add frontend tests covering create-once versus create-recurring, schedule
    overview without create form, edit navigation, task links, and deletion.
