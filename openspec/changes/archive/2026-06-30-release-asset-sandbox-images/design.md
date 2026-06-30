## Context

CAP's release pipeline already builds a version-matched image set for `cap-api`,
`cap-web`, `cap-aio-sandbox`, and `cap-boxlite-sandbox`. The Release assets,
however, only carry the source-free run package. Runtime sandbox image staging
still depends on registry pulls: Docker pulls the AIO image during Linux/AIO
bring-up, and BoxLite pulls the BoxLite sandbox image when CAP creates a BoxLite
sandbox.

Local verification showed that BoxLite can run the CAP sandbox runtime and can
consume the same image through a local registry mirror, but direct GHCR pulls can
hang on large layers with `IncompleteMessage`. The release-image install path
therefore needs a central distribution mode that does not require BoxLite to pull
large layers from GHCR at sandbox creation time.

## Goals / Non-Goals

**Goals:**

- Publish sandbox runtime artifacts as versioned GitHub Release assets.
- Let quick-deploy stage the selected provider's sandbox runtime from those
  assets with checksum verification and resumable/atomic downloads.
- Load AIO assets into Docker so existing AIO provisioning remains image based.
- Extract BoxLite assets locally and create native BoxLite sandboxes from a
  verified rootfs path instead of a registry image.
- Keep the existing GHCR image path available for compatibility and rollback.
- Preserve the self-update guarantee that a deployment can provision new tasks
  after upgrading to a new CAP version.

**Non-Goals:**

- Moving `cap-api` or `cap-web` away from GHCR.
- Introducing a custom CDN, R2, S3, or package mirror in the first iteration.
- Removing `BOXLITE_IMAGE` / `BOXLITE_IMAGE_MAP` support.
- Supporting local rootfs-path creation through CAP's legacy `cap-rest`
  compatibility adapter unless that adapter is explicitly extended later.
- Changing task runtime tools or sandbox capability semantics.

## Decisions

### D1. Use GitHub Release assets as the first central distribution channel

Each release will attach a machine-readable `cap-image-assets.json`, compressed
sandbox image artifacts, and `.sha256` files. This keeps release distribution
under the existing GitHub Release boundary and avoids adding new infrastructure.
The manifest binds the release tag, provider image kind, platform, asset name,
checksum, expected loaded tag or rootfs path, and fallback GHCR image.

Alternative considered: custom CDN/object storage from the start. That would add
credentials, sync jobs, cache invalidation, and billing before proving the asset
path solves the BoxLite problem. The manifest shape can support a future mirror
base URL without changing installer semantics.

### D2. Use provider-native staging formats

AIO assets will be published as a compressed Docker archive and staged with
`docker load`, because the AIO provider already provisions Docker containers from
`AIO_SANDBOX_IMAGE`. BoxLite assets will be published as a compressed OCI/rootfs
layout and staged by extraction to a stable host path, because that avoids
registry pulls in BoxLite entirely.

Alternative considered: prewarm BoxLite by downloading an image archive and
serving it from a temporary local registry. That worked in local verification,
but it requires configuring and supervising another registry. Rootfs-path
creation is the simpler steady-state contract when native BoxLite supports it.

### D3. Add `CAP_SANDBOX_IMAGE_DELIVERY`

The install path will accept `CAP_SANDBOX_IMAGE_DELIVERY=registry|release-assets|auto`.
`registry` preserves today's behavior. `release-assets` fails if the required
asset is unavailable or invalid. `auto` prefers Release assets for BoxLite and
uses the first valid provider/platform asset from the manifest, with clear
fallback logging when it uses registry delivery.

This keeps existing deployments and emergency rollback simple while making the
new path explicit and testable.

### D4. Extend BoxLite config with rootfs paths, not image overloading

BoxLite configuration will add `BOXLITE_ROOTFS_PATH` and
`BOXLITE_ROOTFS_PATH_MAP`, parallel to `BOXLITE_IMAGE` and `BOXLITE_IMAGE_MAP`.
Runtime resolution chooses either an image source or a rootfs source; exactly one
default runtime source is required. Native REST create requests use `rootfs_path`
when a rootfs source is selected. Image mode remains unchanged.

This avoids encoding host paths into image strings and gives validation precise
error messages.

### D5. Release verification must cover assets and registry images

The release workflow will keep pushing GHCR images, then a follow-up job will
package and upload sandbox assets. The release script and release checks must
verify both the GHCR image set and the Release asset set so a release cannot pass
while the installer points at missing or mismatched sandbox artifacts.

### D6. Self-update reuses the installer staging contract

Self-update must stage the target version's sandbox runtime before it reports a
successful upgrade. Registry-backed AIO can keep using compose pull; asset-backed
AIO must load the target Docker archive; asset-backed BoxLite must download and
extract the target rootfs and persist the matching env value.

The failed-staging rule is the same as failed image pull: do not recreate the API
before the target sandbox runtime is available.

## Risks / Trade-offs

- BoxLite rootfs-path semantics differ across BoxLite versions -> native
  readiness probes must verify create/start/exec from `rootfs_path` before CAP
  advertises the provider.
- Release asset downloads may be interrupted -> use resumable downloads,
  temporary files, checksum verification, and atomic rename/extract.
- Host disk usage increases -> print required/available disk context and delete
  compressed AIO archives after successful `docker load` unless caching is
  requested.
- Asset mode can drift from GHCR mode -> release verification and provider story
  tests must exercise both registry and asset delivery.
- `cap-rest` may not understand rootfs paths -> fail clearly in rootfs mode
  unless the adapter explicitly implements equivalent behavior.

## Migration Plan

1. Ship asset publication and verification without changing default behavior.
2. Add quick-deploy staging behind `CAP_SANDBOX_IMAGE_DELIVERY`.
3. Add BoxLite rootfs config and native provider support.
4. Enable `auto` to prefer assets for BoxLite after local native verification.
5. Extend self-update to preserve the selected staging mode.

Rollback is straightforward: set `CAP_SANDBOX_IMAGE_DELIVERY=registry` and keep
using the existing GHCR image path.

## Open Questions

- Whether `auto` should use Release assets for Linux/AIO by default immediately
  or keep registry as the default until AIO archive load has more field runtime.
- Whether the BoxLite asset should be a raw OCI layout, a BoxLite-specific rootfs
  layout, or both if native BoxLite compatibility requires it.
- Whether to retain downloaded compressed assets for offline rollback or delete
  them after successful staging by default.
