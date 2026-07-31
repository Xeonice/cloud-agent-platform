# Research Brief: Scheduled Task Durability and Local E2E

## Current State

- `ScheduledTasksService` keeps schedules separate from ordinary tasks and uses a
  Postgres-backed due scan plus claim lease.
- Unit tests cover recurrence normalization, dispatch semantics, competing ticks,
  overlap policies, failed fires, and pending-admission recovery.
- `apps/api/test/scheduled-tasks-e2e.mjs` uses real Postgres and the real polling
  timer, but replaces `TasksService` with a narrow fake. It does not boot Nest,
  authenticate an owner, traverse HTTP/MCP, use Guardrails, provision a sandbox,
  or render the console.
- CI runs that Postgres integration test. Existing Playwright suites run against
  mock/static data and do not cover `/schedules` against a live API.
- The existing test can run locally after manually providing and migrating a
  disposable Postgres database. There is no repository-owned one-command runner.

## Correctness Gap

The current claim boundary advances `TaskSchedule.nextRunAt` and commits the
claim lease before `TaskScheduleRun` and `Task` are created in a later
transaction. A process exit between those commits loses the old occurrence:
the ledger has no row for it and later ticks only see the already-advanced
`nextRunAt`. The same window exists for manual dispatch.

Recovery currently covers only the later boundary where the run and task exist
but task admission did not finish. It cannot reconstruct a claim that never
reached the run ledger.

Manual dispatch also lacks a durable recurrence-period identity: its historical
`scheduledFor` is the click time, so the API and console cannot answer whether
the current local day/week/month has already been handled or prevent a retry from
creating another Task for that period.

## Recommended Boundaries

1. Make occurrence claim/advance and durable run/task creation one atomic
   database boundary. Admission remains post-commit and restart-recoverable.
2. Persist a stable period key and actual trigger metadata. Automatic and manual
   paths must converge on one period record, and Task failure must remain distinct
   from period consumption.
3. Keep the current real-Postgres test as a fast integration gate, but add real
   Postgres race, rollback, and restart-recovery cases.
4. Add an isolated local runner that creates temporary Postgres state, migrates
   it, boots the real API and web console with an owner account, and runs a
   Playwright schedule story.
5. Accelerate automatic-fire tests by changing only `nextRunAt` in the disposable
   test database. Do not add production test endpoints, second-resolution cron,
   or system-clock mutation. Retain an optional real-wall-clock mode.
6. Treat schedule E2E completion as proof that the schedule created one ordinary
   headless task through real TasksService/Guardrails admission. Provider-specific
   execution remains covered by the existing AIO/BoxLite suites; an optional deep
   mode may use a deterministic test CLI in a real sandbox image without external
   model credentials.

## Required Evidence

- Automatic due fire creates exactly one run and one linked headless task, then
  advances `nextRunAt`.
- Immediate dispatch records actual trigger time, consumes the current period,
  advances a pointer that still belongs to that period, and reuses the same run
  on a same-period retry.
- The linked task carries schedule provenance, owner attribution, and real
  admission/audit evidence.
- Two competing schedulers converge on one occurrence.
- Failure inside the atomic database boundary rolls back the schedule advance.
- A committed pending task is admitted after application restart without a
  duplicate task.
- The browser displays current-period state, actual trigger time, next run, and
  linked Task outcome using the same contract exposed by REST/MCP adapters.

## Local Runner Constraints

- Unique compose/project identity, dynamic ports, temporary volumes, and cleanup
  traps; never reuse the developer's `.env`, database, or running CAP stack.
- Real account/session authentication because ownerless legacy bearer tokens
  cannot create schedules.
- Bounded polling instead of fixed sleeps.
- Failure artifacts include Playwright trace/screenshots and sanitized API,
  schedule, run, task, and service-log evidence. Secrets and cookies are excluded.
