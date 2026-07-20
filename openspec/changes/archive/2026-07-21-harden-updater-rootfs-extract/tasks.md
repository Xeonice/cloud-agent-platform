<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: updater-extract-portability (depends: none)

- [x] 1.1 In `buildBoxLiteAssetStagingScript` (`apps/api/src/self-update/self-update.service.ts`), disable ownership restore in the extraction pipeline using the short flag both busybox tar and GNU tar accept (`tar -C "$tmp_dir" -o -xf -`, with a comment naming the `--no-same-owner` long form), and add a pre-staging sweep `rm -rf "$rootfs_dir".captmp.*` immediately before the existing per-pid temp-dir reset so stale directories from prior failed attempts are removed; leave the AIO staging script, download/verify helpers, env write-back, and fail-closed ordering untouched.
  - requirements: ["self-update-action/sandbox-asset-extraction-is-portable-across-shared-mount-hosts"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 1.2 Update the pinned staging-pipeline assertion in `apps/api/src/self-update/self-update.spec.ts` to the new script text and add regression assertions that the generated BoxLite staging script (a) disables ownership restore in extract mode and (b) contains the stale-temp sweep before the temp-dir creation; run the compiled self-update spec plus the full api compiled suite green.
  - requirements: ["self-update-action/sandbox-asset-extraction-is-portable-across-shared-mount-hosts"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"
- [x] 1.3 Prove the fix against the real failure mode: run the exact extraction pipeline from the generated script inside `docker:27-cli` against a chown-restricted bind mount (the 2026-07-21 vibe-zlyan repro setup, or a local mount with ownership restricted) and show it now extracts cleanly where the pre-fix pipeline emitted "Cannot change ownership ... Permission denied"; record the evidence in the change (verification-report or task notes).
  - requirements: ["self-update-action/sandbox-asset-extraction-is-portable-across-shared-mount-hosts"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
