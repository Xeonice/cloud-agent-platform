# Verification Report — automate-task-model-attestation-in-ci

Pass date: 2026-07-22
Adjudicated tally: 9/9 requirements MET · 0 reopened code tasks · 0 spec defects · 0 blocking spec defects

## Three-way routing outcome

| Route | Count | IDs |
| --- | --- | --- |
| UNMET (verify-reopened code tasks) | 0 | — |
| SPEC-DEFECT (design.md Open Questions) | 0 | — |
| MET (folded here) | 1 high-risk dynamic + 8 static-traced | see below |

Mandatory machine-routed public findings: none (`[]`). No undeclared public impact, no false protocol exclusions — the sidecar claim stands.

## High-risk requirement re-traced end-to-end as MET

### runtime-model-catalog/official-upgrade-seams-keep-the-single-instance-gate-open-across-releases

**Requirement** (specs/runtime-model-catalog/spec.md:5-30): official upgrade seams (manual `scripts/upgrade.sh` + in-app self-update) end an upgrade with the `task-model-selection-v1` gate open on single-instance deployments, renewal rides each upgrade, stale/bypassed-seam attestations fail closed, and non-single-instance deployments keep the fence and manual runbook — all without modifying `evaluateTaskModelSelectionGate`, `verifyLocalProcess`, or the contracts schema.

**Static trace (both seams + docs), re-confirmed against the working tree:**

- Manual seam — `scripts/upgrade.sh`: fetch + sha256-verify `cap-task-model-attestation-<VERSION>.json` (lines 73-126); three single-instance preconditions — single api instance, no stray N-1 cap containers, `CAP_INSTANCE_ID` unset-or-`cap-api-1` (lines 139-182); atomic `.env` rewrite of `CAP_TASK_MODEL_SELECTION_ENABLED` / `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` alongside the `CAP_VERSION` pin in the same writeback (lines 201-219); any 404/checksum/precondition failure skips only the writeback with a surfaced reason and pointer to the manual runbook (lines 95-126, 184-199). Post-upgrade gate smoke hits `GET /deployment-capabilities/task-model-selection-v1` and **fails the upgrade** if the writeback happened but the gate is not open (lines 281-314) — Scenario 1 verified directly; re-fetch per target VERSION on every run gives Scenario 2 (renewal rides the upgrade, no manual re-attestation).
- In-app seam — `apps/api/src/self-update/self-update.service.ts`: same asset/env-key constants and `TASK_MODEL_ATTESTATION_INSTANCE_ID = 'cap-api-1'` (lines 94-104); `evaluateTaskModelAttestationPreconditions` before planning (line 395, definition at 824-844); generated updater script stages + checksum-verifies the asset and persists both env keys atomically with the `CAP_VERSION` pin only when preconditions pass, else skips with a named reason surfaced in the update result without failing the update (staging/persist blocks around lines 486-544, 763-844).
- Tests — `apps/api/src/self-update/self-update.spec.ts` (~30 attestation assertions, lines 719-925): passing preconditions → atomic writeback; second api instance / stray N-1 container / non-default `CAP_INSTANCE_ID` → skip with reason (Scenario 4); missing asset (404) → skip; checksum-failed asset → never persisted.
- Constraint honored: `evaluateTaskModelSelectionGate` / `verifyLocalProcess` / contracts schema untouched — the buildIdentity match is still enforced at read time by the unmodified evaluator, which is exactly what makes Scenario 3 hold.
- Docs — `deploy/TASK_MODEL_SELECTION_CUTOVER.md:13-44` keeps the manual runbook authoritative for multi-instance/custom-instance-id deployments (Scenario 4); `deploy/DEPLOY.md` §11.6 (lines 545-589) documents the gate env keys, the diagnostics acceptance check, and the one-release chicken-and-egg lag (N runs old path, gate opens N→N+1).

**Dynamic re-trace (skeptic refutation attempt — FAILED to refute, corroborates MET):**

`apps/api/test/task-model-official-upgrade-seam-gate.test.mjs` exercises the real, unmodified production code (`scripts/generate-task-model-attestation.mjs` `buildAttestation()` + compiled `TaskModelCapabilityService` + `@cap/contracts` `evaluateTaskModelSelectionGate` — no reimplementation, no hardcoding) across three scenarios in one flow:

1. Upgrade to release vA (buildIdentity=SHA_A, `CAP_INSTANCE_ID=cap-api-1`, `GIT_SHA=SHA_A`): gate open, all 4 role reports verified, `assertOpen()` does not throw — no 503.
2. Upgrade to release vB (buildIdentity=SHA_B, `GIT_SHA=SHA_B`): gate open again with zero manual re-attestation — renewal rides the seam.
3. Bypassed seam (keep vB attestation, `GIT_SHA=SHA_C`): gate closed with reason `worker_not_ready`, `assertOpen()` throws — buildIdentity match actually gates renewal rather than passing vacuously.

Re-run during this routing pass: `node --test --test-force-exit test/task-model-official-upgrade-seam-gate.test.mjs` → **1 pass, 0 fail** (2026-07-22).

**Verdict: MET.** Both tracks plus docs implement the requirement; the stale-attestation fail-closed guarantee holds against the actual gate evaluator.

## Remaining eight requirements — static trace summary (all MET)

