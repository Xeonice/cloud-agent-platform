# @cap/sandbox-provider-boxlite

BoxLite sandbox provider adapter for CAP.

BoxLite is optional and fail-closed. CAP registers it only when `BOXLITE_ENDPOINT`
and the rest of the required provider configuration are present and valid. In
`CAP_SANDBOX_PROVIDER=auto`, AIO remains the Linux default when BoxLite is
absent. In explicit `CAP_SANDBOX_PROVIDER=boxlite`, invalid or unreachable
BoxLite configuration fails closed instead of falling back to AIO.

## Local startup

`make up` is platform-aware: macOS resolves `CAP_SANDBOX_PROVIDER=auto` to the
BoxLite startup path, while Linux resolves it to AIO. CAP does not vendor a
BoxLite daemon, so the macOS path validates an operator-supplied BoxLite
endpoint before reporting the stack ready. The release-image install path uses
the same provider env and defaults `BOXLITE_PROTOCOL_MODE=native`. It can either
use a version-matched `ghcr.io/xeonice/cap-boxlite-sandbox:<version>` runtime
image or stage the matching GitHub Release asset as a local rootfs path:

```sh
BOXLITE_ENDPOINT=http://host.docker.internal:7331 \
BOXLITE_READINESS_ENDPOINT=http://127.0.0.1:7331 \
BOXLITE_API_TOKEN=... \
BOXLITE_IMAGE=ghcr.io/xeonice/cap-boxlite-sandbox:vX.Y.Z \
BOXLITE_PROTOCOL_MODE=native \
make up
```

For Release-asset delivery, quick-deploy downloads and verifies
`cap-boxlite-sandbox-<version>-<platform>.oci.tar.zst`, extracts it under
`CAP_SANDBOX_ASSET_DIR`, writes `BOXLITE_ROOTFS_PATH`, and clears image env. Use
`CAP_SANDBOX_IMAGE_DELIVERY=registry` to force image mode.

Use `make up-aio`, `make up-boxlite`, or `make up-cp` to force a mode.

## Environment

- `BOXLITE_ENDPOINT`: required to enable the provider. Must be an `http` or
  `https` URL for the BoxLite control plane as seen by the API container. For a
  BoxLite daemon running on the Docker/Colima host, use
  `http://host.docker.internal:7331`.
- `BOXLITE_READINESS_ENDPOINT`: optional install-time endpoint used by host-side
  probes. It defaults to `BOXLITE_ENDPOINT`, except
  `host.docker.internal` maps to `127.0.0.1` so same-host BoxLite installs probe
  the daemon from the host while the API container keeps the container-facing
  runtime endpoint.
- `BOXLITE_API_TOKEN`: required bearer token for the BoxLite REST API.
- `BOXLITE_IMAGE`: default image used for task sandboxes in registry mode. The
  release-image install path defaults this to
  `ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}` only when registry mode is
  selected or Release-asset staging is unavailable.
- `BOXLITE_IMAGE_MAP`: optional runtime-specific image mapping. Accepts JSON
  such as `{"codex":"cap-boxlite-codex:1"}` or comma form
  `codex=cap-boxlite-codex:1,claude-code=cap-boxlite-claude:1`.
- `BOXLITE_ROOTFS_PATH`: default local rootfs/OCI directory used for task
  sandboxes in native protocol mode. Release-asset delivery writes this value.
- `BOXLITE_ROOTFS_PATH_MAP`: optional runtime-specific rootfs mapping. Accepts
  the same JSON or comma `runtime=/absolute/path` forms as `BOXLITE_IMAGE_MAP`.
- Image and rootfs sources are mutually exclusive per runtime. Set exactly one of
  `BOXLITE_IMAGE`/`BOXLITE_IMAGE_MAP` or
  `BOXLITE_ROOTFS_PATH`/`BOXLITE_ROOTFS_PATH_MAP`. Rootfs mode requires
  `BOXLITE_PROTOCOL_MODE=native`.
- `BOXLITE_PROVIDER_ID`: provider id, default `boxlite`.
- `BOXLITE_PROVIDER_PRIORITY`: scheduler priority, default `0`.
- `BOXLITE_PROVIDER_LOCATION`: `local` or `cloud`, default `cloud`.
- `BOXLITE_CAPABILITIES`: comma-separated explicit capability list. No
  capabilities are implied.
- `BOXLITE_WORKSPACE_PATH`: in-sandbox workspace path, default `/home/gem/workspace`.
- `BOXLITE_SANDBOX_ID_PREFIX`: task-scoped provider sandbox id prefix, default
  `cap-boxlite-`.
- `BOXLITE_SANDBOX_MODE`: `read-only`, `workspace-write`, or
  `danger-full-access`, default `workspace-write`.
- `BOXLITE_CLIENT_MODE`: currently only `rest`.
- `BOXLITE_PROTOCOL_MODE`: `native` or `cap-rest`, default `native`. `native`
  speaks BoxLite 0.9.x box/execution/file routes directly. `cap-rest` is the old
  CAP compatibility adapter contract.
- `BOXLITE_PATH_PREFIX`: native BoxLite path prefix, default `default`; native
  requests use `/v1/<prefix>/...`.
- `BOXLITE_TERMINAL_MODE`: `none` or `pty`. Terminal capabilities require
  `pty`; streaming exec alone must not advertise live terminal support.
- `BOXLITE_TIMEOUT_MS`: REST timeout in ms, default `30000`.

## Capabilities

BoxLite advertises only what `BOXLITE_CAPABILITIES` names and the adapter can
support. Common examples:

```sh
BOXLITE_CAPABILITIES=command.exec,workspace.archive.transfer,lifecycle.readoption
```

Interactive terminal support must be explicit. In native mode CAP uses its own
`boxlite-v1` terminal transport, attaches to BoxLite executions, and translates
stdin/stdout/stderr/exit/resize/signal frames; do not advertise terminal support
unless `BOXLITE_TERMINAL_MODE=pty` and the terminal transport tests pass:

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

In the default `native` protocol, the REST client uses BoxLite 0.9.x routes:

- `POST /v1/<path-prefix>/boxes`
- `GET /v1/<path-prefix>/boxes/:box_id`
- `DELETE /v1/<path-prefix>/boxes/:box_id`
- `POST /v1/<path-prefix>/boxes/:box_id/exec`
- `GET /v1/<path-prefix>/executions/:execution_id`
- `GET /v1/<path-prefix>/executions/:execution_id/attach` (websocket)
- `PUT /v1/<path-prefix>/boxes/:box_id/files?path=...`
- `GET /v1/<path-prefix>/boxes/:box_id/files?path=...`

`BOXLITE_PROTOCOL_MODE=cap-rest` keeps support for the older CAP adapter routes:

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
BOXLITE_IMAGE=ghcr.io/xeonice/cap-boxlite-sandbox:vX.Y.Z \
BOXLITE_PROTOCOL_MODE=native \
BOXLITE_CAPABILITIES=command.exec,workspace.archive.transfer,lifecycle.readoption \
pnpm --filter @cap/sandbox-provider-boxlite test
```

To live-test a rootfs source instead, replace `BOXLITE_IMAGE` with an absolute
`BOXLITE_ROOTFS_PATH` and keep `BOXLITE_PROTOCOL_MODE=native`.
