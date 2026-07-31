## Context

CAP already stores recurring definitions separately from ordinary tasks and
normalizes product recurrence descriptors into cron plus an IANA timezone. The
current descriptor union stops at daily recurrence, while five-field cron and the
scheduler already operate at minute resolution. Hourly and stepped-minute cron
therefore execute, but read back as `custom` and cannot round-trip through the
product forms.

The two recurring-task creation surfaces share payload helpers but duplicate the
rendered recurrence controls. Both use a free-text timezone field seeded with a
module-level `UTC` constant. Because the web app server-renders these routes, the
browser timezone cannot safely be read during the server render or the first
hydration render.

The completed `harden-scheduled-task-dispatch-and-local-e2e` implementation also
means every manual or automatic dispatch consumes one stable recurrence period.
Daily, weekday, weekly, and monthly presets use local calendar identities, while
other cron schedules use their nominal UTC occurrence. New sub-day product kinds
must preserve that latter occurrence identity rather than accidentally becoming
calendar periods.

```
shared recurrence controls
          |
          v
ScheduleRecurrence request/response union
          |
          v
server normalization <-> canonical cron recognition
          |
          v
existing TaskSchedule cron/timezone + occurrence ledger
```

## Goals / Non-Goals

**Goals:**

- Give new recurring tasks an SSR-safe browser-local timezone default and a
  constrained IANA timezone Select on both creation surfaces.
- Add product descriptors for hourly schedules and clock-aligned 5, 10, 15, or
  30 minute intervals.
- Keep conversion, validation, response labels, and reverse mapping in the shared
  contract layer so Console, REST, OpenAPI, and MCP stay aligned.
- Preserve exactly-once period consumption for manual and automatic sub-day
  dispatch without changing persistence.
- Preserve existing calendar recurrence and cron compatibility behavior.

**Non-Goals:**

- Arbitrary elapsed intervals, creation-time anchors, intervals longer than one
  hour, second-level schedules, or natural-language recurrence.
- A strict start-time SLA or changes to scheduler polling, due-batch,
  `fire-once`, or overlap behavior.
- Removing cron request fields, exposing cron in the console, or converting cron
  in individual clients.
- Adding recurrence columns or new period-key formats to Prisma.

## Decisions

### 1. Extend the shared recurrence union with two explicit sub-day kinds

The request and response unions will add:

```ts
{ kind: "hourly"; minuteOfHour: number; timezone: string }
{ kind: "minuteInterval"; intervalMinutes: 5 | 10 | 15 | 30; timezone: string }
```

The common schema will be split into a timezone base and a calendar-time base so
sub-day variants are not forced to carry the existing `HH:mm` field. Hourly
validation accepts `minuteOfHour` from 0 through 59. Minute intervals use one
exported allow-list shared by schema validation, conversion, UI options, and
tests.

Server-side normalization maps hourly to `M * * * *` and minute intervals to
`*/N * * * *`. Reverse mapping recognizes those canonical shapes before the
existing daily/weekday/weekly/monthly checks and returns the same descriptor with
labels such as `每小时第 15 分钟` and `每 15 分钟`. Equivalent non-canonical cron
expressions may remain `custom`; recurrence requests created by product clients
must round-trip.

Alternative considered: have the web client submit raw cron for the new options.
Rejected because reads would remain opaque `custom`, editing would lose the
selected intent, and REST/MCP clients would drift from the console.

### 2. Minute intervals are clock-aligned fixed presets

The supported minute values are exactly 5, 10, 15, and 30. They divide an hour,
so cron step syntax represents a stable wall-clock sequence in the selected
timezone. An interval is aligned to local clock boundaries, not to schedule
creation or the preceding task's completion.

Hourly recurrence runs at the selected minute of each local hour and defaults to
minute 0 in new form state. The existing timezone-aware cron parser remains the
source of `nextRunAt`, including daylight-saving transitions.

Alternative considered: accept any positive minute count. Rejected because
`*/N` resets at the next hour when N does not divide 60, while a true elapsed
interval would need persisted anchor semantics and a scheduler representation
beyond this change.

### 3. Sub-day product kinds retain nominal-occurrence period identity

Period classification will become explicit rather than treating every response
kind except `custom` as a calendar recurrence. Daily and weekday remain local-day
periods, weekly remains a local-week period, and monthly remains a local-month
period. Hourly, minute interval, and custom cron use the existing
`cron:<nominal UTC ISO timestamp>` identity.

When a sub-day schedule is not overdue, immediate dispatch consumes its next
nominal occurrence; when `nextRunAt` is overdue, it consumes that persisted
occurrence. Automatic dispatch and concurrent/repeated manual requests resolve
the same key, and advancement skips the consumed occurrence. UTC occurrence
identity keeps two repeated local times during a DST rollback distinct.

