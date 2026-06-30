# Manual Verification

Run these against a real published Release before cutting production traffic over
to Release-asset sandbox delivery.

## Release Assets

1. Open the target GitHub Release and confirm these assets exist:
   - `cap-image-assets.json`
   - `cap-aio-sandbox-<version>-linux-amd64.docker.tar.zst`
   - `cap-boxlite-sandbox-<version>-linux-amd64.oci.tar.zst`
   - `cap-boxlite-sandbox-<version>-linux-arm64.oci.tar.zst`
   - matching `.sha256` files for every archive
2. Download the asset set and run:
   ```bash
   node scripts/release-image-assets.mjs verify --version <version> --dir <download-dir>
   ```

## AIO Docker Archive

1. On a Linux/amd64 Docker host, run:
   ```bash
   CAP_VERSION=<version> \
   CAP_SANDBOX_PROVIDER=aio \
   CAP_SANDBOX_IMAGE_DELIVERY=release-assets \
   CAP_QUICK_DEPLOY_STOP_AFTER=provider-readiness \
   scripts/quick-deploy.sh
   ```
2. Confirm output includes checksum verification, `docker load`, and:
   `AIO readiness: staged ghcr.io/xeonice/cap-aio-sandbox:<version> from Release asset`.
3. Confirm Docker can inspect the loaded image:
   ```bash
   docker image inspect ghcr.io/xeonice/cap-aio-sandbox:<version>
   ```

## BoxLite Rootfs Asset

1. On a host with a real BoxLite endpoint, run:
   ```bash
   CAP_VERSION=<version> \
   CAP_SANDBOX_PROVIDER=boxlite \
   CAP_SANDBOX_IMAGE_DELIVERY=release-assets \
   BOXLITE_ENDPOINT=<endpoint> \
   BOXLITE_API_TOKEN=<token> \
   CAP_QUICK_DEPLOY_STOP_AFTER=provider-readiness \
   scripts/quick-deploy.sh
   ```
2. Confirm `.env` contains `CAP_SANDBOX_IMAGE_DELIVERY=release-assets`,
   `BOXLITE_ROOTFS_PATH=<asset-dir>/boxlite/cap-boxlite-sandbox/<version>/<platform>/oci`,
   and no `BOXLITE_IMAGE`.
3. Confirm provider readiness creates, starts, execs, and deletes a BoxLite probe
   sandbox from the staged rootfs.

## Provider Terminal Story

1. Start the API with the staged BoxLite rootfs env plus:
   `CAP_PROVIDER_TERMINAL_STORY=1`, `BOXLITE_TERMINAL_MODE=pty`, and terminal
   capabilities including `terminal.websocket,terminal.interactive`.
2. Run:
   ```bash
   CAP_PROVIDER_TERMINAL_STORY=1 \
   CAP_PROVIDER_TERMINAL_STORY_E2E=1 \
   CAP_PROVIDER_TERMINAL_STORY_PROVIDER=boxlite \
   VITE_API_BASE_URL=http://127.0.0.1:8080 \
   VITE_WS_URL=ws://127.0.0.1:8080 \
   VITE_AUTH_TOKEN=<operator-token> \
   pnpm --filter @cap/web test:provider-terminal-story
   ```
3. Confirm the story opens a real provider session through CAP's `/terminal`
   gateway and tears the session down.

## Self-Update

1. On a staging compose deployment with `SELF_UPDATE_ENABLED=true` and
   `CAP_SANDBOX_IMAGE_DELIVERY=release-assets`, request an update to the latest
   Release from the admin console.
2. Confirm the detached updater downloads and verifies sandbox Release assets
   before rewriting `CAP_VERSION` and before `docker compose pull`.
3. Confirm `GET /version` reports the new target and a new task provisions with
   the target sandbox runtime.
