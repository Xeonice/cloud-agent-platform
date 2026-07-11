## Context

Scheduled tasks are implemented as a trigger layer above ordinary task creation.
The fast suite covers recurrence and policy logic, and one real-Postgres test runs
the real polling timer. That test constructs `ScheduledTasksService` directly and
replaces task normalization, creation, and admission, so it cannot prove that the
live owner-authenticated API and console reach the real task lifecycle.

The dispatcher also commits two durability boundaries in the wrong order. It
first advances `nextRunAt` and records a transient claim, then later creates the
run ledger and task in another transaction. A process exit between those commits
leaves no durable identity for the claimed occurrence.

The local workspace may already have CAP, Postgres, and web ports in use. The E2E
runner must therefore be isolated and must not depend on a developer's `.env`,
database, model credential, sandbox image, or fixed port.

## Goals / Non-Goals

**Goals:**

- Guarantee that every committed automatic or manual claim has a durable run
  outcome and, for a created outcome, exactly one ordinary task.
- Persist and expose whether the current timezone-aware recurrence period has
  already been handled, independently from the linked Task lifecycle result.
- Preserve the existing post-commit TasksService/Guardrails admission path and
  make its restart recovery testable with real Postgres.
- Provide one local command that boots disposable infrastructure and verifies the
  live schedule story through a real owner session, API, console, poller, task
  lifecycle, audit records, and provider-port invocation.
- Keep accelerated time control outside production routes and confined to the
  disposable test process/database.
- Produce enough failure evidence to diagnose the schedule, run, task, lifecycle,
  and UI layer without repeating an online deployment.

**Non-Goals:**

- Calling OpenAI or Anthropic during the required scheduled-task E2E gate.
- Replacing the existing AIO and BoxLite provider E2E suites.
- Adding second-resolution production cron, a mutable production clock endpoint,
  or a production-only testing mode.
- Reusing or deleting an existing local CAP stack, database, or sandbox.

## Decisions

### 1. Persist the occurrence and task in the claim transaction

Automatic and manual dispatch share one occurrence-persistence operation and
resolve the same recurrence-period identity. Built-in daily/weekday, weekly, and
monthly schedules use their timezone-local calendar day, week, or month;
arbitrary cron expressions use the nominal cron occurrence. Within
one Prisma transaction it conditionally acquires the schedule row, advances (or
preserves) `nextRunAt`, creates the run ledger, and creates the ordinary headless
task when the outcome is `created`. New runs persist `periodKey`, `triggerSource`,
and `triggeredAt`; `(scheduleId, periodKey)` is the final same-period duplicate
boundary while nullable keys keep historical rows readable.

`scheduledFor` remains the nominal plan time and `triggeredAt` is the actual
manual click or automatic tick time. A manual request carries the period key seen
by the caller, so a delayed retry cannot consume the following period. A
committed `created`, `skipped`, or `failed` run consumes the period. The linked
Task may later fail without reopening that period.

The transaction records `skipped` outcomes atomically with the schedule advance.
If owner/template/task validation fails and the create transaction rolls back, a
second conditional transaction advances the same still-current occurrence and
records a `failed` run. If another process won in between, its compare-and-set
precondition prevents the loser from writing another outcome.

Task admission stays after commit. This is intentional: Guardrails and provider
work must not run while a database transaction is open. A committed `created`
run whose linked task remains `pending` is recoverable through the run ledger's
admission lease. Direct tasks continue to use the startup pending-task scan,
while scheduled tasks remain behind the occurrence-level recovery claim. The
admission seam uses a task-status compare-and-set to choose the process that may
start provider work, persists separate queued/running winner tokens so an
ambiguous database acknowledgement can be reconciled without guessing, shares
in-flight admission within one process, persists the task owner on the Task row,
and records task creation through a retry-safe audit key. A failed lifecycle
transition releases its semaphore reservation; an indeterminate transition keeps
the reservation and retries with the same token.

Alternatives considered:

- Persist only a `claimed` run before task creation. Rejected because recovery
  would need a frozen task-template snapshot that the current run schema does not
  store, or would incorrectly use a later schedule edit.
- Add a distributed queue. Rejected because Postgres compare-and-set plus the
  unique period key is sufficient for the current deployment model.
- Keep the two commits and shorten the lease. Rejected because it reduces but
  cannot remove occurrence loss.

### 2. Separate occurrence claims from admission recovery leases

The schedule claim protects the occurrence compare-and-set and is released after
the post-commit admission attempt. The ledger/task transaction, not that claim,
is the durable source of occurrence truth. Each created run carries a separate,
token-conditional admission claim with its own expiry. An admission failure or
process exit therefore keeps only that occurrence leased; the schedule can still
reach a later cadence subject to its overlap policy.

Recovery workers claim pending runs independently, then use the task-status
compare-and-set as the final boundary before provider work. Two pending runs for
one schedule can be recovered without one run's lease starving the other. These
guards prevent duplicate live admission under the tested races; they do not make
an arbitrary external provider side effect transactionally exactly-once across a
process crash after the provider has accepted work.

Queued promotion chains the still-running pending-to-queued admission promise, so
a synchronous slot release cannot advance the same task before queued is durable.
Before and after provider provisioning, Guardrails verifies the persisted running
winner token and a synchronous terminal fence. The terminal status CAS is the
stop linearization point: once it commits, a stop suppresses any later provider
start or tears down an already in-flight provider result before opening a terminal
session. General lifecycle transitions use the observed status in their update
CAS, so two terminal actors cannot overwrite one another from stale reads.

### 3. Separate fast Postgres integration from live control-plane E2E

