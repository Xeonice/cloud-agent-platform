# Research Brief

This side-car records the lightweight research pass for `platform-sandbox-install-defaults`.

## Current Installer And Startup Paths

- `apps/www/public/install.sh` is the site-hosted source installer. It clones the repo and delegates to `make up`, except on `arm64|aarch64` where it currently defaults to `make up-cp` to avoid building the amd64 AIO image under emulation.
- `Makefile` maps `make up` to `scripts/dev-up.sh` and `make up-cp` to `scripts/dev-up.sh --control-plane-only`.
- `scripts/dev-up.sh` bootstraps `apps/api/.env`, then either runs `docker compose up -d --build` for the full AIO-backed stack or `docker compose up -d --build api postgres` for control-plane-only.
- `scripts/gen-local-env.sh` currently generates a local env with legacy token auth and `WEB_ORIGIN=http://localhost:3000`; it does not select a sandbox provider.
- `docker-compose.yml` publishes `api` as `8080:8080` and optional `web` as `${WEB_HOST_PORT:-3000}:3000`. With no host IP prefix, Docker publishes on all interfaces (`0.0.0.0`) by default, but `scripts/dev-up.sh` prints `localhost` URLs.
- `docker-compose.prod.yml` is source-free and currently assumes AIO with `AIO_SANDBOX_IMAGE=ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION:-latest}` plus `aio-sandbox-image`.
- `scripts/quick-deploy.sh` is explicitly amd64-only and localhost/trial oriented. It is a separate prebuilt-image path from the source installer.

## Existing Specs

- `one-line-installer` requires the site-hosted `install.sh` to wrap `make up` and currently has an Apple Silicon guidance scenario that points at the control-plane-only path.
- `multi-target-deploy` defines the one-command local dev bring-up and says it runs `docker compose up -d --build`, building the per-task AIO image.
- `agent-oneclick-deploy` covers the prebuilt quick-deploy path and currently gates non-amd64 hosts away from prebuilt images.
- `release-and-versioning` covers the source-free run package, which is AIO/amd64 oriented.
- The in-progress BoxLite provider change adds provider config, but the repository currently has no committed local BoxLite service/daemon compose entry. BoxLite registration is env-gated via `BOXLITE_ENDPOINT`, token, image, capabilities, and terminal mode.

## Planning Implications

- macOS default cannot merely run `make up-cp`; it must produce an actually usable sandbox default. That requires either starting a local BoxLite control plane/daemon or connecting to a configured BoxLite endpoint and writing valid `BOXLITE_*` env.
- Linux should preserve the current AIO full-stack default because Docker-out-of-Docker and the pinned AIO image remain the tested self-host path there.
- Startup scripts should make all-interface exposure explicit in configuration and output. Binding to `0.0.0.0` is acceptable for the api/web default, but public DNS/TLS/reverse proxy remains operator-owned and must not be silently configured by the scripts.
- Tests should verify OS/arch selection logic without requiring a real Mac host, and compose rendering should prove expected port bindings and provider env.
