## Why

BoxLite can run CAP's sandbox runtime locally, but direct BoxLite pulls from GHCR can hang on large sandbox image layers while Docker pulls the same image successfully. Publishing sandbox images as verified GitHub Release assets gives the release-image install path a central, source-free distribution channel that avoids BoxLite registry streaming during task provisioning.

## What Changes

- Publish version-matched sandbox image artifacts to each GitHub Release alongside the existing source-free run package.
- Add a release image-asset manifest plus checksum files so installers and release verification can resolve, download, verify, and stage the exact sandbox asset for the selected provider/platform.
- Extend quick-deploy with a sandbox image delivery mode that can stage AIO from a Docker archive and BoxLite from a local rootfs/OCI asset before provider readiness is reported.
- Extend the BoxLite provider/configuration to support local rootfs-path sandbox creation in native mode, while preserving the existing image / image-map path.
- Extend self-update so upgrades keep the selected provider's sandbox runtime staged when moving to a new CAP version.
- Keep GHCR registry delivery available as a fallback/explicit mode; no breaking change to source development or existing image-based deployments.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `release-and-versioning`: Releases must attach and verify sandbox image assets, not only GHCR images and the source-free run package.
- `agent-oneclick-deploy`: Quick-deploy must support release-asset sandbox image staging for AIO and BoxLite and reflect this in provider readiness.
- `boxlite-sandbox-provider`: BoxLite configuration and native sandbox creation must support a verified local rootfs path in addition to image names.
- `self-update-action`: Self-update must stage the target version's sandbox runtime using the selected delivery mode before reporting the upgraded deployment ready for future tasks.
- `one-line-installer`: Installer dependency reporting and caveats must describe sandbox image Release assets as install-time dependencies when that delivery mode is used.

## Impact

- Release workflow: add an image-asset packaging/upload job and update release verification for sandbox assets.
- Installer scripts: update `quick-deploy.sh`, preflight messaging, and site-served installer assets to support `CAP_SANDBOX_IMAGE_DELIVERY` and asset manifest resolution.
- BoxLite provider package: add rootfs-path config parsing, runtime resolution, native REST create payload support, readiness probes, and tests.
- AIO staging: add Docker archive download/load verification without requiring local builds.
- Self-update service/script path: preserve sandbox staging guarantees for asset-backed deployments.
- Documentation/specs: update release, one-line install, quick-deploy, BoxLite provider, and self-update contracts.
