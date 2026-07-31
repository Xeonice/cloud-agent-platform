## ADDED Requirements

### Requirement: One-command isolated local schedule verification
The repository SHALL provide one documented command that creates disposable
database state, applies migrations, boots a real API and web console, runs the
scheduled-task E2E story, and removes only resources created by that invocation.
The runner MUST NOT read or mutate an existing CAP database, persistent volume,
fixed development port, or operator credential.

#### Scenario: Developer runs the local verifier beside an existing stack
- **WHEN** a developer runs the schedule E2E command while another CAP stack uses the normal development ports
- **THEN** the verifier selects isolated resource names and loopback ports
- **AND** the existing stack and its data remain unchanged

#### Scenario: Local verification finishes normally
- **WHEN** every E2E assertion passes
- **THEN** the command exits zero
- **AND** its temporary API, web, database, processes, and test records are removed

### Requirement: Live owner-authenticated control-plane story
The local E2E SHALL use a real account session, live schedule HTTP controllers,
the real poller, Prisma, TasksService, Guardrails, audit recorder, and sandbox
provider port. It SHALL NOT replace TasksService or directly create the linked
Task or TaskScheduleRun rows.

#### Scenario: Automatic occurrence reaches ordinary task admission
- **WHEN** an owner creates an enabled schedule and its future occurrence becomes due without calling the dispatch endpoint
- **THEN** the real poller creates exactly one run and one linked ordinary task
- **AND** the task uses `headless-exec`, carries schedule provenance, records owner-attributed creation and running audit events, and invokes the selected sandbox provider

#### Scenario: Manual dispatch reports the actual run time
- **WHEN** the owner dispatches a schedule whose normal `nextRunAt` is still in the future
- **THEN** one run and one linked task are created through the same admission path
- **AND** the run `createdAt` falls within the dispatch request time window
- **AND** the run is recorded against the current recurrence period
- **AND** the normal `nextRunAt` advances beyond the consumed period
- **AND** a repeated request in that period does not create another run or Task

### Requirement: Deterministic due-time control without a production surface
The default local E2E SHALL be able to make a selected schedule due quickly by
changing only `nextRunAt` in its disposable database. This control MUST be bound
to the test process and MUST NOT be registered by the production AppModule or
exposed by a production build. The verifier SHALL also support a wall-clock mode
that waits for a real minute boundary without accelerated database time.

#### Scenario: Accelerated automatic fire
- **WHEN** the E2E control moves a future `nextRunAt` into the due window
- **THEN** the production poll interval observes and claims it without a direct service call
- **AND** the occurrence follows the same run/task path as a wall-clock fire

#### Scenario: Production application is inspected
- **WHEN** the production controller/module graph is built or its OpenAPI surface is listed
- **THEN** no schedule time-control or forced-tick endpoint is present

### Requirement: Cross-surface schedule evidence
The E2E SHALL verify that the live console and REST responses describe the same
schedule, run, and linked task. Schedule responses SHALL expose the actual run
creation time and the nullable current lifecycle status of a linked Task while
keeping the occurrence dispatch status distinct. Adapter-focused tests SHALL
continue to prove MCP delegation to the same ScheduledTasksService contracts.

#### Scenario: Browser observes an automatically created run
- **WHEN** the automatic occurrence is committed
- **THEN** the console shows the run using its actual `createdAt`
- **AND** its task link targets the same task id returned by the live run API

#### Scenario: Immediate dispatch is refreshed in the console
- **WHEN** the operator clicks the console immediate-dispatch action
- **THEN** the returned schedule replaces the visible cached schedule before background refresh completes
- **AND** the visible actual-dispatch time represents the new run rather than the schedule's planned future occurrence
- **AND** the current period is visibly marked as handled and cannot be dispatched again
- **AND** the next scheduled cycle is displayed separately beyond the consumed period

#### Scenario: Linked Task fails after a successful occurrence dispatch
- **GIVEN** a schedule run successfully created an ordinary Task
- **WHEN** that linked Task later reaches `failed` or `agent_failed_to_start`
- **THEN** the run continues to report its occurrence status as `created`
- **AND** the schedule response reports the linked Task lifecycle status separately
- **AND** the console shows both the successful dispatch and failed Task outcome with the ordinary Task link

### Requirement: Actionable and secret-safe failure artifacts
The E2E runner SHALL use bounded state polling and SHALL retain browser and service
evidence when an assertion fails. Captured evidence MUST exclude passwords,
session cookies, authorization headers, provider credentials, and environment
files.

#### Scenario: Browser assertion fails
- **WHEN** a Playwright schedule assertion times out or fails
- **THEN** the result includes a retained trace and failure screenshot
- **AND** sanitized schedule, run, task, audit, API, web, and database diagnostics are available from the same invocation

#### Scenario: Developer keeps a failed stack
- **WHEN** the developer enables the documented keep-stack option
- **THEN** the verifier prints the retained resource identifiers and cleanup command
- **AND** retained diagnostic logs are immutable sanitized snapshots even while the stack remains live
- **AND** it does not retain or print secret material
