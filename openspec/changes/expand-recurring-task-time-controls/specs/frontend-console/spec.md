## MODIFIED Requirements

### Requirement: Task creation surfaces support recurring mode
The task creation dialog and the full-page advanced task creation route SHALL
let operators choose whether the submitted task runs once or repeatedly. The
repeated mode SHALL reuse the same task-template controls as immediate task
creation and SHALL add shared recurrence controls that do not require cron
syntax. Supported human choices SHALL include daily, weekdays, weekly, monthly,
hourly at a selected minute of the hour, and clock-aligned 5, 10, 15, or 30
minute intervals.

#### Scenario: Recurrence controls use human choices
- **WHEN** the operator configures repeated execution
- **THEN** the console offers daily, weekdays, weekly, monthly, hourly, and
  fixed minute interval choices without exposing cron syntax
- **AND** it submits recurrence fields rather than a user-entered cron string

#### Scenario: Hourly recurrence selects the minute of the hour
- **WHEN** the operator selects hourly recurrence and chooses minute `15`
- **THEN** both task creation surfaces describe the schedule as running each hour
  at minute `15`
- **AND** the submitted recurrence includes `kind = hourly`, `minuteOfHour = 15`,
  and the selected timezone

#### Scenario: Minute interval uses supported clock-aligned presets
- **WHEN** the operator selects `minuteInterval` recurrence
- **THEN** the interval Select offers exactly 5, 10, 15, and 30 minutes
- **AND** selecting 15 submits `kind = minuteInterval`, `intervalMinutes = 15`,
  and the selected timezone

#### Scenario: Existing task template controls are shared
- **WHEN** the operator switches between run-once and run-repeatedly modes
- **THEN** repo, prompt, runtime, sandbox environment, delivery, skills, idle
  timeout, and deadline selections remain in one shared task-template form
- **AND** the selected mode only changes the submit target and recurrence
  controls

## ADDED Requirements

### Requirement: Recurring task timezone selection uses the browser-local IANA timezone
Both recurring-task creation surfaces SHALL use one shared IANA timezone Select
rather than a free-text timezone field. For a new schedule whose timezone has not
been changed by the operator, the console SHALL select the valid IANA timezone
reported by the browser after hydration. It SHALL fall back to `UTC` when the
browser value is unavailable or invalid. Editing an existing schedule SHALL
preserve its persisted timezone regardless of the current browser timezone.

#### Scenario: New schedule defaults to the browser timezone
- **WHEN** the hydrated browser reports `Asia/Shanghai` for a new recurring task
  and the operator has not changed the timezone
- **THEN** the timezone Select chooses `Asia/Shanghai`
- **AND** the submitted recurrence explicitly includes `Asia/Shanghai`

#### Scenario: Invalid browser timezone falls back to UTC
- **WHEN** the browser cannot report a valid IANA timezone for a new recurring
  task
- **THEN** the timezone Select chooses `UTC`
- **AND** the console submits `UTC` rather than an empty or arbitrary string

#### Scenario: Editing preserves the persisted timezone
- **WHEN** an operator edits a schedule stored with `Europe/London` from a browser
  whose local timezone is `Asia/Shanghai`
- **THEN** the timezone Select remains `Europe/London`
- **AND** hydration does not overwrite the persisted value

#### Scenario: Browser timezone detection is SSR-safe
- **WHEN** a recurring-task creation surface is server-rendered and hydrated
- **THEN** the server render and first client render use deterministic timezone
  state without a hydration mismatch
- **AND** client detection updates only a new, untouched timezone selection

#### Scenario: Existing timezone remains selectable
- **WHEN** the timezone option catalog does not otherwise contain the browser's
  resolved timezone or an edited schedule's persisted timezone
- **THEN** the Select includes that valid IANA identifier together with `UTC`
- **AND** it does not require free-text entry
