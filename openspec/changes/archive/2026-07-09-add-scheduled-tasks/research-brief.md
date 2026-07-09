## Research Brief

### Context

CAP already models `Task` as one concrete agent run. The row stores the run
template fields that matter at provision time: `repoId`, `prompt`, `branch`,
`strategy`, `skills`, `runtime`, `sandboxEnvironmentId`, `executionMode`,
`deliver`, `idleTimeoutMs`, and `deadlineMs`.

Task lifecycle is intentionally narrow: `pending`, `queued`, `running`,
`awaiting_input`, and terminal statuses. There is no pre-run scheduling state,
and terminal statuses have no outgoing edges.

Programmatic task creation already exists in two forms:

- `/v1/tasks` persists the task row in a transaction with idempotency and then
  calls `admitCreatedTask` after commit.
- MCP `create_task` delegates to `TasksService.create(..., 'headless-exec')`.

Both programmatic surfaces derive `executionMode = headless-exec`, while console
creation keeps `interactive-pty`.

### Relevant Existing Seams

- `TasksService.createTaskRow` validates repo/runtime/environment selection and
  persists the task row without admitting it.
- `TasksService.admitCreatedTask` records `task.created`, then offers the task to
  guardrails.
- Guardrails owns concurrency, FIFO queued admission, deadline/idle timers,
  startup re-adoption, queued re-offer, teardown, delivery, and transcript
  capture.
- Task owner attribution is currently carried through the `task.created` audit
  event user id. Owner attribution matters because runtime credentials and
  forge delivery credentials are owner-scoped.
- No general cron/worker framework is currently present. Existing timers are
  process-local sweepers and guardrail timers, so durable scheduling needs a DB
  due/claim model rather than memory-only timers.

### Design Implications

- Do not add a `scheduled` task status. A scheduled item is not a task run yet.
- Add a separate durable schedule definition, plus a per-fire run ledger that
  references the created `Task`.
- Schedule firing should call the same service seams as `/v1`/MCP and produce
  `headless-exec` tasks by default.
- Scheduling must preserve owner attribution by storing an owning `userId` on
  the schedule and passing it through the task creation/admission path.
- The scheduler must be restart-safe and multi-instance-tolerant enough for
  ordinary self-host deployments: claim due schedules in the database and use a
  unique schedule-run key to avoid duplicate task creation.

### Candidate Scope

First iteration:

- Persistent `TaskSchedule` and `TaskScheduleRun` storage.
- REST and `/v1` schedule CRUD/read surfaces.
- Polling trigger service in the API process using DB claim and `nextRunAt`.
- `fire-once` missed-run behavior and `skip` overlap policy by default.
- Console schedule management and schedule provenance on task reads.

Deferred:

- Distributed worker/queue infrastructure.
- User-editable timezone calendars beyond cron expression plus IANA timezone.
- Backfilling every missed fire after downtime.
- Per-schedule custom concurrency pools separate from existing guardrails.
- MCP schedule tools, unless needed after the REST/API shape settles.
