# Research Brief: macOS BoxLite Release Install

## Trigger

Live deployment on `vibe-zlyan` exposed that the release-image install path can report a healthy API/web stack while task provisioning remains broken on macOS. The observed host was macOS arm64 running Docker through Colima and BoxLite 0.9.5.

## Findings

- The site `install.sh` delegates by piping `quick-deploy.sh` into `bash`. In that mode `BASH_SOURCE[0]` is unset under `set -u`, so `scripts/quick-deploy.sh` fails before the run package can be fetched.
- `quick-deploy.sh` uses GNU `timeout`; macOS does not ship it by default. This made a reachable Docker engine look unreachable.
- `quick-deploy.sh` reuses an existing `docker-compose.prod.yml` in the workdir. On the live host that preserved a stale compose file missing the runtime web endpoint configuration, so the web console called the wrong API port.
- The install path currently verifies API `/health` and login, but not the selected sandbox provider. A task can still fail later with `provision_failed`.
- On macOS the API was configured for `CAP_SANDBOX_PROVIDER=boxlite`, but the API always registered AIO and only optionally registered BoxLite. Capability selection allowed fallback to AIO, which created an amd64 AIO sandbox under Colima and failed.
- CAP's BoxLite client currently expects `/v1/sandboxes`. BoxLite 0.9.5 native REST exposes `/v1/default/boxes`, `/exec`, `/executions/:id/attach`, `/resize`, and related routes. The live host had an untracked `cap-boxlite-adapter.py` to translate between them, but the adapter was not managed by the installer and was not running.
- The live adapter covered create/get/delete/exec/archive but did not implement a terminal WebSocket route. CAP's terminal transport selection currently supports `aio-json-v1` only, so advertising BoxLite interactive terminal capability without a real transport is unsafe.
- Installer dependency inventory needs to distinguish install-time dependencies from task-time dependencies. Install-time includes shell tooling, Docker/Compose/socket, release asset endpoints, GHCR, Docker Hub, and selected provider readiness. Task-time includes GitHub/GitLab/Gitee repo access, OpenAI/Claude auth, repo package registries, and optional SMTP.
- A local ignored `.env.github-validation` file is available for test-only GitHub API validation. The token value must remain out of OpenSpec artifacts, source, logs, and commits.

## Existing Specs

- `one-line-installer`: owns site-hosted `install.sh`, prereq checks, and delegated release-image bring-up.
- `agent-oneclick-deploy`: owns `scripts/quick-deploy.sh`, source-free image pull/up, platform gates, health checks, and optional smoke.
- `boxlite-sandbox-provider`: owns BoxLite provider registration, capabilities, REST contract, command/archive operations, and terminal transport requirements.
- `sandbox-provider-port`: owns provider selection, selected run context, capability vocabulary, and provider ownership.
- `release-and-versioning`: owns release-image install docs and platform-aware run-package caveats.

## Proposed Direction

- Make the installer pipe-safe and macOS-safe, and teach it to install Docker only when absent while leaving an already usable Docker install untouched.
- Add an explicit external dependency preflight/report: install-time endpoints, image registries, selected provider readiness, and optional GitHub API validation.
- Treat `CAP_SANDBOX_PROVIDER` as a provider selection constraint rather than advisory metadata.
- Productize BoxLite support through native REST or a managed packaged adapter, with accurate capability declaration. Do not advertise interactive terminal support until the CAP API has a real BoxLite terminal transport.
- Add a real end-to-end verification path using `lume` for a clean macOS VM, with test-only GitHub validation token loaded from ignored local env when present.
