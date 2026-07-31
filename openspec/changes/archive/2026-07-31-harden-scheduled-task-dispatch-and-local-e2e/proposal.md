## Why

The current scheduled-task test proves Postgres polling with a fake task-admission
port, but it cannot catch failures across the real owner-authenticated HTTP,
TasksService, Guardrails, and console path. The dispatcher also has a crash window
where `nextRunAt` is advanced before any run ledger exists, so an occurrence can
be lost permanently while the current suite stays green.

## What Changes

- Make schedule occurrence claim, `nextRunAt` advancement, run-ledger creation,
  and ordinary task creation one durable database boundary for both automatic and
  manual dispatch.
- Give each newly dispatched recurrence period a stable timezone-aware identity,
  record manual/automatic trigger source and actual trigger time, and make
  immediate dispatch consume the current period rather than create an unrelated
  ad-hoc run.
- Preserve post-commit admission, persist canonical task ownership, make creation
  audit retries idempotent, fence ambiguous lifecycle commits with durable winner
  tokens, and recover each pending scheduled occurrence through its own admission
  lease.
- Reclassify the existing real-Postgres timer test as a fast integration gate and
  expand it with transaction rollback, competing scheduler, and recovery cases.
- Add an isolated, one-command local E2E runner that provisions disposable state,
  boots the real API and web console, authenticates a real account owner, and runs
  scheduled-task browser/API assertions without touching an existing dev stack.
- Add accelerated due-time control scoped to the disposable test database, plus
  an optional real-wall-clock verification mode; no production test endpoint or
  second-resolution cron behavior is introduced.
- Capture actionable failure artifacts and wire stable gates into CI, while
  keeping provider-specific deep execution as a separate optional/nightly mode.

## Capabilities

### New Capabilities

- `scheduled-task-e2e-verification`: One-command isolated local verification,
  browser/API evidence, deterministic time control, cleanup, and failure artifacts
  for the complete scheduled-task control-plane story.

### Modified Capabilities

- `scheduled-tasks`: Strengthen occurrence durability so a process failure cannot
  lose a claimed automatic or manual occurrence before its run ledger and task are
  committed, and expose authoritative current-period consumption separately from
  Task lifecycle state.

## Impact

- Scheduled-task transaction and recovery logic in `apps/api/src/scheduled-tasks`.
- Post-commit admission idempotency and durable owner attribution in
  `TasksService` and `GuardrailsService`, including per-run recovery leases and a
  tokened task-status compare-and-set plus terminal fences around provider work.
- Additive Prisma migrations for task ownership, audit deduplication, task/run
  admission claims, and nullable schedule-period identity/trigger metadata, with
  legacy-history backfills only where they are reliable.
- Prisma-backed integration coverage and the existing schedule E2E naming/scope.
- New local orchestration and Playwright configuration under `scripts/` and
  `apps/web/e2e/`.
- Root/package test commands and CI jobs for fast integration versus full local
  browser verification.
- No public response-shape breaking change and no production-only testing surface;
  current-period fields and the dispatch retry key are additive.
  Deleting a schedule with a committed pending admission returns the existing
  conflict response until recovery settles it, rather than orphaning its ledger.
