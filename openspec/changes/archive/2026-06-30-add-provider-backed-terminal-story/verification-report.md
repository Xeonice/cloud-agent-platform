# Verification Report

Date: 2026-06-30

## Commands

- `pnpm --filter @cap/api typecheck` - passed
- `pnpm --filter @cap/api lint` - passed
- `pnpm --filter @cap/api build` - passed
- `pnpm --filter @cap/api test:terminal-src` - passed, including `provider-terminal-story.service.test.mjs`
- `pnpm --filter @cap/web typecheck` - passed
- `pnpm --filter @cap/web lint` - passed
- `pnpm --filter @cap/web test:provider-terminal-story` - passed with live AIO env enabled

## Live AIO Provider Story

The live AIO verification was run against a temporary local compose API:

```bash
docker compose run --build --rm --service-ports \
  -e CAP_PROVIDER_TERMINAL_STORY=1 \
  -e CAP_PROVIDER_TERMINAL_STORY_PROVIDER=aio \
  -e CAP_SANDBOX_PROVIDER=aio \
  -e AUTH_TOKEN_LEGACY_ENABLED=true \
  -e AUTH_TOKEN=provider-story-local-token \
  -e AIO_SANDBOX_IMAGE=cap-aio-sandbox:e2e \
  -e WEB_ORIGIN=http://127.0.0.1:4328 \
  api
```

Readiness returned:

```json
{
  "enabled": true,
  "ready": true,
  "requestedProvider": "aio",
  "configuredProvider": "aio",
  "providerId": "aio-local",
  "reason": null,
  "capabilities": [
    "terminal.websocket",
    "workspace.git.materialize",
    "workspace.git.deliver",
    "transcript.retained-read",
    "lifecycle.readopt"
  ]
}
```

The Playwright command:

```bash
CAP_PROVIDER_TERMINAL_STORY_E2E=1 \
CAP_PROVIDER_TERMINAL_STORY_PROVIDER=aio \
VITE_API_BASE_URL=http://127.0.0.1:8080 \
VITE_WS_URL=ws://127.0.0.1:8080 \
VITE_AUTH_TOKEN=provider-story-local-token \
pnpm --filter @cap/web test:provider-terminal-story
```

Result: 4 passed in 23.6s. This exercised session creation, CAP `/terminal`
gateway attachment, provider-backed fixture output, Chinese UTF-8 rendering,
scrollback, operator input echo, resize markers, reconnect replay, and teardown.

The temporary compose stack was stopped with `docker compose down -v`; a final
container check showed no remaining `cloud-agent-platform` or `cap-aio-*`
containers.

## BoxLite

Real BoxLite verification was not run because this local shell did not provide
the required BoxLite runtime configuration:

- `BOXLITE_ENDPOINT` was unset
- `BOXLITE_API_TOKEN` was unset
- `BOXLITE_IMAGE` was unset
- `BOXLITE_TERMINAL_MODE=pty` was unset
- `CAP_SANDBOX_PROVIDER=boxlite` was unset

The implemented readiness path fails closed for those prerequisites and also
requires `terminal.websocket` plus `terminal.interactive` capabilities before
creating a story session.