- **release-and-versioning** (3): attestation generation (`scripts/generate-task-model-attestation.mjs` + its test), check-run verification / drift-guard assertion / asset upload from the single `resolve-release` GIT_SHA (`.github/workflows/release.yml`), and fail-closed release verification against the published `cap-api` image's baked GIT_SHA (`scripts/release.sh` + `scripts/release-tail.test.mjs`). `compatibilityChecksPassed` is set only from verified check-run evidence — the generator rejects unknown/deployment-time-boolean inputs, per the honesty-split requirement.
- **self-hostable-deployment** (2): `scripts/upgrade.sh` implements asset download/checksum verify, the three named single-instance preconditions, fail-closed-on-writeback-only behavior, atomic `.env` persist, and the post-upgrade gate smoke (detail above).
- **self-update-action** (3): `self-update.service.ts` implements staging, preconditions via `listCapContainers`, atomic persist alongside `CAP_VERSION`, and skip-with-reason degrade-not-fail semantics, with matching pinned updater-script assertions in `self-update.spec.ts` in lockstep.
- **runtime-model-catalog** (1): the high-risk requirement above.

## Gap analysis (requirements with no traceable implementation)

Based on tracing every ADDED requirement in the four spec deltas against the actual codebase, all nine requirements have concrete, working implementations:

- `release-and-versioning`: attestation generation (`scripts/generate-task-model-attestation.mjs`), check-run verification and drift-guard assertion (`.github/workflows/release.yml`), and fail-closed release verification (`scripts/release.sh` + `scripts/release-tail.test.mjs`) all exist and match the spec.
- `self-hostable-deployment`: `scripts/upgrade.sh` implements asset download/checksum verify, the three single-instance preconditions, the atomic `.env` writeback, and the post-upgrade gate-smoke check.
- `self-update-action`: `apps/api/src/self-update/self-update.service.ts` implements staging, preconditions, atomic persist alongside `CAP_VERSION`, and skip-with-reason degrade-not-fail behavior, with matching pinned assertions in `self-update.spec.ts`.
- `runtime-model-catalog`: covered jointly by the upgrade.sh smoke check, self-update persist, unchanged `evaluateTaskModelSelectionGate` (verified still present in `apps/api/src/runtime-models/task-model-capability.service.ts`), and doc updates in `deploy/TASK_MODEL_SELECTION_CUTOVER.md` / `deploy/DEPLOY.md`.

One minor task-level gap was found (task 5.3, updating the external `release-pr-bundle` skill, has no corresponding file in this repo/worktree), but since that requirement's behavior is already substantively implemented via other tasks (upgrade.sh + self-update.service.ts + docs), it does not constitute a requirement with zero traceable implementation — at most an incomplete peripheral task under an otherwise-implemented requirement. This is a met-as-written minor gap that does not block the primary scenario, and it does not reopen a code task.

No requirement lacks implementation entirely.

## Scope analysis (implemented behavior with no covering requirement)

None found. Line-by-line review of every changed/added file against the four spec deltas:

- `scripts/generate-task-model-attestation.mjs` + its test — matches "releases publish a build-matched attestation" + "compatibilityChecksPassed set only from verified check-run evidence" (rejects unknown/deployment-time-boolean inputs, exactly as the honesty-split requirement demands).
- `.github/workflows/release.yml` diff — check-run verification step, generator invocation from the single `resolve-release` GIT_SHA, drift-guard assertion, and asset upload — all map to the same two ADDED requirements.
- `scripts/release.sh` diff — fail-closed verification (missing/checksum/schema/buildIdentity-mismatch) against the actual published `cap-api` image's baked GIT_SHA — maps to "release verification fails when images are present but the attestation asset is missing or invalid."
- `scripts/upgrade.sh` diff — asset fetch/checksum, the three named single-instance preconditions, fail-closed-on-writeback-only behavior, atomic `.env` persist, and the post-upgrade gate smoke — maps 1:1 to the two self-hostable-deployment requirements.
- `apps/api/src/self-update/self-update.service.ts` + `.spec.ts` diffs — staging, same preconditions via `listCapContainers`, atomic persist alongside `CAP_VERSION`, skip-with-reason-never-fail semantics, pinned script assertions — maps to all three self-update-action requirements.
- `apps/api/test/task-model-official-upgrade-seam-gate.test.mjs` (new) — exercises exactly the three scenarios of the runtime-model-catalog requirement, using the unmodified gate evaluator.
- `deploy/DEPLOY.md`, `deploy/TASK_MODEL_SELECTION_CUTOVER.md` diffs — documentation-only, tied to the same runtime-model-catalog requirement; no new code behavior.
- `.github/workflows/ci.yml` diff — one line wiring the new test into CI, no independent behavior.
- Confirmed untouched (as the proposal declares out-of-scope/unaffected): `packages/contracts/src/task-model-capability.ts`, `apps/api/src/runtime-models/*`, `scripts/quick-deploy.sh`, `docker-compose.prod.yml`, frontend/console, and the CF release-cache Worker.

The change is unusually tightly scoped — every task in `tasks.md` carries an explicit `requirements:` back-reference, and the diffs honor those references without additional surface area (no new CLI flags, env vars, endpoints, or schema fields beyond what's specified).

## Archive gate

- Blocking spec defects: none. Public-surface sidecar claims verified consistent with the diff.
- Reopened code tasks: none.
- Verdict: PASS — change is archive-eligible from this verification pass's perspective.
