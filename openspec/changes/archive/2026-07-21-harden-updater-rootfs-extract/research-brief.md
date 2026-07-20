# Research Brief — harden-updater-rootfs-extract

Serial research pass (2026-07-21), grounded in a live incident on the
vibe-zlyan self-hosted deployment (macOS + colima Docker) with a controlled
reproduction.

## Incident evidence (firsthand)

Five self-update attempts to v0.42.1 on vibe-zlyan. After clearing three
environment obstacles (target images not yet built; `docker:27-cli` unpullable
without a registry mirror; GitHub release assets unreachable — bridged with a
containerized loopback asset mirror + `CAP_RELEASE_ASSET_BASE`), the updater
finally reached the BoxLite staging extraction and died there every time:

- The verified asset downloaded and checksummed OK (mirror logs + manifest
  checks all passed).
- `sandbox-assets/boxlite/cap-boxlite-sandbox/v0.42.1/linux-arm64/` contained
  only a stale `oci.captmp.36` temp dir; the final `oci` dir, the
  `BOXLITE_ROOTFS_PATH` write-back, the `CAP_VERSION` pin, and pull/up never
  happened.
- Controlled repro (same image, same mounts, no `--rm`):
  `tar: ./oci-layout: Cannot change ownership to uid 1001, gid 1001: Permission denied`
  (repeated for every entry). With `set -eu` + `set -o pipefail` in
  `commonSandboxAssetShell`, the staging pipeline aborts.

## Root cause (verified in code)

`buildBoxLiteAssetStagingScript` (apps/api/src/self-update/self-update.service.ts)
runs, inside the updater container as root:

```
cap_stream_asset "$asset_source" | zstd -dc | tar -C "$tmp_dir" -xf -
```

tar running as root defaults to restoring the archive's recorded owner
(uid/gid 1001 from the image build). The extraction target is a **host bind
mount**; on macOS/colima (and other VM file-sharing stacks: virtiofs, sshfs,
Docker Desktop gRPC-FUSE in some modes) `chown` on the shared mount is
forbidden → `EPERM` → pipeline aborts → staging fails **before** any service
recreate (the fail-closed ordering worked as designed; the stack stayed on the
prior version throughout).

Why it never surfaced before: this host's earlier stagings (v0.37.2→v0.41.3
dirs all present) were done by host-side quick-deploy scripts running natively
on macOS — the updater-container extraction path had simply never run on a
shared-mount host.

## Fix mechanics (verified against both tars)

- Ownership restore is pure baggage here: the extracted rootfs is read back by
  BoxLite as whatever user owns the host directory; nothing consumes the
  archive's uid/gid 1001.
- The updater image is `docker:27-cli` → **busybox tar**. `cap_prepare_asset_tools`
  installs GNU tar via `apk add tar` only when `tar` is missing (busybox
  provides it, so usually not). The flag must therefore work on BOTH:
  - busybox tar: `-o` — "Don't restore user:group ownership"; it also accepts
    the GNU long form `--no-same-owner` in current busybox (1.36+), but `-o` is
    the documented stable spelling.
  - GNU tar: extract-mode `-o` is defined as an alias of `--no-same-owner`.
  - → use short `-o` (portable across both), optionally with a comment naming
    the long form.
- Stale temp accumulation: `tmp_dir="$rootfs_dir.captmp.$$"` + `rm -rf "$tmp_dir"`
  only removes the CURRENT pid's dir; every failed attempt leaves its own
  `oci.captmp.<pid>` behind (observed: `oci.captmp.36`). A pre-staging sweep of
  `"$rootfs_dir".captmp.*` bounds the garbage.
- AIO staging (`zstd -dc | docker load`) writes no files to the mount — not
  affected, no change needed there.

## Existing test surface

`apps/api/src/self-update/self-update.spec.ts` pins the staging pipeline text:

- line ~558: `plan.script.includes('cap_stream_asset "$asset_source" | zstd -dc | tar -C "$tmp_dir" -xf -')`
  → must be updated in lockstep with the script change, and extended to assert
  the ownership flag and the stale-temp sweep are present.

## Key design constraints

1. `-o` must be placed in extract mode (`tar -C "$tmp_dir" -o -xf -` or
   `-xof -`) — spelling must match what both busybox and GNU accept.
2. The sweep must run before `mkdir -p "$tmp_dir"` and use the same
   `"$rootfs_dir".captmp.` prefix so unrelated siblings are untouched.
3. No behavior change for registry-delivery deployments (script builder returns
   null there) and none for AIO asset staging.

## Task 1.3 evidence (2026-07-21, vibe-zlyan)

Fixed pipeline replayed on the incident host — same `docker:27-cli` image,
same colima shared mount, `sh -euc` + `set -o pipefail`, only delta is `-o`:

```
zstd -dc /asset/cap-boxlite-sandbox-v0.42.1-linux-arm64.oci.tar.zst | tar -C /out/repro-fixed -o -xf -
→ EXTRACT-OK   (blobs / index.json / oci-layout present)
```

Pre-fix control (2026-07-21, same setup, no `-o`): every entry emitted
`tar: Cannot change ownership to uid 1001, gid 1001: Permission denied`.
Also proves busybox tar in `docker:27-cli` accepts `-o` in extract mode.
