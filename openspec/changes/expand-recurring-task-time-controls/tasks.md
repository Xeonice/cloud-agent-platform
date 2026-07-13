<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: schedule-contracts (depends: none)

- [x] 1.1 Extend the shared request and response recurrence schemas with `hourly` plus validated `minuteOfHour`, and `minuteInterval` plus the exported 5/10/15/30 `intervalMinutes` allow-list
- [x] 1.2 Normalize the new descriptors to canonical five-field cron and reverse-map canonical hourly and supported minute-step cron into equivalent descriptors and human-readable labels without changing unsupported custom cron behavior
- [x] 1.3 Refactor recurrence period classification so only daily, weekdays, weekly, and monthly use calendar identities while hourly, `minuteInterval`, and custom cron use the nominal UTC occurrence key
- [x] 1.4 Expand contract tests for valid and invalid descriptor shapes, create/update transforms, canonical round-trips, existing-cron compatibility, multiple same-day occurrence keys, and DST gaps/folds, replacing stale `*/5`-is-custom fixtures with truly unsupported cron
- [x] 1.5 Update the shared public operation manifest descriptions and tests so recurrence-first API and derived MCP documentation name the hourly and `minuteInterval` variants

## 2. Track: scheduler-api (depends: schedule-contracts)

- [x] 2.1 Add scheduled-task service coverage proving hourly and `minuteInterval` create, update, list, and get responses round-trip while unsupported interval input leaves definitions unchanged
- [x] 2.2 Cover early and overdue manual dispatch, repeated manual requests, automatic/manual competition, overlap outcomes, fire-once advancement, and distinct sub-day occurrence keys across DST boundaries
- [x] 2.3 Update Console and `/v1` controller plus generated OpenAPI JSON tests so create, update, and response schemas expose both sub-day variants, their numeric constraints, and recurrence-versus-cron exclusivity
- [x] 2.4 Extend the real-Postgres scheduler integration gate with canonical sub-day schedules that prove occurrence uniqueness, next-run advancement, and no calendar-period collapse

## 3. Track: mcp-contract-parity (depends: schedule-contracts)

- [x] 3.1 Update and verify MCP schedule tool descriptions, input schemas, and output schemas inherit hourly and `minuteInterval` variants from the shared contracts without a parallel recurrence definition
- [x] 3.2 Add MCP tool tests for sub-day create/update/read delegation, structured response round-trips, invalid interval rejection, and unchanged cron compatibility

## 4. Track: shared-web-controls (depends: schedule-contracts)

- [x] 4.1 Add a client-safe timezone helper that resolves the browser IANA timezone after hydration, falls back to `UTC`, uses `Intl.supportedValuesOf` when available, and otherwise builds a deduplicated option set from UTC, detected, current, and persisted values, with focused unit tests
- [x] 4.2 Extend shared schedule form state, empty/edit hydration, payload builders, and exhaustive recurrence conversion for `minuteOfHour` and `intervalMinutes`, including UTC fallback and custom-schedule preservation tests
- [x] 4.3 Create one shared recurrence-fields component with the IANA timezone Select and conditional calendar-time, hourly-minute, fixed-interval, weekday, month-day, and overlap controls, plus component behavior and accessibility tests

## 5. Track: web-surface-adoption (depends: shared-web-controls)

- [x] 5.1 Replace the duplicated recurrence fields in `NewTaskDialog` with the shared component and apply browser timezone only to new untouched forms while preserving edit values and user changes
- [x] 5.2 Replace the duplicated recurrence fields in `/tasks/new` with the same component and the same SSR-safe create/edit timezone lifecycle
- [x] 5.3 Add web tests for both surfaces covering local-timezone default, invalid-detection fallback, persisted-timezone edit, hourly and fixed-interval submission, conditional fields, and identical option sets
- [x] 5.4 Extend schedule API fixtures, API Playground create/update samples, response parsing, list labels, and edit round-trip tests for canonical hourly and `minuteInterval` schedules without client-side cron interpretation

## 6. Track: isolated-browser-story (depends: scheduler-api, web-surface-adoption)

- [x] 6.1 Extend the isolated scheduled-task E2E fixture and deterministic time controls to create and advance canonical sub-day schedules without adding a production test endpoint
- [x] 6.2 Add Playwright coverage that uses the configured browser timezone to create hourly and `minuteInterval` schedules through the real recurring-task form and verifies the selected timezone, human summary, and edit values
- [x] 6.3 Prove accelerated manual and automatic dispatch converge on one nominal sub-day occurrence while later occurrences remain independently dispatchable, retaining sanitized failure artifacts

## 7. Track: verification (depends: scheduler-api, mcp-contract-parity, web-surface-adoption, isolated-browser-story)

- [x] 7.1 Run focused contract, scheduled-task service/controller, real-Postgres, MCP, and web test suites for the changed modules
- [x] 7.2 Run type checks and lint for contracts, API, and web workspaces and confirm exhaustive recurrence switches contain no unsafe fallback
- [x] 7.3 Run the one-command isolated scheduled-task browser E2E and inspect timezone, run-ledger, task, and period-key evidence
- [x] 7.4 Strictly validate the completed OpenSpec change, confirm no Prisma migration or new runtime dependency was introduced, and document that the completed hardening change must be archived first
