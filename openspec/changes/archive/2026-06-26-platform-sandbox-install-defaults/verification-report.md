# Verification Report

Generated: 2026-06-27 04:46:29 CST
Updated: 2026-06-27 after storing local `CLAUDE_CODE_OAUTH_TOKEN` for live runtime verification.

## Summary

- Provider auto-selection is implemented through `CAP_SANDBOX_PROVIDER=auto|aio|boxlite|control-plane`.
- `auto` resolves macOS/Darwin to the BoxLite endpoint-backed path and Linux to AIO.
- Source and source-free compose api/web ports render with explicit `0.0.0.0` defaults and loopback overrides.
- Linux/AIO live parity passed against the compose e2e suite, including the Claude Code runtime path.
- BoxLite live verification could not be completed because this environment has no `BOXLITE_*` endpoint/token/image. The helper fails closed in that state, and fake endpoint readiness coverage passed.

## Commands

Passed:

- `bash -n scripts/dev-up.sh scripts/boxlite-up.sh scripts/quick-deploy.sh`
- `sh -n scripts/sandbox-provider-selection.sh apps/www/public/install.sh`
- `node scripts/sandbox-provider-selection.test.mjs`
- `node scripts/boxlite-up.test.mjs`
- `node scripts/compose-host-bind.test.mjs`
- `node scripts/gen-local-env.test.mjs`
- `node scripts/docker-compose.deploy-config.test.mjs`
- `pnpm --filter @cap/www typecheck`
- `docker compose -f docker-compose.yml --env-file /dev/null config --quiet`
- `docker compose -f docker-compose.prod.yml --env-file /dev/null config --quiet`
- `API_HOST_BIND=127.0.0.1 WEB_HOST_BIND=127.0.0.1 docker compose -f docker-compose.yml --env-file /dev/null config --quiet`
- `API_HOST_BIND=127.0.0.1 WEB_HOST_BIND=127.0.0.1 docker compose -f docker-compose.prod.yml --env-file /dev/null config --quiet`
- `pnpm --filter @cap/api test:e2e:aio`
- `openspec validate platform-sandbox-install-defaults --strict --no-interactive`
- `rg -n '^\s*debugger\b|;\s*debugger\s*;?' apps packages scripts --glob '!node_modules/**' --glob '!dist/**' --glob '!coverage/**' --glob '!**/coverage/**'`

Expected fail-closed check:

- `scripts/boxlite-up.sh --check-only` exited `1` with `BOXLITE_ENDPOINT is required for the BoxLite startup path`.
- `env | rg '^BOXLITE_'` found no live BoxLite configuration in this environment.

Cleanup checks:

- `docker compose ps --format json` returned no running project services after AIO e2e teardown.
- `docker ps --filter 'name=cap-aio-' --format '{{.Names}} {{.Status}}'` returned no leftover per-task AIO containers.

## AIO Evidence

`pnpm --filter @cap/api test:e2e:aio` completed successfully after local `CLAUDE_CODE_OAUTH_TOKEN` was configured:

- Tests: 7
- Passed: 7
- Failed: 0
- Skipped: 0

Covered live paths included AIO sandbox command execution, write-lock rejection, reconnect replay, git clone success/failure, Codex CPR startup, and Claude Code runtime auto-launch/answer in the AIO sandbox.

The Docker engine reported `29.5.3 linux/aarch64`; compose emitted the expected warning that the AIO sandbox image is `linux/amd64` on a `linux/arm64/v8` host, but the e2e still completed and teardown ran.

## BoxLite Evidence

`node scripts/boxlite-up.test.mjs` passed with a fake local HTTP endpoint:

- Writes `CAP_SANDBOX_PROVIDER=boxlite`.
- Writes required endpoint/token/image values from the process env.
- Writes high-priority local BoxLite defaults, `BOXLITE_TERMINAL_MODE=pty`, and explicit terminal/git/archive capabilities.
- Preserves existing operator-provided values.
- Fails clearly when required BoxLite env is absent.

Live BoxLite verification remains dependent on an operator-supplied BoxLite control plane:

- `BOXLITE_ENDPOINT`
- `BOXLITE_API_TOKEN`
- `BOXLITE_IMAGE`

CAP does not vendor a BoxLite daemon/image in this change, so the implemented macOS default is endpoint-backed and fail-closed until those values are present and reachable.
