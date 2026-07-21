<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: attestation-generator (depends: none)

- [x] 1.1 Create `scripts/generate-task-model-attestation.mjs` sibling to `release-image-assets.mjs`: takes version + `GIT_SHA` (buildIdentity) + a verified-compat flag as inputs and emits `cap-task-model-attestation-<version>.json` + `.sha256` following the existing naming/checksum discipline
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"
- [x] 1.2 Encode the codified single-instance shape: exactly one instanceId `cap-api-1`, four role reports (`api`, `admission`, `scheduler`, `runtime`) each `ready:true` with matching buildIdentity, build-time `reportedAt`, generous `expiresAt` constant; set ONLY `compatibilityChecksPassed` from input — never the four deployment-time booleans (honesty split, D1)
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset", "release-and-versioning/compatibilitycheckspassed-is-set-only-from-verified-check-run-evidence"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"
- [x] 1.3 Validate generator output against the existing contracts attestation schema (`packages/contracts/src/task-model-capability.ts`) without modifying the schema
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset"]
  - surfaces: ["developer-workflow"]
  - verify: "contracts-registry"
- [x] 1.4 Add `scripts/generate-task-model-attestation.test.mjs`: shape/schema validity, sha256 correctness, buildIdentity binding to the input SHA, deployment-time booleans absent/false, `reportedAt` not in the future
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset", "release-and-versioning/compatibilitycheckspassed-is-set-only-from-verified-check-run-evidence"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "public-surface-fast"

## 2. Track: release-workflow (depends: attestation-generator)

- [x] 2.1 In `.github/workflows/release.yml`, add a check-run verification step that queries (via `gh api`) the release commit's "task model N-1 compatibility" check-run and fails the attestation step if it is absent or unsuccessful (never assumed from workflow adjacency)
  - requirements: ["release-and-versioning/compatibilitycheckspassed-is-set-only-from-verified-check-run-evidence"]
  - surfaces: ["ci"]
  - verify: "public-surface-fast"
- [x] 2.2 Invoke the generator in/beside the existing `attach-run-assets` job after image identity is final, deriving `GIT_SHA` from the same `resolve-release` source of truth passed as the api image build-arg; add a workflow-level assertion that the attested buildIdentity equals that build-arg (SHA-context drift guard)
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset"]
  - surfaces: ["ci"]
  - verify: "public-surface-fast"
- [x] 2.3 Upload `cap-task-model-attestation-<version>.json` + `.sha256` as release assets via the existing upload path; make release verification fail-closed when images are present but the attestation asset is missing or checksum/schema-invalid
  - requirements: ["release-and-versioning/releases-publish-a-build-matched-task-model-selection-attestation-asset", "release-and-versioning/release-verification-fails-when-images-are-present-but-the-attestation-asset-is-missing-or-invalid"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "public-surface-fast"
- [x] 2.4 Update any pinned workflow/asset-list test expectations (`scripts/release-image-gates.test.mjs`, `scripts/release-tail.test.mjs`) to cover the new asset and the fail-closed verification
  - requirements: ["release-and-versioning/release-verification-fails-when-images-are-present-but-the-attestation-asset-is-missing-or-invalid"]
  - surfaces: ["ci", "developer-workflow"]
  - verify: "public-surface-fast"

## 3. Track: upgrade-script (depends: attestation-generator)

- [x] 3.1 In `scripts/upgrade.sh`, download + sha256-verify `cap-task-model-attestation-<version>.json` for the target version via the existing `releases/download/<target>/<asset>` convention with `CAP_RELEASE_ASSET_BASE` override; treat 404 as "no attestation available" (skip writeback with reason, pre-change UX)
  - requirements: ["self-hostable-deployment/the-manual-upgrade-script-consumes-the-release-attestation-behind-fail-closed-local-preconditions"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"
- [x] 3.2 Add local single-instance preconditions before writeback: single api instance, no N-1 cap containers, `CAP_INSTANCE_ID` unset or exactly `cap-api-1`; on mismatch fail closed on the attestation writeback only, with an actionable message pointing to the manual runbook, without breaking the rest of the upgrade
  - requirements: ["self-hostable-deployment/the-manual-upgrade-script-consumes-the-release-attestation-behind-fail-closed-local-preconditions"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"
- [x] 3.3 Write `CAP_TASK_MODEL_SELECTION_ENABLED` / `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` in the existing step-1 `.env` rewrite
  - requirements: ["self-hostable-deployment/the-manual-upgrade-script-consumes-the-release-attestation-behind-fail-closed-local-preconditions"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"
- [x] 3.4 Extend the post-upgrade smoke with a task-model catalog success check using the existing `GET /deployment-capabilities/task-model-selection-v1` diagnostics endpoint (catalog query no longer 503s)
  - requirements: ["self-hostable-deployment/post-upgrade-verification-includes-a-task-model-catalog-success-check", "runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases"]
  - surfaces: ["developer-workflow"]
  - verify: "public-surface-fast"

## 4. Track: self-update (depends: attestation-generator)

- [x] 4.1 In `apps/api/src/self-update/self-update.service.ts`, stage the attestation asset for the target version via the existing release-asset staging path (checksum-verified); 404 → skip with surfaced reason
  - requirements: ["self-update-action/self-update-stages-the-attestation-asset-and-persists-the-gate-env-keys-with-the-version-pin"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 4.2 Run the same single-instance prechecks via the updater's existing cap-container enumeration (single api instance, no N-1 cap containers, `CAP_INSTANCE_ID` unset or `cap-api-1`); on precondition failure skip attestation writeback with a surfaced reason in the update result — never fail the whole update
  - requirements: ["self-update-action/attestation-writeback-failures-degrade-the-update-not-fail-it"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 4.3 Atomically persist `CAP_TASK_MODEL_SELECTION_ENABLED` / `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` alongside the `CAP_VERSION` pin using the existing grep-v + mv KEY=VALUE env-persist helper
  - requirements: ["self-update-action/self-update-stages-the-attestation-asset-and-persists-the-gate-env-keys-with-the-version-pin", "runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases"]
  - surfaces: ["developer-workflow"]
  - verify: "api-mcp"
- [x] 4.4 Update pinned script assertions in `apps/api/src/self-update/self-update.spec.ts` in lockstep and add tests for: successful writeback, precondition-skip with reason, missing-asset skip with reason, checksum failure
  - requirements: ["self-update-action/pinned-updater-script-assertions-cover-attestation-staging-in-lockstep"]
  - surfaces: ["developer-workflow", "ci"]
  - verify: "api-mcp"

## 5. Track: docs-and-release-skill (depends: none)

- [x] 5.1 Update `deploy/TASK_MODEL_SELECTION_CUTOVER.md`: document the CI-attested single-instance path as an alternative (not a replacement); manual runbook stays authoritative for multi-instance and custom `CAP_INSTANCE_ID` deployments
  - requirements: ["runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 5.2 Update `deploy/DEPLOY.md`: gate env keys, diagnostics acceptance check, and the one-release chicken-and-egg lag (first upgrade to N runs the old path; gate opens N→N+1 for in-app self-update)
  - requirements: ["runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases"]
  - surfaces: ["docs"]
  - verify: "docs"
- [x] 5.3 Update the `release-pr-bundle` release skill to account for the new attestation asset in the release flow (per add-release-upgrade-scripts precedent)
  - requirements: ["runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases"]
  - surfaces: ["docs"]
  - verify: "docs"
