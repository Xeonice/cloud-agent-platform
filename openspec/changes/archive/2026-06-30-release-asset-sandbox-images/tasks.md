<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: release-assets (depends: none)

- [x] 1.1 Define the `cap-image-assets.json` schema and expected asset names for AIO Docker archives and BoxLite rootfs/OCI archives.
- [x] 1.2 Add a release packaging script that pulls/copies the versioned sandbox images, emits compressed assets, and writes checksum files.
- [x] 1.3 Add a `release.yml` job after image publication that uploads sandbox image assets and the manifest to the GitHub Release.
- [x] 1.4 Update `scripts/release.sh` and release-related tests to verify all CAP GHCR images plus the sandbox image Release assets.
- [x] 1.5 Add unit or script tests for manifest validation, checksum mismatch handling, and missing asset failure messages.

## 2. Track: installer-asset-staging (depends: release-assets)

- [x] 2.1 Add `CAP_SANDBOX_IMAGE_DELIVERY=registry|release-assets|auto` parsing and validation to `scripts/quick-deploy.sh`.
- [x] 2.2 Implement Release asset manifest fetch, resumable/atomic asset download, checksum verification, and staging directory selection.
- [x] 2.3 Implement AIO Release-asset staging through Docker archive load and post-load `docker image inspect` readiness.
- [x] 2.4 Implement BoxLite Release-asset staging through local extraction and env writing for `BOXLITE_ROOTFS_PATH` / `BOXLITE_ROOTFS_PATH_MAP`.
- [x] 2.5 Update quick-deploy preflight tests for invalid delivery mode, asset download/checksum failures, AIO load success, and BoxLite rootfs env generation.
- [x] 2.6 Update site-served installer asset injection if new helper scripts or manifest defaults must be included in the static install path.

## 3. Track: boxlite-rootfs-provider (depends: none)

- [x] 3.1 Extend BoxLite provider config types and parsing with `BOXLITE_ROOTFS_PATH` and `BOXLITE_ROOTFS_PATH_MAP`.
- [x] 3.2 Add runtime source resolution that accepts exactly one source per runtime: image or rootfs path.
- [x] 3.3 Extend the BoxLite client create request model so native mode sends `rootfs_path` when a rootfs source is selected.
- [x] 3.4 Update BoxLite provider provisioning, connection metadata, and runtime preflight to use the resolved sandbox source.
- [x] 3.5 Fail clearly when rootfs-path mode is selected with an unsupported BoxLite protocol mode.
- [x] 3.6 Add BoxLite unit/conformance tests for image mode compatibility, rootfs mode create payloads, ambiguous source rejection, and rootfs readiness failures.

## 4. Track: self-update-assets (depends: release-assets, boxlite-rootfs-provider)

- [x] 4.1 Inspect the current self-update staging path and identify where selected sandbox delivery mode and staged env values are available.
- [x] 4.2 Add asset-backed AIO staging before API recreation, including checksum verification and Docker archive load.
- [x] 4.3 Add asset-backed BoxLite staging before API recreation, including rootfs extraction and persisted `BOXLITE_ROOTFS_PATH` updates.
- [x] 4.4 Preserve existing registry pull-before-recreate behavior for registry-backed deployments.
- [x] 4.5 Add self-update tests proving failed asset staging leaves the prior version running and post-upgrade tasks see the target sandbox runtime.

## 5. Track: docs-and-verification (depends: release-assets, installer-asset-staging, boxlite-rootfs-provider, self-update-assets)

- [x] 5.1 Update release, install, one-line installer, and BoxLite provider documentation for sandbox image asset delivery and fallback behavior.
- [x] 5.2 Add or update provider-backed terminal/story verification so Release-asset BoxLite rootfs mode can be exercised locally against a real provider.
- [x] 5.3 Run focused tests for release scripts, quick-deploy preflight, BoxLite provider, and self-update asset staging.
- [x] 5.4 Run `openspec validate release-asset-sandbox-images --strict` and fix any spec/task formatting issues.
- [x] 5.5 Record manual verification steps for real BoxLite asset staging and AIO Docker archive load before release.