The existing test is retained and named/documented as Postgres scheduler
integration. It remains a required PR gate for timer, transaction, race, and
recovery behavior.

A new live E2E boots the real AppModule and web app. It overrides only the
outermost `SANDBOX_PROVIDER` port with an explicit deterministic test provider.
That provider records the real Guardrails provisioning call and fails
deterministically, allowing the test to prove `pending -> running -> failed`,
audit attribution, and slot settlement without an image or model credential.
TasksService, Guardrails, Prisma, controllers, authentication, and the schedule
poller are not replaced.

Provider execution remains a compositional gate: existing AIO/BoxLite E2E suites
prove that an admitted ordinary task can provision and execute. An optional future
deep schedule mode can reuse the same browser driver with a deterministic CLI in
a real provider image.

Alternatives considered:

- Stub TasksService as the current test does. Rejected because it bypasses the
  boundary this E2E is meant to prove.
- Require a real Codex credential and provider image. Rejected for the required
  local gate because it introduces external cost, network, architecture, and
  secret failures unrelated to scheduling.

### 4. Use a test-process control port for accelerated due time

The custom E2E server binds a loopback-only control endpoint separate from the
product API. It uses the real Prisma client to move only the selected disposable
schedule's `nextRunAt`; it is defined under `apps/api/test` and is never imported
by AppModule or production builds.

The default local story accelerates a future occurrence and waits for the real
interval callback. An optional wall-clock mode schedules the next UTC minute and
does not use the control endpoint. Contract tests continue to own cron/timezone/DST
calculation coverage.

Alternatives considered:

- A production `/internal/test/tick` endpoint or clock-offset environment variable.
  Rejected because either creates a product attack surface or changes production
  time semantics for testing.
- Fixed sleeps. Rejected because bounded state polling is faster and gives better
  diagnostics.

### 5. Run against disposable, dynamically addressed infrastructure

`scripts/scheduled-tasks-e2e.sh` owns the lifecycle. It starts a uniquely named
Postgres container on a dynamic loopback port, applies migrations, builds the API,
starts the custom E2E API server and Vite web server on dynamic ports, and runs a
dedicated Playwright configuration. A trap removes only resources created by that
invocation. `KEEP_E2E_STACK=1` retains the failure site deliberately.

The browser authenticates using a fixed throwaway admin in the disposable DB and
uses product password endpoints to complete the first-login password rotation.
An ownerless legacy bearer is not used because schedule ownership is part of the
contract.

### 6. Make failure evidence a first-class output

The Playwright configuration retains trace, screenshot, and video on failure.
The runner also captures sanitized schedule/run/task/audit JSON, E2E API logs,
web logs, and Postgres/container status. Cookies, authorization headers, generated
passwords, and environment files are never included. Before evidence is declared
safe, stopped stacks close their log writers; a deliberately retained live stack
replaces visible log paths with immutable snapshots and lets the running processes
continue only through unlinked file descriptors.

## Risks / Trade-offs

- [The deterministic provider intentionally ends tasks as failed] -> Assert the
  real running audit and provider invocation before the expected terminal failure;
  keep real provider execution in its existing dedicated suites.
- [Dynamic-process cleanup can fail after a hard kill] -> Use unique names and
  print an exact cleanup command; support `KEEP_E2E_STACK=1` for diagnosis.
- [Accelerated DB time is a gray-box control] -> Restrict mutation to `nextRunAt`
  in a disposable DB and retain an optional wall-clock story.
- [A second transaction is needed to record validation failures] -> Guard it with
  the same expected schedule state; a concurrent winner makes it a no-op.
- [Post-commit admission can still fail transiently] -> Preserve the pending task
  and created run, retain its occurrence-level admission lease until expiry, and
  recover the same task; add real-Postgres proof.
- [New attribution and lease state must work for existing rows] -> Backfill the
  task owner and canonical creation-audit key where history is available, keep
  owner reads compatible with legacy audit attribution, and allow null leases on
  already settled runs.

## Migration Plan

1. Apply the additive migrations that persist `Task.ownerUserId`, queued/running
   admission winner tokens, a unique audit deduplication key, and occurrence-level
   admission claim token/expiry fields, plus nullable schedule-run period identity,
   trigger source, and trigger time. Backfill owner from task-creation audit or the
   run-to-schedule relationship and backfill canonical task-creation keys; do not
   write guessed period identities into legacy manual rows. At read/dispatch time,
   treat a legacy built-in-calendar run whose `scheduledFor` falls in the current
   day/week/month as consuming that period.
2. Deploy the dispatcher and admission changes behind focused real-Postgres tests.
   The current-period response and optional dispatch request key are additive and
   tolerate old rows and body-less callers. Resume and definition updates use a
   schedule-version CAS and recompute after conflicts with period dispatch.
3. Add the isolated E2E server, runner, and browser story without changing the
   normal development stack.
4. Keep the current CI integration gate and add the browser job independently.
5. After repeated stable runs, make the browser job required; keep provider-deep
   execution manual/nightly.

For rollback, deploy code that tolerates the additive nullable columns before
reverting the dispatcher and removing the isolated harness. The added columns and
unique key may remain in place; removing them is unnecessary for client or runtime
compatibility and should be handled only by a later explicit migration.

The supported compose topology runs one API service and replaces that container
during upgrade. This migration is not a mixed-version rolling-deploy protocol:
operators using an unsupported multi-replica topology must drain old API workers
before starting the new admission implementation.

## Open Questions

- Whether the optional wall-clock story belongs in the required CI job or a
  scheduled workflow after runtime data establishes its stability.
- Whether a future provider-deep schedule story should select BoxLite on macOS and
  AIO on Linux, or use the cloud-http fixture protocol as one portable adapter.
