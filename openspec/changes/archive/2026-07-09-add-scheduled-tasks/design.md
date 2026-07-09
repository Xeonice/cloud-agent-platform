## Context

CAP currently treats `Task` as a concrete agent run. The task row stores the
run parameters, then guardrails owns admission, queued/running state,
deadline/idle timers, terminal settlement, delivery, and recovery. Programmatic
consumers already create `headless-exec` tasks through `/v1/tasks` and MCP, so a
schedule fire can reuse the same semantics.

The missing piece is durable time-based creation. A memory-only timer would lose
state on restart and could double-fire under multiple API processes. The design
therefore keeps the timer lightweight but makes the source of truth Postgres:
schedule definitions, occurrence ledgers, due claiming, and task linkage are all
durable.

```
TaskSchedule
  id, ownerUserId, repoId, taskTemplate, cron, timezone, nextRunAt, enabled
          |
          v
TaskScheduleRun
  scheduleId, scheduledFor, status, taskId, error
          |
          v
Task
  ordinary headless-exec run, admitted through existing guardrails
```

## Goals / Non-Goals

**Goals:**
- Define recurring task schedules without adding a new task lifecycle status.
- Create ordinary `headless-exec` tasks from schedule fires through the existing
  task creation and admission seams.
- Preserve owner attribution so runtime credentials and forge delivery remain
  scoped to the schedule owner.
- Make schedule firing restart-safe and duplicate-resistant with Postgres claim
  and occurrence uniqueness.
- Expose schedule management through contracts, `/v1`, and the authenticated
  console.

**Non-Goals:**
- Add Redis, BullMQ, pg_cron, or a separate worker service.
- Catch up every missed occurrence after long downtime.
- Add per-schedule concurrency pools separate from guardrails.
- Add a `scheduled` task status or allow terminal tasks to be re-opened.
- Add MCP schedule tools in this first iteration.

## Decisions

### 1. Model schedules separately from task runs

Add `TaskSchedule` for recurring definitions and `TaskScheduleRun` for each
claimed occurrence. A schedule stores owner, repo, task template, cron
expression, timezone, enabled state, `nextRunAt`, `overlapPolicy`,
`misfirePolicy`, and timestamps. A run stores `scheduleId`, `scheduledFor`,
`status`, optional `taskId`, and optional error text.

Alternative considered: add `scheduled` to `TaskStatus`. Rejected because the
existing lifecycle describes a run after task creation. A future intent to run
is a different entity and must not share terminal-state semantics.

### 2. Fire schedules as programmatic headless tasks

Each due occurrence creates a task with `executionMode = headless-exec`. The
scheduler uses the existing `TasksService.createTaskRow` plus
`admitCreatedTask` split so task creation can be transactionally linked to a
schedule-run row, while sandbox admission still happens only after commit.

Alternative considered: call `/v1/tasks` over HTTP from inside the API. Rejected
because it creates a second network path, duplicates auth/rate-limit concerns,
and obscures transaction boundaries.

### 3. Store owner identity on schedules and reject ownerless creates

A schedule has `ownerUserId` and only fires tasks attributed to that user.
Schedule creation requires an authenticated account principal; ownerless legacy
principals cannot create schedules. API-key principals manage schedules as their
owning account.

Alternative considered: allow system-owned schedules. Rejected for the first
iteration because Codex/Claude credentials and forge delivery are already
owner-scoped. A system-owned schedule would either skip useful credentials or
need a separate credential model.

### 4. Use DB claim plus occurrence uniqueness

The scheduler loop periodically reads due enabled schedules and attempts to
claim one occurrence by updating the schedule only when `nextRunAt` still equals
the observed due value and any claim lease is expired. It then creates a
`TaskScheduleRun` row with a unique `(scheduleId, scheduledFor)` key. Duplicate
workers converge on one committed occurrence; losers skip.

If the process crashes after the task row and schedule-run row commit but before
admission, a recovery pass finds `created` runs with pending linked tasks and
calls `admitCreatedTask` once.

Alternative considered: rely on a single API process and in-memory state.
Rejected because CAP self-host deployments can restart frequently, and the
schedule feature should not silently duplicate or drop fires.

### 5. Default missed-fire and overlap behavior are conservative

`misfirePolicy = fire-once` is the default: when `nextRunAt` is in the past, the
scheduler fires at most one occurrence and then advances to the next future
time. It does not replay every missed cron tick.

`overlapPolicy = skip` is the default: if a prior schedule-created task for the
same schedule is still non-terminal, the due occurrence is recorded as skipped
and no new task is created. `enqueue` is supported as an explicit policy and
creates another task that guardrails may queue.

Alternative considered: default catch-up and enqueue. Rejected because downtime
could flood the guardrails queue and consume credentials unexpectedly.

### 6. Resolve task template at schedule creation, revalidate at fire time

The schedule stores a normalized task template. Creation validates repo,
runtime, task body, and sandbox environment selection using the same rules as
task creation. If the caller omits `sandboxEnvironmentId`, the owner default is
resolved at schedule creation and stored, so later account-setting changes do
not silently alter the schedule. Each fire still revalidates runtime readiness
and sandbox environment readiness before creating a task.

Alternative considered: always inherit the latest account default at fire time.
Rejected because schedules should be repeatable and inspectable.

### 7. Keep API scopes aligned with tasks but isolate by owner

`tasks:read` can read schedules owned by the principal account, and
`tasks:write` can create/update/delete them. A session principal without scopes
has allow-all at the auth layer but still manages its own account's schedules.
This differs from shared-pool task reads because schedules authorize future
work under a specific account.

Alternative considered: shared schedule management matching current task list
semantics. Rejected because pausing or editing another user's recurring work is
more sensitive than reading historical task rows.

## Risks / Trade-offs

- [Process-local scheduler] -> It is simpler than a worker queue but still runs
  in the API process. Mitigate with DB claim, occurrence uniqueness, and
  recovery for committed-but-not-admitted runs.
- [Cron/timezone complexity] -> DST and timezone math are easy to get wrong.
  Mitigate by using a maintained cron parser with IANA timezone support and
  contract tests for DST boundaries.
- [Schedule owner disabled later] -> A previously valid owner may become
  de-allowlisted. Mitigate by checking owner existence/allowed state at fire time
  and recording a failed schedule run without creating a task.
- [Runtime or image invalid later] -> A schedule can outlive credential or image
  readiness. Mitigate by reusing task create validation at fire time and
  recording the failure on the schedule-run ledger.
- [Skipped occurrences surprise users] -> Default skip prevents queue floods but
  may omit work. Mitigate by surfacing skipped runs in API/UI and offering
  explicit `enqueue`.

## Migration Plan

1. Add Prisma models and migration for schedules and schedule runs.
2. Add contracts and pure validation/next-fire helpers.
3. Add schedule service/controller and `/v1` controllers without enabling the
   trigger loop until service tests pass.
4. Add trigger loop and recovery pass using DB claim and run ledger semantics.
5. Add console management views.
6. Validate with targeted contract/API/service/web tests and OpenSpec strict
   validation.

Rollback is safe before schedules are used. After schedules exist, rolling back
code leaves the schedule tables inert; no background work runs until a version
with the scheduler is deployed again.

## Open Questions

- Should admins have an explicit "all schedules" view, or should first
  iteration remain strictly owner-scoped?
- Should manual "run now" be included in the first implementation or deferred
  until ordinary recurrence is proven?
