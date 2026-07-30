# Provider Terminal Story

This local-only story lives outside `apps/web/src/routes`; it is not part of the
production route graph.

## Commands

- UI only: `pnpm --filter @cap-console/web provider-terminal-story:dev`
- Verification: `pnpm --filter @cap-console/web test:provider-terminal-story`

The verification suite always checks disabled/readiness UI states with mocked API
responses. Live provider checks are opt-in:

```bash
CAP_PROVIDER_TERMINAL_STORY=1 \
CAP_PROVIDER_TERMINAL_STORY_E2E=1 \
CAP_PROVIDER_TERMINAL_STORY_PROVIDER=boxlite \
VITE_API_BASE_URL=http://127.0.0.1:8080 \
VITE_WS_URL=ws://127.0.0.1:8080 \
VITE_AUTH_TOKEN=<operator-token> \
pnpm --filter @cap-console/web test:provider-terminal-story
```

An independent canary that already registered a real task/owner in CAP can mount
that exact session without using the story lifecycle REST API:

```bash
VITE_WS_URL=ws://127.0.0.1:8080 \
VITE_AUTH_TOKEN=<operator-token> \
pnpm --filter @cap-console/web provider-terminal-story:dev
```

Open `/?external=1&sessionId=terminal-story-<id>` (optionally add
`provider=aio` or `provider=boxlite` for the label). External mode mounts the
production `SessionTerminal` directly against CAP's `/terminal` WebSocket. It
does not call readiness, create, lookup, inventory, or teardown REST endpoints,
does not install the fixture WebSocket even if a `fixture` query is present, and
disables story-owned lifecycle actions. The canary that registered the session
remains responsible for exact cleanup.

The live path creates a temporary API-side provider story session with one owner
and disposable viewer PTYs. Browsers connect only to CAP's `/terminal` gateway;
the story response and page never expose a provider WebSocket URL, sandbox id, or
credential. The deterministic fixture writes more than 500 unique history
markers before entering a styled alternate screen with CJK, live, input, resize,
and frozen-frame probes.

The first live case freezes the frame, emits one uniquely named live delta, and
compares uninterrupted versus fresh-attach SerializeAddon state plus unmasked
screenshots at identical geometry. The second mounts two simultaneous browser
viewers, proves that only the lease holder can write and resize, disconnects all
viewers, then opens a third PTY and compares the restored static frame. It also
checks the provider-side hexadecimal byte oracle for UTF-8 plus legacy X10 mouse
bytes (including a byte at or above `0x80`). The story-only inventory endpoint,
`GET /terminal-stories/provider/sessions/:sessionId/inventory`, exposes a bounded,
explicitly truncated list of exact query, browser-response, actual provider-write,
attachment, and authoritative-resize events. Query/input/response bytes are
base64-encoded opaque values.

The gate rejects history-prefix replay, stale input echoes, snapshot/tail
controls, blank or partial redraws, provider endpoint exposure, duplicated live
deltas, reader writes/resizes, and non-zero Gateway resources after every viewer
disconnects.

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

The story API registers a temporary backing task, opens one provider sandbox,
and sets a short TTL. The Playwright suite tracks the session from its create
response and calls `DELETE /terminal-stories/provider/sessions/:sessionId`; its
`afterEach` repeats that idempotent exact-session cleanup after success, assertion
failure, or timeout and requires evidence that the Gateway owner/viewers,
telemetry observer, provider sandbox, and backing repo are absent. An aborted
HTTP create request propagates cancellation to provisioning and removes its
request listener; cancellation after Gateway registration follows the same exact
cleanup path.

Graceful `SIGTERM`/`SIGINT` uses Nest's application-shutdown hook to drain every
live story. TTL is the final in-process timeout fallback. Each cleanup component
is attempted even if another fails, and any uncertainty is returned as explicit,
sanitized `teardownError` plus per-resource cleanup evidence. These paths never
enumerate or delete unrelated sandboxes. A force-kill cannot run in-process
cleanup; after one, inspect exact story ids and use the provider's normal
task-scoped cleanup path only when the API cannot be restored.
