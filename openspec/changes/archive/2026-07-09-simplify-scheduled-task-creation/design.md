## Context

CAP now has durable scheduled tasks: a `TaskSchedule` stores a task template and
cron-backed recurrence, `TaskScheduleRun` records every occurrence, and each
successful fire creates an ordinary `Task`. The implementation is sound at the
runtime layer, but the console exposes the internal model directly. Operators
must open `/schedules`, duplicate task creation fields, type a cron expression,
and then leave that page to open the task that a later run created.

The product model should be simpler:

```
Task creation form
  run once       -> create Task now
  run repeatedly -> create/update TaskSchedule for future Task instances

/schedules
  observe existing recurring definitions
  inspect runs and open linked /tasks/$taskId
  edit future settings through the same task form
  delete schedules when no longer needed
```

## Goals / Non-Goals

**Goals:**

- Make recurring task creation part of the normal task creation flow.
- Hide cron syntax from ordinary console users.
- Keep `/schedules` focused on overview, run inspection, edit entry, and delete.
- Preserve the existing execution model where every successful scheduled fire is
  an independent task opened through `/tasks/$taskId`.
- Preserve backward compatibility for existing cron-based schedule API clients
  while adding recurrence-first contracts for product clients.
- Ensure schedule edits affect only future fires, not historical or currently
  running task instances.

**Non-Goals:**

- Replace the scheduler's internal cron parser or durable claim/run ledger.
- Add a new task lifecycle state for schedules.
- Add a separate schedule session page.
- Add arbitrary natural-language recurrence parsing.
- Remove cron compatibility from existing `/v1/schedules` clients in this
  change.

## Decisions

### 1. Treat recurrence as task creation mode

The task creation dialog and `/tasks/new` page will share a "run once / run
repeatedly" choice. "Run once" keeps the current `POST /repos/:repoId/tasks`
path. "Run repeatedly" uses the same task-template controls and submits a
schedule create or update request.

Alternative considered: keep `/schedules` as the creation surface but replace
the cron input. Rejected because it still makes recurring work feel like a
separate technical object and forces users to learn a second task form.

### 2. Keep `/schedules` as an overview and management surface

`/schedules` will not offer a standalone create form. It lists recurring task
definitions, shows next run and latest outcomes, opens recent linked tasks, and
allows delete after confirmation. Edit actions route to the recurring task form
preloaded with the schedule template.

Alternative considered: inline editing in `/schedules`. Rejected because it
would recreate the same dense form problem and duplicate the task creation UI.

### 3. Introduce a recurrence DTO while preserving cron internally

Add a recurrence representation for supported user-facing patterns: daily,
weekdays, weekly, and monthly at a local time and timezone. Server-side helpers
convert these to the stored cron/timezone representation used by the existing
scheduler. Schedule responses include a recurrence summary or descriptor so the
console can render without printing cron.

Existing cron-based create/update remains available for compatibility, but
recurrence and cron inputs are mutually exclusive on a single request. Product
clients should use recurrence.

Alternative considered: convert recurrence to cron entirely in the web client.
Rejected as the only path because API clients would still be forced into cron,
and the conversion rules would drift across clients.

### 4. Handle unmappable cron as custom recurrence

Schedules that were created through compatibility cron fields or future advanced
APIs may not map to the supported recurrence presets. The API should expose a
non-cron summary such as "Custom recurrence" plus next-run time and timezone.
The console may display and delete such schedules; editing requires choosing one
of the supported recurrence patterns before saving.

Alternative considered: show the raw cron as a fallback. Rejected because the
core requirement is that ordinary users should not need to understand cron.

### 5. Schedule edits are future-only

Updating a recurring task changes the schedule definition and recomputes future
`nextRunAt`. It does not mutate existing `TaskScheduleRun` records or tasks
already created by previous fires. A task that is already running remains
managed from `/tasks/$taskId`.

Alternative considered: retroactively update historical tasks or active runs.
Rejected because task records represent concrete executions and already have
their own lifecycle, transcript, delivery, and audit trail.

## Risks / Trade-offs

- [Supported recurrence set is narrower than cron] -> Provide clear presets for
  common automation and treat unmappable cron as custom/read-only until the user
  chooses a supported pattern.
- [Two schedule input shapes can confuse API validation] -> Make recurrence and
  cron mutually exclusive and add explicit tests for both paths.
- [Duplicating task form state across dialog and full page can drift] -> Extract
  shared schedule/task-template payload builders and recurrence helpers.
- [Editing custom cron schedules may surprise users] -> Label them as custom and
  require selecting a supported recurrence before save instead of silently
  changing timing.
- [Immediate task and recurring schedule submit paths can diverge] -> Keep the
  task-template payload construction shared and test both submit modes.

## Migration Plan

1. Add recurrence DTOs, validation, conversion helpers, and response summaries
   while keeping existing cron fields compatible.
2. Update schedule service create/update paths to accept recurrence or cron,
   normalize to the stored cron/timezone fields, and recompute future `nextRunAt`
   on edits.
3. Refactor task creation surfaces to support run-once and run-repeatedly modes
   with shared task-template controls.
4. Simplify `/schedules` into an overview/detail/manage page with no create
   form and no cron display.
5. Add focused contract, API, and web tests.

Rollback is low risk because cron-backed schedules remain stored in the existing
format. If the console changes roll back, existing schedules still fire through
the current scheduler.

## Open Questions

- Should pause/resume remain first-class actions in `/schedules`, or should the
  first simplified pass keep only edit/delete plus run inspection?
- Should monthly recurrence clamp invalid dates, such as the 31st in shorter
  months, or reject schedules whose selected day cannot occur every month?
