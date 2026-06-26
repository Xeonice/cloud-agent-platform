# @cap/sandbox-provider-boxlite

BoxLite sandbox provider adapter for CAP.

BoxLite is optional and fail-closed. CAP registers it only when `BOXLITE_ENDPOINT`
and the rest of the required provider configuration are present and valid. AIO
remains the default provider when BoxLite is absent or invalid.

## Local startup

`make up` is platform-aware: macOS resolves `CAP_SANDBOX_PROVIDER=auto` to the
BoxLite startup path, while Linux resolves it to AIO. CAP does not vendor a
BoxLite daemon or image yet, so the macOS path validates an operator-supplied
BoxLite endpoint before reporting the stack ready:

```sh
BOXLITE_ENDPOINT=http://127.0.0.1:7331 \
BOXLITE_API_TOKEN=... \
BOXLITE_IMAGE=cap-boxlite:2026-06-27 \
make up
```

Use `make up-aio`, `make up-boxlite`, or `make up-cp` to force a mode.

## Environment

- `BOXLITE_ENDPOINT`: required to enable the provider. Must be an `http` or
  `https` URL for the BoxLite control plane.
- `BOXLITE_API_TOKEN`: required bearer token for the BoxLite REST API.
- `BOXLITE_IMAGE`: default image used for task sandboxes.
- `BOXLITE_IMAGE_MAP`: optional runtime-specific image mapping. Accepts JSON
  such as `{"codex":"cap-boxlite-codex:1"}` or comma form
  `codex=cap-boxlite-codex:1,claude-code=cap-boxlite-claude:1`.
- `BOXLITE_PROVIDER_ID`: provider id, default `boxlite`.
- `BOXLITE_PROVIDER_PRIORITY`: scheduler priority, default `0`.
- `BOXLITE_PROVIDER_LOCATION`: `local` or `cloud`, default `cloud`.
- `BOXLITE_CAPABILITIES`: comma-separated explicit capability list. No
  capabilities are implied.
- `BOXLITE_WORKSPACE_PATH`: in-sandbox workspace path, default `/workspace`.
- `BOXLITE_SANDBOX_ID_PREFIX`: task-scoped provider sandbox id prefix, default
  `cap-boxlite-`.
- `BOXLITE_SANDBOX_MODE`: `read-only`, `workspace-write`, or
  `danger-full-access`, default `workspace-write`.
- `BOXLITE_CLIENT_MODE`: currently only `rest`.
- `BOXLITE_TERMINAL_MODE`: `none` or `pty`. Terminal capabilities require
  `pty`; streaming exec alone must not advertise live terminal support.
- `BOXLITE_TIMEOUT_MS`: REST timeout in ms, default `30000`.

## Capabilities

BoxLite advertises only what `BOXLITE_CAPABILITIES` names and the adapter can
support. Common examples:

```sh
BOXLITE_CAPABILITIES=command.exec,workspace.archive.transfer,lifecycle.readoption
```

Interactive terminal support must be explicit:

```sh
BOXLITE_TERMINAL_MODE=pty
BOXLITE_CAPABILITIES=terminal.websocket,terminal.interactive,command.exec
```

Git delivery requires command execution:

```sh
BOXLITE_CAPABILITIES=command.exec,workspace.archive.transfer,workspace.git.deliver
```

Snapshot and sleep are optional provider-native optimizations. CAP still treats
task rows, audit records, transcript archive, and git delivery as durable truth.

## REST Client Contract

The remote REST client uses:

- `POST /v1/sandboxes`
- `GET /v1/sandboxes/:id`
- `DELETE /v1/sandboxes/:id`
- `POST /v1/sandboxes/:id/exec`
- `PUT /v1/sandboxes/:id/archive?path=...`
- `GET /v1/sandboxes/:id/archive?path=...`

Responses may be plain objects or wrapped in `{ data: ... }`.

## Testing

Fast tests use `FakeBoxLiteClient` and provider conformance:

```sh
pnpm --filter @cap/sandbox-provider-boxlite test
```

Live integration is opt-in:

```sh
BOXLITE_LIVE_TEST=1 \
BOXLITE_ENDPOINT=https://boxlite.example.test \
BOXLITE_API_TOKEN=... \
BOXLITE_IMAGE=cap-boxlite:2026-06-27 \
BOXLITE_CAPABILITIES=command.exec,workspace.archive.transfer,lifecycle.readoption \
pnpm --filter @cap/sandbox-provider-boxlite test
```
