## MODIFIED Requirements

### Requirement: /v1 schedule contracts are additive and documented
The `/v1` schedule request/response schemas SHALL be added to `@cap/contracts`
alongside existing `/v1` schemas. The schedule schemas SHALL include create,
update, schedule response, schedule-run response, paginated list envelopes, and
recurrence descriptors for product clients. The generated OpenAPI 3.1 document
SHALL include every `/v1/schedules` route and derive request/response shapes
from the same schemas used for controller validation. Existing cron-based
schedule fields SHALL remain available as a compatibility path unless a future
breaking API version removes them, but recurrence-first fields SHALL be the
documented product path.

#### Scenario: OpenAPI includes schedule routes
- **WHEN** a client requests `GET /v1/openapi.json`
- **THEN** the document includes every `/v1/schedules` route
- **AND** each route references the same schedule schemas used by the controller
  validation path
- **AND** the documented schedule create/update schemas include recurrence
  descriptors that do not require cron syntax

#### Scenario: Schedule schemas do not mutate task create schemas
- **WHEN** schedule DTOs are added to `@cap/contracts`
- **THEN** existing task create and task read schemas remain backward-compatible
- **AND** schedule-specific create/update fields are not required by
  `POST /v1/tasks`

#### Scenario: Recurrence and cron inputs are mutually exclusive
- **WHEN** a client submits both a recurrence descriptor and a cron expression in
  one schedule create or update request
- **THEN** the request is rejected with a validation error
- **AND** no schedule definition is changed

## ADDED Requirements

### Requirement: /v1 recurrence responses hide scheduler internals for product clients
The `/v1` schedule response SHALL include recurrence metadata or a recurrence
summary suitable for product clients to display without parsing or showing cron.
For schedules created from compatibility cron expressions that cannot be mapped
to supported recurrence descriptors, the response SHALL still include a
non-secret custom recurrence summary and next run time.

#### Scenario: Supported recurrence reads back as descriptor
- **WHEN** a client creates a schedule with a supported recurrence descriptor
- **THEN** subsequent schedule reads include that recurrence descriptor or an
  equivalent normalized descriptor
- **AND** clients can render the schedule without using `cronExpression`

#### Scenario: Unmappable cron reads back as custom recurrence
- **WHEN** a schedule exists with a valid cron expression that does not map to a
  supported recurrence preset
- **THEN** the schedule response includes a custom recurrence summary and the
  schedule timezone
- **AND** the response does not require product clients to display the raw cron
  expression to ordinary users
