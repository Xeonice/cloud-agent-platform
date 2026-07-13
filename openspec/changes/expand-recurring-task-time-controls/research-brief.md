## Research Brief

### Current State

- The console creates and edits recurring work from both `NewTaskDialog` and the
  full-page `/tasks/new` route. The two surfaces share payload builders but render
  separate copies of the recurrence controls.
- Both surfaces render timezone as a free-text input. New schedule state and the
  empty-value fallback are hard-coded to `UTC`; neither surface reads the
  browser's resolved local IANA timezone.
- The product recurrence contract supports only `daily`, `weekdays`, `weekly`,
  and `monthly`. The server normalizes those descriptors to five-field cron and
  derives user-facing recurrence descriptors from canonical cron expressions.
- Five-field cron already supports minute resolution. Hourly (`M * * * *`) and
  minute-step (`*/N * * * *`) schedules execute through the existing scheduler,
  but they read back as opaque `custom` recurrences and therefore cannot be
  created or edited as product presets.
- `TaskSchedule` persists cron and timezone strings, while schedule runs persist
  nominal fire times and stable period keys. No stored recurrence-kind column is
  required for additional cron-normalized presets.
- The completed-but-unarchived `harden-scheduled-task-dispatch-and-local-e2e`
  change makes manual and automatic dispatch consume one durable recurrence
  period. Calendar presets use local day/week/month keys; custom cron uses the
  nominal UTC occurrence.
- The scheduler polls every 60 seconds by default and scans at most ten due
  schedules per tick. Minute-level recurrence is supported, but it is not a
  second-level or exact-start SLA.

### Product Decisions

- Replace timezone free text with one shared IANA timezone Select used by both
  recurring-task creation surfaces.
- For a new schedule, resolve the browser timezone with
  `Intl.DateTimeFormat().resolvedOptions().timeZone` after client mount. Fall back
  to `UTC` when detection is unavailable or invalid. Never overwrite an edited
  schedule's persisted timezone or a selection the operator has already changed.
- Build timezone options from browser-supported IANA identifiers when available,
  while always including `UTC`, the detected local timezone, and an existing
  schedule's persisted timezone.
- Add `hourly` recurrence with a `minuteOfHour` value from 0 through 59.
- Add `minuteInterval` recurrence with `intervalMinutes` restricted to the
  clock-aligned product presets `5`, `10`, `15`, and `30`.
- Normalize the new descriptors on the server to canonical five-field cron and
  recognize those canonical cron expressions on reads so create, update, and
  response DTOs round-trip without exposing cron.
- Treat hourly and minute interval periods as nominal UTC occurrences, not local
  calendar periods. Early manual dispatch consumes the same upcoming or overdue
  nominal occurrence that automatic dispatch would consume.
- Reuse the existing `cron:<ISO timestamp>` period identity and database
  uniqueness boundary; no Prisma migration is expected.
- Extract shared recurrence fields rather than adding another copy of timezone
  option, conditional-field, and validation behavior to both task forms.

### Existing Specs Affected

- `frontend-console`: recurring-task forms need a timezone Select, browser-local
  default behavior, edit preservation, and hourly/minute interval choices.
- `scheduled-tasks`: the supported recurrence descriptor set, validation,
  normalization, summaries, and sub-day period semantics need to expand.
- `public-v1-api`: create/update/read and generated OpenAPI schemas need to
  round-trip the new recurrence variants while preserving cron compatibility.
- `mcp-server` already requires schedule tools to reuse the shared schedule
  contracts and services. Its tool schema will inherit the new recurrence union;
  this is an implementation/test impact rather than a new MCP requirement.

### Non-Goals

- Arbitrary elapsed intervals, creation-time anchors, intervals longer than one
  hour, natural-language schedules, or second-level recurrence.
- Changing the scheduler poll cadence, due batch size, overlap policy, or
  `fire-once` misfire behavior.
- Removing the existing cron compatibility path or exposing cron in the console.
- Changing `TaskSchedule` persistence or introducing a schedule task status.

### Verification Implications

- Contract tests must cover descriptor validation, canonical cron conversion,
  reverse mapping, response labels, timezone/DST boundaries, and occurrence-level
  period identity.
- API and MCP tests must prove create/update/read round-trips and reject unsupported
  interval values without mutating a schedule.
- Web tests must cover SSR-safe local-timezone initialization, UTC fallback, edit
  preservation, both form surfaces, and shared conditional recurrence controls.
- The isolated scheduled-task Playwright story should create at least one
  sub-day schedule through the real console and prove manual/automatic dispatch
  converge on one nominal occurrence.
