## MODIFIED Requirements

### Requirement: Schedule recurrence supports product presets
The system SHALL accept a user-facing recurrence descriptor for common recurring
task patterns. Supported descriptors SHALL include daily, weekdays, weekly, and
monthly recurrences at a local wall-clock time; hourly recurrence at a selected
`minuteOfHour` from 0 through 59; and clock-aligned `minuteInterval` recurrence
whose `intervalMinutes` is exactly 5, 10, 15, or 30. Every descriptor SHALL carry
a valid IANA timezone. The system SHALL validate descriptor fields before
persisting or updating a schedule, normalize supported descriptors into its
internal scheduler representation, and return an equivalent descriptor and
human-readable label on schedule reads.

#### Scenario: Weekday recurrence is accepted
- **WHEN** an account creates a schedule with a weekdays recurrence at `09:00`
  in `Asia/Shanghai`
- **THEN** the system accepts the recurrence
- **AND** it computes the next fire from that weekday wall-clock rule

#### Scenario: Hourly recurrence is accepted
- **WHEN** an account creates an hourly recurrence with `minuteOfHour = 15` in
  `Asia/Shanghai`
- **THEN** the system accepts and normalizes it to fire at minute `15` of each
  local hour
- **AND** a schedule read returns the hourly descriptor and a non-cron summary

#### Scenario: Supported minute interval is accepted
- **WHEN** an account creates a `minuteInterval` recurrence with
  `intervalMinutes = 15` in `Asia/Shanghai`
- **THEN** the system accepts and normalizes it to the local clock-aligned
  `:00`, `:15`, `:30`, and `:45` sequence
- **AND** a schedule read returns the `minuteInterval` descriptor and a non-cron
  summary

#### Scenario: Invalid recurrence is rejected
- **WHEN** an account creates or updates a schedule with an invalid local time,
  timezone, weekday, monthly day, hourly minute, or minute interval
- **THEN** the request is rejected before any schedule definition is changed

#### Scenario: Unsupported minute interval is rejected
- **WHEN** an account submits `intervalMinutes = 7`, `intervalMinutes = 60`, or
  another value outside 5, 10, 15, and 30
- **THEN** the recurrence is rejected rather than being approximated with cron
- **AND** no schedule definition is created or updated

#### Scenario: Cron compatibility remains available
- **WHEN** an existing API client creates or updates a schedule with a valid
  cron expression and timezone through a compatibility path
- **THEN** the system continues to accept that request
- **AND** schedule reads provide a non-cron recurrence summary for ordinary
  clients

## ADDED Requirements

### Requirement: Sub-day recurrences use nominal occurrence period identity
Hourly and `minuteInterval` recurrences SHALL identify each recurrence period by
the nominal UTC occurrence produced by the timezone-aware scheduler. They SHALL
NOT use local day, week, or month identity. Manual and automatic dispatch for the
same nominal occurrence SHALL resolve the same period, and a committed created,
skipped, or failed run SHALL consume only that occurrence.

#### Scenario: Multiple sub-day occurrences remain distinct
- **WHEN** a 15-minute schedule has four nominal occurrences within one local
  hour
- **THEN** each occurrence has a distinct period identity
- **AND** consuming one occurrence does not suppress the other three

#### Scenario: Manual and automatic dispatch converge on one sub-day occurrence
- **WHEN** manual dispatch consumes the next nominal occurrence while an
  automatic scheduler tick competes for that same occurrence
- **THEN** exactly one period run and at most one linked Task are committed
- **AND** `nextRunAt` advances beyond the consumed occurrence

#### Scenario: Early manual dispatch consumes only the next nominal occurrence
- **WHEN** a sub-day schedule is not overdue and the operator dispatches it early
- **THEN** the dispatch uses the next nominal occurrence as its period identity
- **AND** a repeated request for that occurrence observes the existing run rather
  than consuming a second occurrence

#### Scenario: DST rollback keeps repeated local times distinct
- **WHEN** a timezone transition produces two nominal sub-day occurrences with
  the same local wall-clock label
- **THEN** their distinct UTC occurrence times produce distinct period identities
- **AND** each can be consumed at most once
