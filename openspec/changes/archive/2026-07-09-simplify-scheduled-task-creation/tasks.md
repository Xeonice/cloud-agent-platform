<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: recurrence-contracts (depends: none)

- [x] 1.1 Add schedule recurrence DTO schemas for daily, weekdays, weekly, and monthly patterns with local time and IANA timezone validation.
- [x] 1.2 Add helpers that normalize supported recurrence DTOs to the scheduler's existing cron/timezone representation and derive recurrence descriptors or summaries from stored schedules.
- [x] 1.3 Update create/update schedule schemas to accept recurrence descriptors or existing cron fields, reject requests that provide both, and preserve backward compatibility for cron-only clients.
- [x] 1.4 Update schedule response schemas to include recurrence metadata or summaries suitable for product clients without parsing cron.
- [x] 1.5 Add contract tests for supported recurrence conversion, invalid recurrence rejection, recurrence/cron mutual exclusion, supported descriptor readback, and unmappable cron custom summaries.

## 2. Track: schedule-service-api (depends: recurrence-contracts)

- [x] 2.1 Update scheduled task service create/update paths to normalize recurrence DTOs before persisting schedules and recompute `nextRunAt` from updated recurrence/timezone values.
- [x] 2.2 Ensure schedule updates mutate only the schedule definition for future fires and do not alter existing task rows, run rows, transcripts, or active task lifecycle state.
- [x] 2.3 Update unversioned console schedule endpoints and `/v1/schedules` controllers to accept recurrence-first payloads and preserve cron compatibility.
- [x] 2.4 Update OpenAPI registration so schedule create/update docs expose recurrence-first fields and document cron as compatibility behavior.
- [x] 2.5 Add API/service tests for recurrence create, recurrence update, cron compatibility, custom summary response, owner scoping, and future-only edit behavior.

## 3. Track: shared-task-form (depends: recurrence-contracts)

- [x] 3.1 Extract shared task-template form state and payload builders used by `NewTaskDialog`, `/tasks/new`, and recurring schedule edit mode.
- [x] 3.2 Add run-once versus run-repeatedly mode state to the dashboard task dialog, preserving existing immediate task submission behavior by default.
- [x] 3.3 Add run-once versus run-repeatedly mode state to `/tasks/new`, including recurrence controls for repeated mode.
- [x] 3.4 Submit repeated mode through schedule create/update mutations while immediate mode continues using the existing task create mutation.
- [x] 3.5 Add frontend tests for mode switching, shared task-template field preservation, immediate create payloads, recurring create payloads, and edit-recurring save behavior.

## 4. Track: schedules-overview (depends: recurrence-contracts)

- [x] 4.1 Remove the standalone schedule creation/edit form and new-schedule action from `/schedules`.
- [x] 4.2 Redesign `/schedules` as an overview/detail page showing schedule name or prompt summary, repo, runtime, enabled state, recurrence summary, timezone, next run, overlap policy, and latest outcome.
- [x] 4.3 Render recent schedule runs with honest skipped/failed rows and linked `/tasks/$taskId` navigation for successful fires.
- [x] 4.4 Add edit actions that route to the shared task form in edit-recurring mode with schedule data prefilled.
- [x] 4.5 Keep delete confirmation and schedule deletion invalidation; keep pause/resume controls if the current implementation retains them.
- [x] 4.6 Add frontend tests proving `/schedules` has no create form, does not render raw cron, shows custom recurrence summaries, opens linked tasks, routes to edit mode, and deletes schedules.

## 5. Track: validation (depends: schedule-service-api, shared-task-form, schedules-overview)

- [x] 5.1 Run contract schedule tests and package build for `@cap/contracts`.
- [x] 5.2 Run targeted API scheduled-task, `/v1` schedule controller, and OpenAPI tests.
- [x] 5.3 Run targeted web schedule/task-create tests plus web typecheck.
- [x] 5.4 Run `openspec validate simplify-scheduled-task-creation --strict`.
- [x] 5.5 Note any manual verification gaps for recurring create, schedule edit, `/schedules` overview, and linked task takeover.
