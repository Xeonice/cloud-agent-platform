# Proposal: harden-updater-rootfs-extract

## Why

One-click self-update permanently fails at the BoxLite rootfs extraction step on shared-mount Docker hosts (macOS/colima, virtiofs-style VM file sharing): the updater's `tar` runs as root and tries to restore the archive's recorded uid/gid onto a bind mount that forbids `chown`, so `set -o pipefail` aborts staging every attempt — reproduced and root-caused on a live deployment on 2026-07-21, where the upgrade had to be completed by hand.

## What Changes

- The BoxLite release-asset staging extraction stops restoring archive ownership (`tar -o`, the spelling both busybox tar in `docker:27-cli` and GNU tar accept as `--no-same-owner`): the extracted rootfs is consumed by BoxLite as-is, so archive uid/gid restore was pure baggage that only shared-mount hosts punish.
- Staging sweeps stale `oci.captmp.<pid>` temp directories left by previously failed attempts before creating its own, so failed upgrades no longer accumulate garbage next to the rootfs.
- The pinned staging-script assertions in the self-update unit suite are updated in lockstep and extended to lock in the ownership flag and the stale-temp sweep.
- Fail-closed ordering is untouched: staging still completes (or fails) entirely before any CAP service is recreated.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `self-update-action`: sandbox asset staging gains a portability requirement — rootfs extraction must succeed on chown-restricted shared mounts (no ownership restore) and must clean up stale temp extraction directories from prior failed attempts.

## Impact

- `apps/api/src/self-update/self-update.service.ts` — `buildBoxLiteAssetStagingScript` only (AIO's `docker load` path writes no files to the mount and is unaffected; registry-delivery deployments build no staging script at all).
- `apps/api/src/self-update/self-update.spec.ts` — pinned script text updated + new assertions.
- No Public V1 / MCP / OpenAPI / Playground surface changes (internal updater script text; see `surface-impact.json`).
