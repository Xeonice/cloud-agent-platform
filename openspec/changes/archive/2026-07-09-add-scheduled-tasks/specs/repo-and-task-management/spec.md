## ADDED Requirements

### Requirement: Task reads expose schedule provenance
Task records created by a schedule SHALL expose schedule provenance on task read
paths. The provenance SHALL identify the schedule and the scheduled fire time,
and it SHALL be nullable for tasks created directly through the console, `/v1`,
or MCP. Schedule provenance SHALL NOT expose owner credentials, schedule claim
leases, or scheduler internals.

#### Scenario: Scheduled task response includes provenance
- **WHEN** a client reads a task created from a schedule
- **THEN** the task response includes a nullable schedule provenance object with
  the schedule id and scheduled fire time
- **AND** the ordinary task status remains one of the existing task lifecycle
  values

#### Scenario: Direct task response has no provenance
- **WHEN** a client reads a task created directly from the console, `/v1`, or MCP
- **THEN** the task response has null or absent schedule provenance
- **AND** the response remains valid against the shared task contract

### Requirement: Schedule-created tasks preserve normal task lifecycle behavior
Tasks created by schedules SHALL move through the same task lifecycle as
directly created tasks. The scheduler SHALL NOT write task statuses directly
except through the existing task creation and admission services, and schedule
provenance SHALL NOT add, remove, or gate lifecycle transitions.

#### Scenario: Scheduled task queues when capacity is full
- **WHEN** a schedule fires while the guardrails concurrency ceiling is already
  full
- **THEN** the created task transitions to `queued` through the existing
  guardrails admission path
- **AND** it is later admitted in FIFO order like other queued tasks

#### Scenario: Scheduled task reaches terminal through existing settlement
- **WHEN** a task created by a schedule completes, fails, or is cancelled
- **THEN** transcript capture, optional delivery, sandbox teardown, and slot
  release run through the existing terminal settlement path
