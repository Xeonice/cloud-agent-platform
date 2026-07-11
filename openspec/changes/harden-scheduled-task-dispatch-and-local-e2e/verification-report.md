# Verification Report

Date: 2026-07-11 (Asia/Shanghai)

## Result

PASS. The repository now has a repeatable local control-plane E2E for scheduled
tasks, and the final implementation passed unit, real-Postgres, accelerated
browser, and real-wall-clock verification. No production time-control endpoint,
fixed development port, existing database, or operator credential is used.

## Correctness Evidence

- Occurrence claim/advance, run ledger, and ordinary Task creation commit in one
  Prisma transaction. Guarded failure and skip outcomes cannot leave an advanced
  schedule without a durable run.
- Scheduled post-commit recovery is leased per `TaskScheduleRun`, so one pending
  admission does not hold the schedule cadence or sibling runs.
- Task ownership is persisted on Task and backfilled from canonical creation
  audit or run-to-schedule history. `task.created` recovery is deduplicated by a
  unique key.
- Queued/running admission CAS winners are persisted as separate tokens. An
  ambiguous database acknowledgement is reconciled with the same token while the
  local reservation remains held.
- Queued promotion waits for the original queued CAS. Terminal writes synchronously
  fence provider admission; provider and gateway calls recheck the fence, and a
  provider result that returns after stop is torn down.
- The terminal database CAS is the stop linearization point. All lifecycle writes
  are status-qualified, so completion, cancellation, and start-failure races have
  one winner and cannot overwrite an already terminal state.
- Schedule responses now expose `latestRun.createdAt` and the linked Task's
  nullable `taskStatus` without conflating it with the occurrence dispatch status.
  The console shows actual dispatch time, next scheduled time, dispatch outcome,
  and Task outcome as separate facts.
- New runs persist a timezone-aware `periodKey`, `triggerSource`, and
  `triggeredAt`. The API exposes the authoritative current-period run, Console
  disables another same-period execution, and an optional `expectedPeriodKey`
  binds Console, public `/v1`, and MCP retries to the observed period.
- Current-period reads query the period ledger instead of assuming the most
  recently created run is current. Built-in calendar schedules also recognize a
  matching legacy null-key run, so an upgrade does not reopen today's period.
  List responses batch keyed and legacy lookups into at most two additional
  queries instead of issuing queries for every schedule on each Console poll.
- Built-in day/week/month periods remain consumed after `created`, `skipped`, or
  `failed`; a linked Task failure is shown separately and does not reopen the
  period. Custom cron uses its nominal occurrence identity.
- Manual execution advances a same-period or earlier overdue `nextRunAt` beyond
  the consumed current period. Pause/resume and timing updates skip a period that
  is already recorded, and a consumed DST fall-back period keeps the nominal
  occurrence that actually ran.
- Resume and timing updates guard their scan/write interval with schedule
  `updatedAt` plus `nextRunAt` CAS; a concurrent period commit forces a bounded
  reread and recomputation instead of restoring a consumed day/week/month.
- The debugger dispatch example sends `{}` instead of a fabricated date key;
  OpenAPI marks that compatible body as optional, matching Console REST, public
  `/v1`, and MCP behavior.
- Independent adversarial reviews found and drove regression coverage for
  overdue pointer replay, non-latest current runs, legacy rows, DST fall-back,
  period-boundary 409 refresh, and concurrent Console clicks.
- The final third-round read-only reviews found no remaining P0, P1, or P2
  issue after the CAS and batch-projection fixes.

## Executed Gates

| Gate | Result |
| --- | --- |
| `pnpm --filter @cap/api test` | PASS: 584 compiled tests, 24 sandbox source tests, 20 terminal source tests; zero failures |
| `pnpm --filter @cap/web test` | PASS: 46 files, 331 tests |
| API/Web lint and typecheck | PASS |
| Fresh Postgres migration + `pnpm test:integration:schedules` | PASS: all 33 migrations and 6 real-Postgres scenarios, including overdue-pointer repair, legacy-period compatibility, manual retry, and manual/poller competition |
| Runner/sanitizer contracts | PASS: 10 tests, including control evidence, recursive trace-ZIP sanitization, and production-graph isolation |
| `pnpm test:e2e:schedules:local` | PASS: one owner-authenticated accelerated Playwright story in 8.9 seconds |
| `SCHEDULE_E2E_WALL_CLOCK=1 SCHEDULE_E2E_SKIP_BUILD=1 pnpm test:e2e:schedules:local` | PASS: one real-minute-boundary story in 13.8 seconds |
| Prisma validation, `git diff --check`, strict OpenSpec validation | PASS |

The browser story booted the real AppModule and Vite console, performed password
login and first-login rotation, created separate manual and automatic schedules,
consumed the manual schedule's current period, verified its actual trigger time,
advanced next period, verified the new next-run value in the rendered Console,
disabled duplicate execution, and retried without creating another run or Task.
It then waited for the real poller on the automatic schedule
and proved exactly one run/task plus owner audit, schedule provenance, provider
invocation, visible current-period and Task-failure state, advanced next-cycle
time, and matching console task link.

## Isolation And Evidence

- Each live run used a uniquely named Postgres container and Docker/OS-assigned
  loopback ports. After both successful runs, the container, API/control/web
  listeners, and invocation-owned artifact directory were absent.
- Invocation-owned artifact removal uses a bounded retry for the short macOS
  Node compile-cache close race; runner/sanitizer contracts and a live cleanup
  rerun both passed after this path was exercised.
- A retained-stack probe verified that `KEEP_E2E_STACK=1` leaves real reparented
  Node processes and a healthy Postgres container reachable after the runner
  exits, while visible log paths remain immutable sanitized snapshots. The probe
  then removed all retained resources.
- The retained wall-clock success artifact was sanitized a second time. Fixed
  throwaway credentials had zero matches, request cookies and response cookies
  were `[REDACTED]`, and the successful Playwright run produced no trace/video.
  The ownership marker was checked before deleting the retained directory.
- The executable-source scan found no `debugger` statement, and the production
  AppModule/control-route scan found no test control surface.
  Accelerated time control exists only below `apps/api/test`.

## Boundaries

- Provider side effects are not claimed to be transactionally exactly-once across
  an arbitrary process crash after the provider accepts work; provider task-id
  idempotency and existing re-adoption remain the runtime boundary.
- The supported compose topology replaces one API container. An unsupported
  multi-replica deployment must drain old API workers before this migration; the
  change is not a mixed-version rolling-deploy protocol.
- A legacy custom-cron manual run did not persist its nominal occurrence and
  cannot be mapped reliably after upgrade. Built-in day/week/month legacy runs
  are recognized; every new custom run persists its exact occurrence key.
- Provider-specific execution remains in the existing AIO/BoxLite suites. This
  required E2E deliberately uses a deterministic outer provider and no model
  credential or external model request.

No commit or push was performed.
