# Provider Terminal Story

This local-only story lives outside `apps/web/src/routes`; it is not part of the
production route graph.

## Commands

- UI only: `pnpm --filter @cap/web provider-terminal-story:dev`
- Verification: `pnpm --filter @cap/web test:provider-terminal-story`

The verification suite always checks disabled/readiness UI states with mocked API
responses. Live provider checks are opt-in:

```bash
CAP_PROVIDER_TERMINAL_STORY=1 \
CAP_PROVIDER_TERMINAL_STORY_E2E=1 \
CAP_PROVIDER_TERMINAL_STORY_PROVIDER=boxlite \
VITE_API_BASE_URL=http://127.0.0.1:8080 \
VITE_WS_URL=ws://127.0.0.1:8080 \
VITE_AUTH_TOKEN=<operator-token> \
pnpm --filter @cap/web test:provider-terminal-story
```

The live path creates a temporary API-side provider story session, connects the
browser only to CAP's `/terminal` gateway, and tears the session down at the end.
The page displays only CAP story fields: provider id, story session id, readiness,
and teardown state.

## Provider Prerequisites

For local AIO, run the API inside the compose topology so it can reach sibling
sandbox containers on `cap-net`. The API environment must include:

- `CAP_PROVIDER_TERMINAL_STORY=1`
- `CAP_SANDBOX_PROVIDER=aio`
- `AIO_SANDBOX_IMAGE=<local-aio-image>`
- `WEB_ORIGIN=http://127.0.0.1:4328`
- a valid local operator token exposed to the browser as `VITE_AUTH_TOKEN`

For BoxLite, run the API with:

- `CAP_PROVIDER_TERMINAL_STORY=1`
- `CAP_SANDBOX_PROVIDER=boxlite`
- `BOXLITE_ENDPOINT`
- `BOXLITE_API_TOKEN`
- `BOXLITE_IMAGE`/`BOXLITE_IMAGE_MAP`, or
  `BOXLITE_ROOTFS_PATH`/`BOXLITE_ROOTFS_PATH_MAP` when validating a staged
  Release-asset rootfs
- `BOXLITE_TERMINAL_MODE=pty`
- BoxLite capabilities including `terminal.websocket` and `terminal.interactive`

For a local Release-asset rootfs verification, first run the installer staging
path or extract the target asset manually so the API env has an absolute
`BOXLITE_ROOTFS_PATH`. Keep `BOXLITE_PROTOCOL_MODE=native`; rootfs mode is not
supported by the older `cap-rest` adapter contract.

Explicit `CAP_PROVIDER_TERMINAL_STORY_PROVIDER=boxlite` fails closed if any of
those values are missing; it does not fall back to AIO.

## Cleanup

The story API registers a temporary backing task, opens one provider sandbox, and
sets a short TTL. The Playwright test calls `DELETE
/terminal-stories/provider/sessions/:sessionId` during teardown. If a run is
interrupted, inspect leftover sessions in the story UI or by checking containers
named `cap-aio-terminal-story-*`, then delete the session through the API if the
API process is still alive. If the API process is gone, use the provider's normal
sandbox cleanup path for the leftover container or BoxLite sandbox.
