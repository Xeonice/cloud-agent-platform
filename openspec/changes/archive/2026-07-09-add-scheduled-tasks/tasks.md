<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: contracts-and-storage (depends: none)

- [x] 1.1 Add scheduled-task contract schemas for schedule create/update/read, schedule-run read, overlap/misfire/status enums, and paginated list envelopes.
- [x] 1.2 Add contract tests covering cron/timezone validation, ownerless create rejection shape, task-template fields, schedule response redaction, and schedule-run response parsing.
- [x] 1.3 Add Prisma models and migration for `TaskSchedule` and `TaskScheduleRun`, including owner/repo/task relations, due/owner indexes, occurrence uniqueness, claim lease fields, and run status fields.
- [x] 1.4 Add schedule provenance storage for tasks or a durable run-to-task relation that lets task read paths expose schedule id and scheduled fire time.
- [x] 1.5 Add a maintained cron/timezone parser dependency and a pure next-fire helper with DST and invalid-expression tests.

## 2. Track: schedule-core-service (depends: contracts-and-storage)

- [x] 2.1 Implement `ScheduledTasksModule` and `ScheduledTasksService` with create/list/get/update/pause/resume/delete methods scoped to the owner account.
- [x] 2.2 Normalize schedule task templates through the existing task-create validation rules, resolving omitted sandbox environment selection at schedule creation.
- [x] 2.3 Implement due schedule claiming with Postgres compare-and-set semantics and `(scheduleId, scheduledFor)` de-duplication.
- [x] 2.4 Implement schedule fire execution using `TasksService.createTaskRow` in a transaction with `TaskScheduleRun`, followed by post-commit `admitCreatedTask`.
- [x] 2.5 Implement startup recovery for schedule runs committed with a linked pending task before admission.
- [x] 2.6 Implement missed-fire `fire-once` behavior and overlap policies `skip` and `enqueue`, recording skipped/failed outcomes without fabricating tasks.
- [x] 2.7 Add service tests for owner scoping, claim races, crash recovery, skipped overlap, enqueue overlap, failed validation at fire time, and next-run advancement.

## 3. Track: task-read-provenance (depends: contracts-and-storage)

- [x] 3.1 Extend task response mapping so scheduled tasks return nullable schedule provenance and direct tasks return null/absent provenance.
- [x] 3.2 Add API/service tests proving schedule provenance does not alter task lifecycle transitions, guardrails queuing, terminal settlement, or direct task reads.

## 4. Track: api-and-openapi (depends: schedule-core-service, task-read-provenance)

- [x] 4.1 Add owner-scoped unversioned schedule controllers or service endpoints needed by the console.
- [x] 4.2 Add `/v1/schedules` controllers for create/list/get/update/pause/resume/delete and recent run listing.
- [x] 4.3 Enforce `tasks:read`/`tasks:write` scopes plus owner-account requirements on schedule routes.
- [x] 4.4 Register schedule schemas and routes in the OpenAPI registry and add generation tests proving `/v1/openapi.json` includes them.
- [x] 4.5 Add controller tests for scope failures, owner isolation, ownerless create rejection, pagination, and run response shapes.

## 5. Track: frontend-console (depends: api-and-openapi)

- [x] 5.1 Add real API client methods, query keys, query options, and mutations for schedule CRUD, pause/resume/delete, and run listing.
- [x] 5.2 Build a schedule list/management view showing enabled state, repo, runtime, cron, timezone, next run time, overlap policy, and latest outcome.
- [x] 5.3 Build a schedule create/edit form reusing task-template controls where practical, including repo, prompt, runtime, sandbox environment, delivery, skills, guardrails, cron, timezone, and policies.
- [x] 5.4 Add recent-run history UI with linked task navigation for successful fires and honest skipped/failed rows without task links.
- [x] 5.5 Add focused frontend tests for create payloads, pause/resume/delete invalidation, skipped/failed run rendering, and task-link navigation.

## 6. Track: validation (depends: frontend-console)

- [x] 6.1 Run targeted contract, Prisma, scheduled-task service, task provenance, `/v1`, OpenAPI, and web tests.
- [x] 6.2 Run OpenSpec validation for `add-scheduled-tasks`.
- [x] 6.3 Document any remaining rollout notes or manual verification gaps in the change before implementation is marked complete.
