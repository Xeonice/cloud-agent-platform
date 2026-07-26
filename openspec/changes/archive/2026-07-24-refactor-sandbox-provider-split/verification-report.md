## Verification Report

Change: `refactor-sandbox-provider-split`
Date: 2026-06-25

## OpenSpec

- `openspec validate refactor-sandbox-provider-split --strict --no-interactive`
  - Result: PASS
  - Output: `Change 'refactor-sandbox-provider-split' is valid`

## Static / Unit / Coverage

- `pnpm --filter @cap/api lint`
  - Result: PASS
- `pnpm exec turbo run lint --filter=@cap/sandbox-core --filter=@cap/sandbox-lifecycle --filter=@cap/sandbox-aio-local --filter=@cap/sandbox-cloud-http --filter=@cap/sandbox-conformance --filter=@cap/sandbox-provider-aio --filter=@cap/sandbox-scheduler --filter=@cap/sandbox-workspace-git --filter=@cap/sandbox`
  - Result: PASS
- `pnpm coverage:sandbox`
  - Result: PASS
- `pnpm --filter @cap/api test`
  - Result: PASS

## API e2e

- Setup:
  - temporary local Postgres on port `5433`
  - `prisma migrate deploy`
  - fake cloud sandbox HTTP/WS provider with `CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES=all`
- Command shape:
  - `DATABASE_URL=postgresql://cap:cap@127.0.0.1:5433/cap?schema=public`
  - `CAP_SANDBOX_CLOUD_HTTP_BASE_URL=http://127.0.0.1:<fake-provider-port>`
  - `node --env-file=apps/api/.env --test --test-force-exit apps/api/test/api-e2e.mjs`
- Result: PASS
  - `4 passed`
  - `0 failed`

## AIO compose e2e

- Command:
  - `pnpm --filter @cap/api test:e2e:aio`
- Result: PASS
  - `7 tests`
  - `6 passed`
  - `0 failed`
  - `1 skipped`
- Skip reason:
  - `claude-code` runtime e2e skipped because `CLAUDE_CODE_OAUTH_TOKEN` is not configured in this local environment.
- Cleanup:
  - compose teardown completed
  - no running `cloud-agent-platform*` or `cap-aio-*` containers remained after the run

## Notes

- The first AIO e2e run exposed reconnect replay and test harness issues. The final passing run includes:
  - reconnect replay waiting across async WS auth and receiving non-empty replay frames;
  - clone success/failure verified inside the real per-task sandbox container;
  - codex startup verified against the current auto-launch + CPR contract;
  - e2e script token alignment with `apps/api/.env`.
