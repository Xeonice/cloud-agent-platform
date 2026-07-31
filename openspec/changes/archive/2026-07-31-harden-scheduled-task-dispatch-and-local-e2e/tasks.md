<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: occurrence-durability (depends: none)

- [x] 1.1 Refactor automatic and manual dispatch so schedule compare-and-set, `nextRunAt`, run ledger, and ordinary task creation commit atomically
- [x] 1.2 Record skipped and failed occurrence outcomes without allowing a committed schedule advance to exist without a durable run
- [x] 1.3 Preserve post-commit admission, per-run token-conditional recovery claims, durable winner-token CAS, terminal/provider fencing, and startup recovery for committed pending tasks
- [x] 1.4 Add focused service tests for success, skip, validation failure, conflict, admission failure, ambiguous commit, promotion/stop/terminal-CAS races, in-process deduplication, audit idempotency, and durable owner attribution

## 2. Track: postgres-integration (depends: occurrence-durability)

- [x] 2.1 Expand the real-Postgres scheduler suite with transaction rollback and durable-ledger assertions
- [x] 2.2 Add competing scheduler and duplicate-dispatch coverage proving exactly-once occurrence identity
- [x] 2.3 Add restart recovery coverage for committed pending scheduled tasks and startup due scanning
- [x] 2.4 Name and document the fast suite as the Postgres scheduler integration gate

## 3. Track: isolated-e2e-api (depends: occurrence-durability)

- [x] 3.1 Add a test-only AppModule bootstrap that overrides only `SANDBOX_PROVIDER` with a recording deterministic provider
- [x] 3.2 Add a loopback-only test control port for advancing a selected disposable schedule and reading provider evidence
- [x] 3.3 Add bounded, sanitized diagnostic endpoints or files for schedule, run, task, and audit evidence without exposing production routes

## 4. Track: browser-schedule-story (depends: isolated-e2e-api)

- [x] 4.1 Add a dedicated Playwright configuration with failure trace, screenshot, and video retention
- [x] 4.2 Verify owner password login and first-login rotation against the live API and console
- [x] 4.3 Verify manual dispatch records the actual trigger time, consumes the current period, and does not duplicate that period on retry
- [x] 4.4 Verify accelerated automatic polling creates exactly one run and task, invokes the provider port, records audit provenance, and links correctly in the console

## 5. Track: local-orchestration (depends: isolated-e2e-api, browser-schedule-story)

- [x] 5.1 Add a one-command runner that allocates dynamic loopback ports and owns a uniquely named disposable Postgres container
- [x] 5.2 Apply migrations and launch the E2E API and Vite web processes with an explicit isolated environment
- [x] 5.3 Implement scoped cleanup, `KEEP_E2E_STACK=1`, bounded readiness checks, and sanitized failure artifact collection
- [x] 5.4 Expose clear package scripts for the fast Postgres integration gate and the full local browser E2E
- [x] 5.5 Add a CI job for the isolated browser story without replacing provider-specific execution suites

## 6. Track: verification (depends: postgres-integration, local-orchestration)

- [x] 6.1 Run focused unit tests and the real-Postgres scheduler integration suite
- [x] 6.2 Run the one-command browser E2E from a clean isolated invocation and inspect retained evidence
- [x] 6.3 Run lint and type checks for touched workspaces and confirm no production test endpoint or fixed local resource was introduced
- [x] 6.4 Strictly validate the completed OpenSpec change and review the final worktree without committing or pushing

## 7. Track: schedule-result-visibility (depends: occurrence-durability, browser-schedule-story)

- [x] 7.1 Extend schedule latest-run and run-list responses with the actual dispatch creation time and nullable linked Task lifecycle status without changing occurrence status semantics
- [x] 7.2 Update the console to show actual dispatch time separately from the next scheduled cycle and synchronously apply the dispatch response to its schedule cache
- [x] 7.3 Show dispatch outcome and linked Task outcome independently, including failed and failed-to-start tasks, while preserving the ordinary task link
- [x] 7.4 Add contract, service, Web, and browser regression coverage for immediate time feedback, cadence preservation/advance, and post-dispatch Task failure visibility

## 8. Track: recurrence-period-consumption (depends: schedule-result-visibility)

- [x] 8.1 Persist a timezone-aware period key, trigger source, and actual trigger time with a database uniqueness boundary for new schedule runs
- [x] 8.2 Make manual and automatic dispatch converge on one period ledger and advance `nextRunAt` without allowing retries to consume the following period
- [x] 8.3 Expose the authoritative current-period run consistently through Console REST, public `/v1`, MCP, and the API debugger contract
- [x] 8.4 Show current-period handled state independently from linked Task lifecycle state and disable duplicate same-period dispatch in the console
- [x] 8.5 Cover early manual dispatch, sequential and concurrent retry, automatic competition, skip/failure consumption, timezone boundaries, and Task failure in unit, Postgres, and browser suites
- [x] 8.6 Re-run the isolated verification matrix and strict OpenSpec validation without committing or pushing