Alternative considered: add local `hour:` and `minute:` period keys. Rejected
because local DST folds make them ambiguous and the existing occurrence key and
database uniqueness boundary already express the required identity.

### 4. Detect browser timezone only after hydration and only for untouched creates

A shared client helper will resolve the browser timezone with
`Intl.DateTimeFormat().resolvedOptions().timeZone`, validate it as IANA, and fall
back to `UTC`. The server render and first client render keep a deterministic
fallback; an effect applies the detected value only when the form is creating a
new schedule and the timezone has not been changed by the operator. Opening an
edit form always uses the persisted schedule timezone.

Timezone options will use `Intl.supportedValuesOf("timeZone")` when available.
When enumeration is unavailable, the Select degrades to the valid identifiers
already known to the form instead of maintaining a stale client-side IANA table.
The option set always includes `UTC`, the detected timezone, and the current
persisted value, then deduplicates and sorts identifiers. The API continues
validating the submitted IANA string; the browser is responsible for explicitly
sending its selected default.

Alternative considered: compute the default on the server. Rejected because the
API server's timezone is not the operator's computer timezone. Reading browser
globals during render was also rejected because it creates SSR hydration drift.

### 5. Render one shared recurrence-fields component

`NewTaskDialog` and `/tasks/new` will use one recurrence-fields component and the
same form-state helpers. It will render:

- calendar time for daily, weekdays, weekly, and monthly;
- `minuteOfHour` for hourly;
- the fixed `intervalMinutes` Select for `minuteInterval`;
- the shared timezone Select for all editable product recurrences;
- existing weekday, day-of-month, and overlap controls where applicable.

The schedule list continues rendering the server-provided recurrence label and
therefore needs no client-side cron interpretation. Existing custom schedules
retain their persisted cron/timezone behavior rather than being silently
rewritten.

Alternative considered: update both form copies independently. Rejected because
their custom labels and disabled-state behavior have already drifted and the new
timezone lifecycle would double that risk.

### 6. Shared schemas drive every public surface

Console REST, `/v1`, generated OpenAPI, and MCP schedule tools will continue
using the same Zod recurrence schemas. Create and update accept either recurrence
or the existing cron compatibility shape, never both. Reads return the new
descriptor for canonical hourly/minute schedules; unsupported cron remains a
non-secret custom summary.

No database migration is needed because normalized cron and timezone remain the
stored definition. Existing schedules continue to fire unchanged, while an
existing canonical hourly or supported-step cron schedule becomes more useful by
reading back as a product descriptor.

## Risks / Trade-offs

- [Operators expect arbitrary "every N minutes"] -> Present only the four exact
  presets and describe them as clock-aligned; leave anchor-based intervals to a
  separate change.
- [Browser and server IANA catalogs differ] -> Include local/current/UTC options,
  keep server-side validation authoritative, and surface validation failure
  without mutating the schedule.
- [Client timezone detection overwrites an edit or a fast user selection] -> Gate
  the post-hydration update on create mode plus an untouched/dirty marker.
- [A recognized sub-day kind falls into calendar period logic] -> Replace the
  broad `Exclude<..., "custom">` assumption with explicit calendar versus
  occurrence classification and test multiple fires in one local day.
- [High-frequency schedules create workload or run-ledger volume] -> Keep the
  five-minute product minimum and existing skip/enqueue plus fire-once policies;
  document that the 60-second polling loop is not a precise SLA.
- [Cron reverse mapping changes existing response presentation] -> Recognize only
  canonical hourly and supported step expressions, never rewrite stored cron,
  intentionally reclassify those canonical values additively, and prove every
  unsupported expression remains `custom`.
- [The hardening delta is complete but not archived] -> Add a separate sub-day
  requirement instead of modifying its period requirement; archive hardening
  before this change so canonical period semantics are applied in order.

## Migration Plan

1. Extend and test shared recurrence schemas, normalization, reverse mapping,
   labels, and explicit period classification.
2. Exercise create/update/read, OpenAPI, MCP, and durable dispatch behavior with
   the new variants; no data migration or backfill is required.
3. Introduce shared timezone discovery/options and recurrence fields, then adopt
   them in both recurring-task forms.
4. Run focused contract/API/web tests and the isolated scheduled-task browser
   story, including DST and manual/automatic competition.
5. Archive the completed hardening change before archiving this change so its
   period baseline lands first.

Rollback can restore the prior UI and contract recognition without rewriting
stored rows. Canonical hourly/minute cron schedules will continue firing and will
simply read back as `custom` on an older version.

## Open Questions

- None. This change fixes the initial product set, clock alignment, timezone
  default, and occurrence identity so implementation can proceed without another
  scheduling-model decision.
