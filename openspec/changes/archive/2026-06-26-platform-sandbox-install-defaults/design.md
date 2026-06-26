## Context

The current source installer delegates to `make up`, except on `arm64|aarch64` where it defaults to `make up-cp` to avoid the slow amd64 AIO sandbox image build. That makes Apple Silicon fast but not actually sandbox-ready. The BoxLite provider change adds the provider boundary and env-gated BoxLite registration, but the startup scripts do not yet choose or start a BoxLite backend.

Compose already publishes api/web ports without a host IP prefix, which Docker treats as all-interface binding. The scripts and docs still print `localhost` as the user-facing URL, so users do not get a clear distinction between "service is listening on 0.0.0.0" and "you must configure public DNS/TLS/proxy/firewall yourself."

## Goals / Non-Goals

**Goals:**

- Make macOS installs and local bring-up default to a BoxLite-backed sandbox.
- Keep Linux installs and local bring-up defaulting to the existing AIO-backed sandbox.
- Preserve explicit operator overrides for AIO, BoxLite, and control-plane-only.
- Make host binding explicit and default api/web to `0.0.0.0`, while keeping public access configuration outside the script.
- Update tests and docs so installer, dev script, quick-deploy, and run-package behavior are coherent.

**Non-Goals:**

- Changing the browser terminal protocol or provider-neutral BoxLite contracts.
- Replacing Linux AIO as the default self-host execution path.
- Automatically configuring public DNS, TLS, Cloudflare, nginx, OAuth callback URLs, cookie domains, or firewall rules.
- Making the existing prebuilt quick-deploy path work on macOS unless a BoxLite source-free run package is explicitly added in this change.

## Decisions

### D1. Use OS-based provider auto-selection

Introduce an explicit provider mode such as `CAP_SANDBOX_PROVIDER=auto|aio|boxlite|control-plane`. `auto` is the default. In `auto` mode:

- `Darwin` selects `boxlite`.
- `Linux` selects `aio`.

The installer delegates to the same source-of-truth startup script rather than duplicating provisioning. Make targets should stay ergonomic:

- `make up` -> auto provider selection.
- `make up-aio` -> force AIO.
- `make up-boxlite` -> force BoxLite.
- `make up-cp` -> control-plane-only.

Alternative considered: keep the current architecture check (`arm64` -> control-plane-only). Rejected because the user goal is a working Mac sandbox default, not a fast but sandboxless control plane.

### D2. BoxLite startup must become a first-class local path

The macOS path should not merely write `BOXLITE_*` placeholders. It must either start a local BoxLite control plane/daemon or validate an operator-supplied BoxLite endpoint before the stack reports success. The implementation should add a focused helper, for example `scripts/boxlite-up.sh` or a compose profile, that:

- starts or verifies the BoxLite backend;
- writes missing generated local-dev BoxLite env into `apps/api/.env` without overwriting existing operator values;
- sets a higher BoxLite provider priority than AIO for the macOS default;
- fails with exact remediation if BoxLite cannot be started or reached.

Alternative considered: require the user to manually set `BOXLITE_*` on Mac. Rejected because the requested default is "start BoxLite sandbox," not "start api and tell the user to configure BoxLite later."

Apply resolution: CAP does not currently vendor an authoritative BoxLite daemon,
image, or native distribution. The implemented macOS path is therefore a
validated endpoint-backed path: `scripts/boxlite-up.sh` requires
`BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and `BOXLITE_IMAGE` from the operator,
writes non-destructive defaults for the remaining provider keys, and probes the
configured endpoint before `dev-up` reports the stack ready. This is the
selected local mechanism until a CAP-owned BoxLite distribution is introduced.

### D3. Linux AIO remains the parity baseline

Linux `auto` keeps the existing full stack: `docker compose up -d --build`, including the AIO image build/staging. AIO e2e remains the live parity gate for Linux.

Alternative considered: make BoxLite the default everywhere once available. Rejected because AIO is the tested Linux self-host path and the current release/run-package tooling stages AIO images.

### D4. Host binding is explicit; public access is not automated

Compose should expose configurable host bind variables with `0.0.0.0` defaults, for example:

- `API_HOST_BIND=${API_HOST_BIND:-0.0.0.0}`
- `API_HOST_PORT=${API_HOST_PORT:-8080}`
- `WEB_HOST_BIND=${WEB_HOST_BIND:-0.0.0.0}`
- `WEB_HOST_PORT=${WEB_HOST_PORT:-3000}`

Health checks can still use `127.0.0.1` locally. User-facing output should say the service is listening on all interfaces and that public URL/TLS/proxy/OAuth origin configuration is operator-owned.

Grafana and any security-sensitive observability surfaces should keep their loopback-only defaults unless this change explicitly updates the observability threat model.

Alternative considered: keep relying on Docker's implicit all-interface default. Rejected because the behavior is easy to miss and the scripts currently print localhost-oriented guidance.

### D5. Prebuilt quick-deploy stays AIO/amd64 unless explicitly expanded

The existing source-free quick-deploy path is amd64-only and AIO-oriented. This change should update its failure guidance so macOS users are sent to the source installer, which now defaults to BoxLite. It should not silently pretend the prebuilt AIO package supports Mac.

Alternative considered: add a second source-free BoxLite run package immediately. Deferred because BoxLite local packaging is the first prerequisite and should be proven before the release package grows another topology.

## Risks / Trade-offs

- **BoxLite packaging is not yet represented in compose/scripts.** -> Mitigation: make a dedicated implementation task to add or validate the local BoxLite backend before marking the Mac default complete.
- **Existing local env files may pin AIO.** -> Mitigation: env generation must be non-destructive; scripts should print the selected provider and explain when an existing env overrides auto-selection.
- **Binding to `0.0.0.0` can expose services on a LAN.** -> Mitigation: make the default explicit in output/docs and keep production public access configuration operator-owned.
- **Prebuilt and source paths will have different platform defaults.** -> Mitigation: document that quick-deploy remains amd64/AIO while source install is platform-aware.

## Migration Plan

1. Add provider-selection flags/env and deterministic OS detection tests.
2. Add the macOS BoxLite startup/config helper and wire `make up`/`install.sh` through it in auto mode.
3. Update compose port bindings and script output to use explicit `0.0.0.0` defaults with local health probes.
4. Update docs/site copy and quick-deploy/run-package caveats.
5. Verify Linux AIO parity, macOS/BoxLite selection through mocked OS tests plus live BoxLite when available, and compose render output for host bindings.

Rollback is configuration-first: set `CAP_SANDBOX_PROVIDER=aio` or run `make up-aio` to restore the AIO path; set `API_HOST_BIND=127.0.0.1` / `WEB_HOST_BIND=127.0.0.1` to restore loopback-only host publishing.

## Resolved During Apply

Resolved during apply: the generated macOS BoxLite env advertises the interactive
PTY path by default (`terminal.websocket`, `terminal.interactive`, command exec,
git materialize/deliver, archive transfer, and lifecycle read capabilities).
Operators whose BoxLite backend does not support true PTY interaction should
override `BOXLITE_TERMINAL_MODE` / `BOXLITE_CAPABILITIES` before bring-up.
