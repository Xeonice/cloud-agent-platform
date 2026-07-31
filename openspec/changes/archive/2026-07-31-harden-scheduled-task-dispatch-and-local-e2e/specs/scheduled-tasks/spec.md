## MODIFIED Requirements

### Requirement: Schedule fire creates a headless task through the existing admission path
The system SHALL create a task from the stored schedule template with execution
mode `headless-exec` when an occurrence is due or an operator dispatches the
current recurrence period early. Automatic and manual dispatch
SHALL resolve the same timezone-aware period identity and reuse the existing
task creation and admission path. Manual dispatch SHALL record its actual
trigger time separately from the period identity. A period with a committed
`created`, `skipped`, or `failed` run SHALL be treated as consumed; a later Task
failure SHALL NOT make that period dispatchable again. The current-period
response SHALL resolve the run for that period identity rather than infer it
only from the most recently created run.

#### Scenario: Operator dispatches the current period immediately
- **WHEN** an operator manually dispatches a schedule before the current period's normal fire time
- **THEN** the system creates one task from the stored template through the same headless admission path
- **AND** the run records both the stable current-period key and the actual manual trigger time
- **AND** `nextRunAt` advances beyond the consumed period when it points into that period or an earlier overdue period
- **AND** a repeated manual request for the same period observes the existing run without creating another Task

#### Scenario: Task fails after the period was dispatched
- **GIVEN** the current period has a `created` run linked to an ordinary Task
- **WHEN** that Task later reaches a failed terminal state
- **THEN** the period remains consumed
- **AND** the API and console report the period dispatch result separately from the Task failure

#### Scenario: Definition update races a current-period dispatch
- **WHEN** resume or a timing update scans the period ledger while a manual dispatch concurrently commits that period
- **THEN** the definition write detects the schedule version change and recomputes its next occurrence
- **AND** `nextRunAt` does not point back into the concurrently consumed period

### Requirement: Each schedule period is recorded exactly once
The system SHALL persist a stable, timezone-aware period key and trigger source
for every newly claimed schedule period. Built-in daily and weekday schedules
SHALL use the local calendar day, weekly schedules the local calendar week, and
monthly schedules the local calendar month. Custom cron schedules SHALL use the
nominal cron occurrence. The database SHALL enforce uniqueness for
`(scheduleId, periodKey)` for non-legacy rows. Historical rows whose prior manual
dispatch semantics cannot be reconstructed MAY retain a null period key. For
built-in calendar recurrences, a legacy row whose `scheduledFor` belongs to the
current calendar period SHALL still make that period non-dispatchable.

#### Scenario: Manual and automatic dispatch race for one period
- **WHEN** a manual request and scheduler tick race for the same current period
- **THEN** exactly one period run and at most one linked Task are committed
- **AND** the losing caller observes the durable winner rather than dispatching the following period

#### Scenario: Failed or skipped period remains visible
- **WHEN** dispatch cannot create a Task or overlap policy skips the current period
- **THEN** one `failed` or `skipped` run consumes that period
- **AND** the current-period response exposes that outcome without reporting a Task lifecycle state that does not exist

### Requirement: Scheduler claims due work durably and recovers interrupted fires
The automatic scheduler SHALL use Postgres-backed claim semantics for due
schedules. An automatic claim SHALL only succeed when the schedule is enabled,
due, and not currently leased by another live claim. Manual dispatch SHALL claim
the current recurrence period and SHALL advance `nextRunAt` beyond that period
when the pointer belongs to it or to an earlier overdue period. Advancing or
preserving `nextRunAt`, creating the
occurrence run ledger, and creating its ordinary Task when applicable SHALL share
one atomic database boundary, so every committed claim has a durable run outcome.
If the API process crashes after the task row and schedule-run row commit but
before admission, recovery SHALL claim the created-but-not-admitted schedule run
and call the existing task admission path for the same task. Each created run
SHALL own an independent admission lease so one interrupted occurrence does not
block a later cadence or a sibling pending run. The linked Task SHALL persist its
canonical owner, and retrying creation-audit recovery SHALL not create duplicate
`task.created` events.

#### Scenario: Claimed schedule advances its next run time
- **WHEN** a scheduler tick successfully claims a due schedule
- **THEN** the schedule's `nextRunAt` advances according to its cron expression and timezone
- **AND** the run ledger for the claimed occurrence is committed atomically with that advance
- **AND** a concurrent tick observing the old due value cannot claim the same occurrence again

#### Scenario: Claim transaction fails before a run is committed
- **WHEN** task creation or a database write fails inside the occurrence transaction
- **THEN** the schedule advance from that transaction is rolled back
- **AND** the occurrence is either committed once as a failed run by the guarded failure path or remains claimable
- **AND** it is never advanced without a durable run ledger

#### Scenario: Manual dispatch crashes after durable creation
- **WHEN** manual dispatch commits its run and task but the process exits before admission
- **THEN** the run remains linked to the same pending task
- **AND** recovery admits that task without creating another manual occurrence

#### Scenario: Recovery admits an interrupted scheduled task
- **WHEN** the process crashes after committing a schedule-run row linked to a pending task but before calling task admission
- **THEN** startup recovery detects the created schedule run
- **AND** it reuses the linked task without creating another occurrence or task
- **AND** concurrent live recovery workers coordinate through that run's admission lease so at most one calls the existing task admission path while the lease is live

#### Scenario: One interrupted admission does not starve the schedule
- **GIVEN** one created run remains pending under a live admission lease
- **WHEN** the schedule reaches another occurrence allowed by its overlap policy
- **THEN** the scheduler may commit that later occurrence without waiting for the earlier admission lease
- **AND** recovery claims for the two run rows remain independent

#### Scenario: Admission recovery is retried idempotently
- **WHEN** recovery retries the same pending task after a process exit or lease expiry
- **THEN** the persisted task owner is used for admission and audit attribution
- **AND** at most one canonical `task.created` audit event exists for that task
- **AND** only the persisted running-token compare-and-set winner may start provider work
- **AND** an ambiguous database acknowledgement is reconciled with the same token without releasing its reservation or starting duplicate provider work

#### Scenario: Stop races with task admission
- **WHEN** an operator stop commits its terminal status CAS after task admission starts but before provider admission settles
- **THEN** that terminal commit is the stop linearization point
- **AND** a synchronous terminal fence prevents any later provider or terminal-session start after that commit
- **AND** a provider result already in flight is torn down when it returns

#### Scenario: Terminal lifecycle transitions race
- **WHEN** two lifecycle actors observe the same active status and request different terminal states
- **THEN** only one status-qualified compare-and-set commits
- **AND** the losing actor observes the winner and cannot overwrite one terminal state with another

#### Scenario: Queued promotion races with slot release
- **WHEN** a slot becomes free while the pending-to-queued database transition is still in flight
- **THEN** promotion waits for that exact transition promise to settle
- **AND** queued-to-running cannot overtake or overwrite the original admission flow

#### Scenario: Schedule mutation does not orphan recovery work
- **WHEN** a committed created run still links to a pending task under a live run-level recovery claim
- **THEN** updating, pausing, or resuming the schedule does not clear that run claim
- **AND** deleting the schedule is rejected as a conflict until the pending admission settles

#### Scenario: Startup immediately checks overdue schedules
- **WHEN** the API process starts with one or more overdue enabled schedules
- **THEN** the scheduler registers its recurring poller and immediately runs a due scan without waiting for the first polling interval
- **AND** a recovery or due-scan error is logged without preventing application startup or later polling
