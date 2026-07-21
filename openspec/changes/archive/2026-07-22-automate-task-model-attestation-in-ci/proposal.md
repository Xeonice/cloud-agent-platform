# Proposal: automate-task-model-attestation-in-ci

## Why

`/v1/runtime-models/query` recurrently returns 503 because the `task-model-selection-v1` gate is default-closed and its deployment attestation is bound to `buildIdentity` (`GIT_SHA` baked into the image): every upgrade mints a new build identity, silently invalidating the manually-produced attestation, and re-attestation today is a manual runbook (`deploy/TASK_MODEL_SELECTION_CUTOVER.md`) that nobody re-runs. The fix is the industry-standard one (GitHub artifact attestations, TUF, electron-updater): CI regenerates the attestation per release as a release asset, and both upgrade seams (upgrade.sh and in-app self-update) consume it automatically after local preflight — so renewal simply rides the upgrade.

## What Changes

- **CI produces a per-release attestation asset.** release.yml (in or beside the existing `attach-run-assets` job) generates `cap-task-model-attestation-<version>.json` + `.sha256` after image identity is final, with `buildIdentity` derived from the same `GIT_SHA` build-arg baked into the api image (guarding against SHA-context drift). The asset follows the existing `release-image-assets.mjs` naming/checksum discipline and the `releases/download/<target>/<asset>` fetch convention; the CF release-cache Worker is deliberately NOT widened.
- **Honesty split (builder vs. verifier).** CI attests only what it witnessed: `buildIdentity` and `compatibilityChecksPassed` — the latter verified against the release commit's actual "task model N-1 compatibility" check-run status, not assumed. The four deployment-time booleans (`databaseMigrationComplete`, `writeIngressClosedDuringCutover`, `mcpWritersDisabledDuringCutover`, `legacyWorkersRemoved`) are asserted by the consumer side only after local prechecks prove them — structurally true for a single-instance stop-the-world compose upgrade.
- **Attestation shape is the codified single-instance convention.** Exactly one instanceId (`cap-api-1`, matching `docker-compose.prod.env.example` and quick-deploy) with the four role reports (`api`, `admission`, `scheduler`, `runtime`), build-time `reportedAt`, and a generous `expiresAt` (validity is bound to the artifact via buildIdentity match, not the wall clock — a short TTL with no automated renewal is exactly what produced the recurring 503).
- **upgrade.sh (manual path) consumes the asset.** Downloads + checksum-verifies the attestation for the target version, runs local preconditions (single api instance, no N-1 cap containers, `CAP_INSTANCE_ID` unset or exactly `cap-api-1` — fail closed with a clear message on mismatch), writes `CAP_TASK_MODEL_SELECTION_ENABLED` / `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` in the step-1 `.env` rewrite, and extends the post-upgrade smoke with "catalog query no longer 503s".
- **In-app self-update (auto path) does the same.** Reuses the existing release-asset staging and atomic `.env` KEY=VALUE persist seam (same pattern as the CAP_VERSION pin), with the same local prechecks via the updater's cap-container enumeration; pinned `self-update.spec.ts` script assertions updated in lockstep.
- **No gate/schema/semantics changes.** `evaluateTaskModelSelectionGate`, `verifyLocalProcess`, and the contracts attestation schema are untouched; the legacy-worker-fence requirement and the multi-instance manual runbook remain authoritative. The CI path is documented as a single-instance alternative in `TASK_MODEL_SELECTION_CUTOVER.md` / `DEPLOY.md`, not a replacement.
- **Signing is an explicit non-goal (decision, not omission).** The attestation env var and the release asset live in the same trust domain as `.env` itself; structural validation + sha256 checksum suffice for the single-instance path. Cryptographic (Sigstore) signing is recorded as a considered-and-deferred alternative in design.md.
- **Out of scope:** frontend changes (the selector already degrades non-blockingly to the runtime default), the sibling task-admission v2 gate (mechanism is shaped for later reuse but this change touches only task-model-selection), and offline/bridged hosts that cannot reach GitHub release assets.

## Capabilities

### New Capabilities

(none — the mechanism lands as requirement deltas on existing capabilities)

### Modified Capabilities

- `release-and-versioning`: releases MUST additionally publish a per-release task-model-selection attestation asset (+ checksum) whose `buildIdentity` matches the released images' baked `GIT_SHA`, with `compatibilityChecksPassed` set only from the release commit's verified N-1 compat check-run; release verification fails if images are present but the attestation asset is missing/invalid.
- `self-hostable-deployment`: the scripted manual upgrade MUST fetch and checksum-verify the target version's attestation asset, run local single-instance preconditions before writing the gate env keys (fail closed on precondition mismatch without breaking the rest of the upgrade), and the post-upgrade verification MUST include a task-model catalog query success check.
- `self-update-action`: in-app self-update MUST stage the attestation asset for the target version and atomically persist the gate env keys alongside the CAP_VERSION pin, gated on the same local preconditions; on precondition failure it MUST skip attestation writeback with a surfaced reason rather than fail the whole update.
- `runtime-model-catalog`: ADDs a requirement that single-instance deployments upgraded through either official seam have the `task-model-selection-v1` gate open with a valid, build-matched attestation (no recurring 503 across upgrades); the existing "Explicit model selection is fenced from legacy workers" requirement and its scenarios survive unchanged.

## Impact

- **CI/CD:** `.github/workflows/release.yml` (new attestation generation/upload step + check-run verification of the release commit's compat job); `scripts/release-image-assets.mjs` conventions reused (possible new sibling generator script).
- **Scripts:** `scripts/upgrade.sh` (asset fetch, prechecks, `.env` writeback, smoke extension); `scripts/quick-deploy.sh` untouched except where it already normalizes the gate env keys.
- **Backend:** `apps/api/src/self-update/self-update.service.ts` (asset staging + precheck + env persist) and its pinned-script test assertions in `self-update.spec.ts`. No changes to `apps/api/src/runtime-models/*` gate evaluation or `packages/contracts/src/task-model-capability.ts`.
- **Docs:** `deploy/TASK_MODEL_SELECTION_CUTOVER.md` (CI-attested single-instance path documented as alternative), `deploy/DEPLOY.md`, release skill (`release-pr-bundle`) per the add-release-upgrade-scripts precedent.
- **Not affected:** CF release-cache Worker (`apps/release-cache-worker`), frontend console, gate evaluator/schema, multi-instance semantics, task-admission v2 gate (future reuse only).
