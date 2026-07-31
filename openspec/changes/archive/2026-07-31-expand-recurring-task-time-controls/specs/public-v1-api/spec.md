## ADDED Requirements

### Requirement: /v1 schedule contracts expose sub-day recurrence presets
The shared `/v1` schedule schemas SHALL expose hourly recurrence with
`minuteOfHour` from 0 through 59 and `minuteInterval` recurrence with
`intervalMinutes` equal to 5, 10, 15, or 30.
Requests and responses SHALL use the same recurrence variants as Console and MCP
schedule operations. Existing cron-based fields SHALL remain a mutually exclusive
compatibility path.

#### Scenario: /v1 hourly recurrence round-trips
- **WHEN** a scoped client creates or updates a schedule with `kind = hourly`,
  `minuteOfHour = 15`, and a valid IANA timezone
- **THEN** `/v1` accepts the request
- **AND** subsequent schedule reads return the equivalent hourly descriptor and
  human-readable summary

#### Scenario: /v1 minute interval round-trips
- **WHEN** a scoped client creates or updates a schedule with
  `kind = minuteInterval`, `intervalMinutes = 15`, and a valid IANA timezone
- **THEN** `/v1` accepts the request
- **AND** subsequent schedule reads return the equivalent `minuteInterval`
  descriptor and human-readable summary

#### Scenario: OpenAPI documents sub-day variants
- **WHEN** a client requests `GET /v1/openapi.json`
- **THEN** schedule create, update, and response schemas include hourly and
  `minuteInterval` recurrence variants with their allowed fields and ranges
- **AND** the documented interval values are exactly 5, 10, 15, and 30

#### Scenario: Invalid interval does not mutate a schedule
- **WHEN** a scoped client creates or updates a schedule with a minute interval
  outside 5, 10, 15, and 30
- **THEN** `/v1` returns a validation error before calling schedule mutation
  behavior
- **AND** no schedule definition is created or changed

#### Scenario: Cron compatibility stays mutually exclusive
- **WHEN** an existing client submits only a valid cron expression and timezone
- **THEN** `/v1` continues to accept the compatibility request
- **AND** a request containing both cron and any recurrence variant is rejected
  before a schedule changes
