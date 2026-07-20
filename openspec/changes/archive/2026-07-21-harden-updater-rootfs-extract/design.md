# Design: harden-updater-rootfs-extract

## Context

`buildBoxLiteAssetStagingScript` (apps/api/src/self-update/self-update.service.ts) generates the shell the detached updater container runs: download + verify the BoxLite rootfs asset, then `cap_stream_asset | zstd -dc | tar -C "$tmp_dir" -xf -` into `tmp_dir="$rootfs_dir.captmp.$$"` on a host bind mount, then atomically `mv` into place and persist `BOXLITE_ROOTFS_PATH`. The updater runs as root inside `docker:27-cli` (busybox userland; `cap_prepare_asset_tools` installs GNU tar via apk only if `tar` is absent). Root tar restores archive ownership by default; chown is forbidden on colima/virtiofs-style shared mounts, so extraction aborts under `set -eu -o pipefail`. Each failed attempt leaves its pid-named `oci.captmp.<pid>` behind (observed live). The fail-closed ordering (stage fully before recreate) already behaves correctly and must stay.

## Goals / Non-Goals

**Goals:**
- BoxLite asset staging extracts successfully on chown-restricted shared mounts (macOS/colima and equivalents) and on plain Linux hosts alike.
- Stale temp extraction directories from prior failed attempts are swept before staging.
- The unit suite pins both properties so a future script edit cannot silently regress them.

**Non-Goals:**
- No change to AIO staging (`docker load` writes to the Docker daemon, not the mount), registry-delivery deployments (no staging script), download/verify logic, env write-back, or the fail-closed ordering.
- No attempt to preserve archive uid/gid anywhere — nothing consumes it.
- No updater image or tooling changes.

## Decisions

1. **`tar -o` (short flag), not `--no-same-owner` (long flag).** The updater's tar is busybox (`docker:27-cli`); GNU tar appears only when apk had to install it. Busybox documents `-o` ("don't restore user:group ownership") as its stable spelling, and GNU tar defines extract-mode `-o` as an alias of `--no-same-owner` — the short flag is the one spelling both accept unconditionally. Alternative (long flag) rejected: busybox long-option support varies by version/build config; the incident host is exactly the environment where guessing wrong hurts. A script comment names the long form for readers.
2. **Drop ownership restore unconditionally, not conditionally.** Detecting mount capabilities (trial chown, mount-type sniffing) buys nothing: the extracted rootfs is read back by BoxLite as whatever user owns the host directory, so ownership restore has no consumer on ANY host. Unconditional `-o` makes Linux and macOS hosts byte-identical in behavior.
3. **Pre-staging sweep `rm -rf "$rootfs_dir".captmp.*`** placed immediately before the existing `rm -rf "$tmp_dir"`/`mkdir` pair. The glob is anchored to the exact `"$rootfs_dir".captmp.` prefix, so sibling versions and the live `oci` dir are untouchable; when no stale dirs exist the glob expands to a nonexistent literal and `rm -rf` ignores it. Alternative (sweep at success only) rejected: success already cleans its own dir; the garbage source is precisely the failure path.
4. **Tests pin the contract, not the incident.** Update the existing pinned pipeline assertion to the new text and add two assertions: the extraction pipeline contains ` -o ` in extract mode, and the script contains the stale-temp sweep before `mkdir`. This keeps the portability property regression-locked without needing a colima host in CI.

## Risks / Trade-offs

- [Busybox build without `-o` support] → `docker:27-cli` is the pinned default updater image and its busybox tar documents `-o`; operators overriding `SELF_UPDATE_UPDATER_IMAGE` already own tool compatibility for their image (documented expectation: docker CLI + compose present).
- [Glob sweep deletes a concurrent attempt's temp dir] → Two concurrent updaters were never supported (both would also race `mv` and env write-back); the sweep does not widen that pre-existing exclusion assumption.
- [Extracted files owned by root on Linux hosts where chown previously set 1001] → BoxLite reads the rootfs read-only via the daemon/VM; the prior 1001 ownership was an artifact, not a contract, and staged rootfs dirs from host-side quick-deploy staging already carry host-user ownership on the incident machine — mixed ownership is the status quo that works.

## Migration Plan

Ships in the next release; the fix rides the SAME release it enables people to install, so shared-mount hosts need ONE more manual/assisted upgrade to a version containing this fix — after that, one-click works. No data or env migration; rollback = revert.

## Open Questions

_None blocking. A prior verify run flagged a declaration-consistency defect: task `surfaces: ["contracts"]` annotations were read by the public-surface lens as public-impact claims contradicting the all-not-applicable sidecar (the code diff touches only apps/api/src/self-update). Resolved 2026-07-21 by re-tagging tasks with the internal vocabulary (`developer-workflow`), matching the sidecar; no code change was implied or made._
