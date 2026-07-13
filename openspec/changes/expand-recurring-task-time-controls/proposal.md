## Why

Recurring-task creation currently defaults to `UTC` through a free-text timezone
field and exposes no product recurrence finer than daily. Operators need a safe
local-timezone default and understandable hourly or minute-level choices without
falling back to opaque cron schedules that cannot round-trip through the console.

## What Changes

- Replace the recurring-task timezone text fields with a shared IANA timezone
  Select in both task creation surfaces; new schedules default to the browser's
  resolved local timezone with an explicit `UTC` fallback, while edits preserve
  the stored timezone.
- Extend user-facing recurrence descriptors with hourly schedules at a selected
  minute of the hour and clock-aligned 5, 10, 15, or 30 minute intervals.
- Normalize the new descriptors to the existing cron/timezone storage model on
  the server and return the same descriptors and human summaries on reads.
- Preserve cron compatibility while keeping cron hidden from ordinary console
  users and rejecting unsupported interval values before a schedule changes.
- Give sub-day presets nominal-occurrence period identity so manual and automatic
  dispatch retain the existing exactly-once period behavior across timezone and
  DST boundaries.
- Add contract, API, MCP, web, and isolated browser coverage for timezone defaults,
  recurrence round-trips, schedule editing, and sub-day dispatch behavior.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `frontend-console`: Use a browser-local IANA timezone Select and expose hourly
  and fixed minute interval controls consistently in both recurring-task forms.
- `scheduled-tasks`: Accept, normalize, summarize, and dispatch hourly and fixed
  minute interval recurrence descriptors with occurrence-level period identity.
- `public-v1-api`: Round-trip the new recurrence variants through shared request,
  response, and generated OpenAPI schemas without breaking cron compatibility.

## Impact

- Shared schedule schemas and timing/period helpers in `packages/contracts`.
- Schedule create/update/read and dispatch behavior in
  `apps/api/src/scheduled-tasks`, plus OpenAPI and MCP schemas that reuse the
  shared contracts.
- Shared recurring-task form state and controls used by
  `NewTaskDialog` and `/tasks/new`, including timezone option discovery.
- Contract, service, controller, API, MCP, web, and Playwright schedule tests.
- No expected Prisma migration, new runtime dependency, breaking API field, or
  rewrite of existing persisted cron values.
