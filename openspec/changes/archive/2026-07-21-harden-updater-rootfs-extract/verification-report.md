# Verification Report: harden-updater-rootfs-extract

Routing pass: 2026-07-21 (second pass). Tally: 1 requirement re-traced as MET; 0 verify-reopened code tasks; 0 spec defects; 0 blocking spec defects. The prior pass's four machine-routed `undeclared-impact` blockers are resolved (see "Archive gate" below); this pass's machine-routed finding list is empty.

## MET requirements

### self-update-action/sandbox-asset-extraction-is-portable-across-shared-mount-hosts — MET (re-traced end-to-end)

Independent re-trace against the working tree confirms every clause of the requirement:

- **Ownership restore disabled** — `buildBoxLiteAssetStagingScript` (`apps/api/src/self-update/self-update.service.ts:519`) extracts via `cap_stream_asset "$asset_source" | zstd -dc | tar -C "$tmp_dir" -o -xf -`; the comment at lines 515-518 names `-o` as the busybox+GNU spelling of `--no-same-owner`. Satisfies scenario "Extraction succeeds on a chown-restricted shared mount".
- **Stale-temp sweep before staging** — `rm -rf "$rootfs_dir".captmp.*` at line 511 runs before the per-pid `tmp_dir` reset/`mkdir` at lines 512-514; the glob is anchored to this version's rootfs path so sibling versions and the live `oci` dir are untouched (comment lines 508-510). Satisfies scenario "Stale temp directories from failed attempts are swept".
- **Fail-closed ordering preserved** — the script runs under `sh -eu` + `set -o pipefail` (lines 492/529 wrapper, `commonSandboxAssetShell` line 541); env write-back (`BOXLITE_ROOTFS_PATH`, `BOXLITE_PROTOCOL_MODE`, lines 522-527) follows only after a successful `mv`, and no compose pull/recreate precedes it.
- **Unit-suite pins** — `apps/api/src/self-update/self-update.spec.ts:557-571` asserts the exact `-o` pipeline text and that `indexOf('rm -rf "$rootfs_dir".captmp.*') < indexOf('mkdir -p "$tmp_dir"')`; lines 576-579 pin env persistence ordering (rootfs env before the `CAP_VERSION` pin). Satisfies scenario "The generated staging script pins both properties". A separate failure-propagation test (spec.ts:532-539) covers abort-before-recreate on the analogous AIO path sharing `commonSandboxAssetShell`.
- **Compiled suite re-run green this pass** — `node --test dist/self-update/self-update.spec.js` executed 2026-07-21: 27/27 pass, 0 fail; the compiled `dist/self-update/self-update.service.js:239` and `dist/self-update/self-update.spec.js:394-395` contain the exact new pipeline text and pins, confirming dist is not stale relative to src.
- **Live-environment evidence** — `research-brief.md:86-98` records the 2026-07-21 vibe-zlyan incident-host replay: same `docker:27-cli` image and colima shared mount, fixed pipeline (`tar -C /out/repro-fixed -o -xf -`) → `EXTRACT-OK` with blobs/index.json/oci-layout present; pre-fix control emitted `tar: Cannot change ownership to uid 1001, gid 1001: Permission denied` on every entry, and the run also proves busybox tar in `docker:27-cli` accepts `-o` in extract mode. This is the recorded dynamic evidence task 1.3 asked for.

All three tasks (1.1-1.3) mapping to this requirement are checked off and correspond to verified code/test/evidence artifacts. Verdict: MET.

## Gap findings

The single requirement in this change's spec (`self-update-action/sandbox-asset-extraction-is-portable-across-shared-mount-hosts`) is traceably implemented — the stale-temp sweep (`rm -rf "$rootfs_dir".captmp.*`) and the ownership-restore-disabling `tar -o -xf -` flag both exist in `buildBoxLiteAssetStagingScript` (apps/api/src/self-update/self-update.service.ts:511-519). No requirement lacks implementation entirely.

```json
[]
```

## Scope findings

```json
[]
```

No scope creep found. Checked `apps/api/src/self-update/self-update.service.ts` and `apps/api/src/self-update/self-update.spec.ts` against `openspec/changes/harden-updater-rootfs-extract/specs/self-update-action/spec.md`. The actual diff (uncommitted, via `git diff`) contains exactly two behavioral changes:

1. `tar -C "$tmp_dir" -o -xf -` (disable ownership restore) — maps to the "no ownership restore" clause of the requirement.
2. `rm -rf "$rootfs_dir".captmp.*` swept before `tmp_dir` creation — maps to the "stale temp directories ... swept" clause.

The spec test additions in `self-update.spec.ts` assert exactly these two properties, matching Scenario 3 ("The generated staging script pins both properties"). No extraneous behavior (e.g., changes to AIO staging, download/verify helpers, env write-back, or fail-closed ordering) was introduced — the diff itself confirms tasks.md's explicit "leave ... untouched" instruction was honored.

## Archive gate

CLEAR. The prior pass's four machine-routed `undeclared-impact` findings (apiPlayground / mcp / openapi / publicV1) stemmed from task `surfaces: ["contracts"]` annotations being read as public-impact claims contradicting the all-not-applicable sidecar; resolved 2026-07-21 by re-tagging tasks with the internal vocabulary (`developer-workflow`), matching `surface-impact.json` (all public surfaces `not-applicable`, `internalOnly` changed) — see design.md "Open Questions". The code diff touches only `apps/api/src/self-update`, outside every public-surface path category, so the all-not-applicable declaration is truthful. This pass's machine-routed and mandatory public finding lists are both empty; no blocking spec defects remain.
