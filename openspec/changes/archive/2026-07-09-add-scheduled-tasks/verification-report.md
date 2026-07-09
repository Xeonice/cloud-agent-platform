## Verification

Commands run on 2026-07-09:

- `pnpm --filter @cap/contracts build && node packages/contracts/src/schedule.test.mjs`
- `DATABASE_URL=postgresql://cap:cap@localhost:5432/cap pnpm --filter @cap/api exec prisma validate --schema prisma/schema.prisma`
- `pnpm --filter @cap/api typecheck`
- `pnpm --filter @cap/api build && node --test --test-force-exit apps/api/dist/scheduled-tasks/scheduled-tasks.service.spec.js apps/api/dist/tasks/tasks-schedule-provenance.spec.js apps/api/dist/v1/v1-schedules.controller.spec.js apps/api/dist/openapi/openapi.registry.spec.js`
- `pnpm --filter @cap/web typecheck`
- `pnpm --filter @cap/web test`
- `pnpm --filter @cap/web build`
- `openspec validate add-scheduled-tasks --strict`

## Rollout Notes

- The scheduler is API-process local and uses Postgres claim leases plus the
  `(scheduleId, scheduledFor)` uniqueness guard. Multi-process deployments
  should not need an external queue for this first iteration.
- `SCHEDULED_TASKS_DISABLED=1` can disable the poller while keeping schedule
  CRUD/read endpoints available.
- `DATABASE_URL` is required by Prisma validation/generation. The local
  validation command above used a non-secret dummy URL because this workspace
  `.env` did not define one.

## Manual Verification Gaps

- No live browser session was driven against a running backend in this pass.
  Console behavior is covered by static render tests, API seam tests, web
  typecheck, full Vitest, and production build.
