## Research Brief

### Problem Summary

Local BoxLite verification showed that BoxLite itself can run CAP's sandbox runtime and can pull the same image successfully through a local registry mirror, but direct pulls from GHCR can hang on large layers with `IncompleteMessage`. Docker can pull the same image on the same host. This points to a BoxLite registry streaming/download path compatibility issue rather than a bad CAP image or broken BoxLite runtime.

The current release-image install path still depends on live registry pulls for sandbox images:

- GitHub Actions builds and pushes `cap-api`, `cap-web`, `cap-aio-sandbox`, and `cap-boxlite-sandbox` to GHCR.
- Release assets only attach the source-free run package (`docker-compose.prod.yml` and `docker-compose.prod.env.example`).
- Linux/AIO readiness stages `ghcr.io/xeonice/cap-aio-sandbox:${CAP_VERSION}` through Docker/Compose pull.
- macOS/BoxLite readiness and runtime provisioning use `BOXLITE_IMAGE` / `BOXLITE_IMAGE_MAP`; BoxLite then pulls the image itself during sandbox creation.

### Relevant Existing Specs

- `release-and-versioning`: owns the release workflow, GHCR image set, Release assets, release script verification, and release-image documentation.
- `agent-oneclick-deploy`: owns quick-deploy behavior, platform/provider selection, AIO staging, BoxLite readiness, and source-free bring-up.
- `boxlite-sandbox-provider`: owns BoxLite configuration, image mapping, native REST create/start/exec behavior, readiness probes, and capability-gated provider registration.
- `self-update-action`: owns upgrade-time image staging so new tasks do not fail after an API upgrade.
- `one-line-installer`: owns install dependency disclosure and site installer caveats.

### Current Code Touchpoints

- `.github/workflows/release.yml` builds and pushes sandbox images, but only `attach-run-assets` uploads compose/env assets.
- `scripts/quick-deploy.sh` currently defaults `BOXLITE_IMAGE` to `ghcr.io/xeonice/cap-boxlite-sandbox:${CAP_VERSION}` and probes BoxLite by creating a sandbox with `image`.
- `scripts/quick-deploy.sh` currently validates AIO by Compose-pulling `aio-sandbox-image` and checking `docker image inspect`.
- `packages/sandbox-provider-boxlite/src/boxlite-config.ts` requires a default image from `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP`.
- `packages/sandbox-provider-boxlite/src/boxlite-client.ts` and `boxlite-provider.ts` model BoxLite sandbox creation as image-based.
- `apps/api/src/self-update/self-update.service.ts` stages cap images by pull/recreate topology and needs to preserve sandbox image staging guarantees.

### Proposed Direction

Publish sandbox image artifacts as GitHub Release assets in addition to GHCR:

- AIO: a Docker archive (`cap-aio-sandbox-vX.Y.Z-linux-amd64.docker.tar.zst`) loaded with `docker load`.
- BoxLite: an OCI/rootfs archive (`cap-boxlite-sandbox-vX.Y.Z-linux-arm64.oci.tar.zst`) extracted locally and passed to BoxLite through a rootfs path, avoiding BoxLite registry pulls.
- A manifest (`cap-image-assets.json`) plus `.sha256` files bind version, platform, asset names, checksums, image tags, and local staging paths.

Use `CAP_SANDBOX_IMAGE_DELIVERY=registry|release-assets|auto` to keep the current registry path available while enabling central Release-asset delivery. `auto` should prefer Release assets for BoxLite and may keep Linux/AIO on registry until the AIO asset path is fully validated.

### Key Risks

- BoxLite native REST must support the chosen local rootfs/OCI field; CAP should fail clearly if a configured BoxLite protocol mode cannot create sandboxes from a local rootfs path.
- Asset downloads need resumable/atomic writes, checksum verification, disk-space checks, and no secret leakage.
- Self-update must preserve the "sandbox image staged before new tasks" guarantee for both Docker-loaded AIO images and BoxLite rootfs assets.
- Release verification must cover both GHCR packages and Release image assets so a release cannot ship a tag whose installer points at missing assets.
