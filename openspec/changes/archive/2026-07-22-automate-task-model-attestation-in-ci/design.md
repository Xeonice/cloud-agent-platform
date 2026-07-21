# Design: automate-task-model-attestation-in-ci

## Context

`/v1/runtime-models/query` recurrently 503s because the `task-model-selection-v1` gate is default-closed and its attestation is bound to `buildIdentity` (`GIT_SHA` baked into the api image at build time). Every release mints a new build identity, silently invalidating the previously hand-produced attestation; re-attestation is a manual runbook (`deploy/TASK_MODEL_SELECTION_CUTOVER.md`) that nobody re-runs. Confirmed ground truth (research brief C1–C2): `verifyLocalProcess` requires `report.buildIdentity === process GIT_SHA`, and no bypass path exists — the gate opens only via `CAP_TASK_MODEL_SELECTION_ENABLED` + `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON`.

The industry-standard fix (GitHub artifact attestations, TUF, electron-updater — brief W1/W3/W6) is per-release regeneration: CI produces the attestation as a release asset, and both upgrade seams (upgrade.sh, in-app self-update) consume it automatically after local preflight. All required seams already exist in this repo: release.yml's `attach-run-assets` job, the `release-image-assets.mjs` naming/checksum discipline, the `releases/download/<target>/<asset>` fetch convention, upgrade.sh's step-1 `.env` rewrite, and self-update's atomic KEY=VALUE env-persist helper (brief C7–C9).

Constraints: the gate evaluator, `verifyLocalProcess`, and the contracts schema must not change; multi-instance semantics (the legacy-worker fence from archived change 2026-07-14-add-task-model-selection) remain authoritative; the CF release-cache Worker must not be widened (archive precedent A5).

## Goals / Non-Goals

**Goals:**

- Single-instance deployments upgraded through either official seam (upgrade.sh or in-app self-update) end up with the gate open and a valid, build-matched attestation — no recurring 503 across upgrades.
- CI attests only what it witnessed (buildIdentity + verified compat check-run); deployment-time facts are asserted consumer-side only after local prechecks prove them.
- Release verification fails if images are present but the attestation asset is missing/invalid (fail-closed, per 2026-06-30-release-asset-sandbox-images precedent).
- The mechanism's shape (asset naming, buildIdentity binding, consumer prechecks) is reusable later by the sibling task-admission v2 gate.

**Non-Goals:**

- No changes to `evaluateTaskModelSelectionGate`, `verifyLocalProcess`, or `packages/contracts/src/task-model-capability.ts`.
- No cryptographic (Sigstore) signing — see Decision 6.
- No frontend changes (the selector already degrades non-blockingly to the runtime default).
- No multi-instance automation — the manual runbook stays authoritative for multi-instance.
- No CF release-cache Worker changes; no support for offline/bridged hosts that cannot reach GitHub release assets (vibe-zlyan-class hosts keep their local bridge workflow).
- No changes to the task-admission v2 gate in this change (reuse is a shaping concern only).

## Decisions

### D1. Builder/verifier honesty split (in-toto/SLSA VSA model)

CI attests only two facts it can witness: `buildIdentity` (derived from the same `GIT_SHA` build-arg baked into the api image — never from a separately-resolved SHA context, guarding against metadata-action-style drift, brief W11/C2) and `compatibilityChecksPassed` — the latter set only after verifying via `gh api` that the release commit's "task model N-1 compatibility" check-run actually succeeded, not assumed from workflow adjacency (release.yml triggers on release:published; the compat job lives in ci.yml on the merged commit, brief C9). The four deployment-time booleans (`databaseMigrationComplete`, `writeIngressClosedDuringCutover`, `mcpWritersDisabledDuringCutover`, `legacyWorkersRemoved`) are asserted by the consumer (upgrade.sh / self-update preflight) only after local prechecks — structurally true for a single-instance stop-the-world compose upgrade (GitLab/Sentry precedent, brief W9/W10).

*Alternative considered:* CI asserts all five booleans unconditionally ("it's true for single instance anyway"). Rejected — CI cannot witness deployment-time facts, this violates the repo's established honest-evidence doctrine (archive A8), and it would poison the mechanism for any future multi-instance reuse.

### D2. Validity bound to the artifact, not the clock

`expiresAt` is set generously (well beyond any plausible upgrade cadence) because real invalidation already comes from the buildIdentity match: every new image invalidates old attestations, and every release ships a fresh one — renewal simply rides the upgrade (TUF cheap re-issuance model, brief W3). A short TTL with no automated renewal path is exactly the failure mode that produced the recurring 503; a self-hosted single instance has no revocation channel, so wall-clock expiry adds availability risk without security (brief W4). The schema imposes no max TTL (brief C5), so this is purely a product decision.

*Alternative considered:* short TTL + a renewal cron/endpoint. Rejected — adds a new moving part and a new failure mode (cron dies → 503 returns) to defend against a threat (stale attestation) the buildIdentity binding already covers.

### D3. Attestation shape: codified single-instance convention, hardcoded

Exactly one instanceId `cap-api-1` (already the shipped convention in `docker-compose.prod.env.example` and `scripts/quick-deploy.sh`, brief C4) with the four role reports (`api`, `admission`, `scheduler`, `runtime`), each `ready:true`, matching buildIdentity, and build-time `reportedAt` (past at runtime, satisfying the not-in-future check, brief C3). Consumers detect an overridden `CAP_INSTANCE_ID` (unset or exactly `cap-api-1` passes; anything else fails closed with a clear message) rather than templating the instanceId — a mismatched id would fail `worker_report_missing` at runtime anyway, so failing early with an actionable message is strictly better.

*Alternative considered:* consumer-side templating of instanceId into a downloaded attestation skeleton. Rejected — turns the consumer into a second attestation producer, blurs the honesty split, and adds JSON-rewriting complexity to shell for a case (custom `CAP_INSTANCE_ID` on single instance) that the runbook already covers manually.

### D4. Delivery: release asset following existing conventions, no new transport

release.yml generates `cap-task-model-attestation-<version>.json` + `.sha256` in (or beside) the existing `attach-run-assets` job, after image identity is final, following `release-image-assets.mjs` naming/checksum discipline (brief C8/C9, electron-updater `latest.yml` pattern W6). Consumers fetch via the existing `releases/download/<target>/<asset>` URL scheme with the `CAP_RELEASE_ASSET_BASE` override. The CF Worker mirror needs no change — it proxies only the `releases/latest` JSON; asset bytes go direct to GitHub (brief C10) — and widening it would violate its "pure cache, never an arbitrary proxy" requirement (archive A5).

*Alternative considered:* embedding the attestation in the image or in `cap-image-assets.json`. Rejected — the env-injection seam consumes a standalone JSON document; a dedicated asset keeps the checksum discipline per-artifact and mirrors the proven sandbox-image-assets pattern (archive A3).

### D5. Consumer wiring reuses existing seams; fail-closed vs. skip-with-reason differs by path

- **upgrade.sh (manual):** download + sha256-verify the target version's attestation, run local preconditions (single api instance, no N-1 cap containers, `CAP_INSTANCE_ID` unset or `cap-api-1`), write `CAP_TASK_MODEL_SELECTION_ENABLED` / `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` in the step-1 `.env` rewrite, and extend the post-upgrade smoke with "catalog query no longer 503s" (using the existing `GET /deployment-capabilities/task-model-selection-v1` diagnostics endpoint as acceptance evidence, brief C12). On precondition mismatch: fail closed on the attestation writeback with a clear message, without breaking the rest of the upgrade.
- **In-app self-update (auto):** stage the attestation asset via the existing release-asset staging path, run the same prechecks via the updater's cap-container enumeration, and atomically persist the gate env keys alongside the CAP_VERSION pin (same grep-v + mv pattern). On precondition failure: skip attestation writeback with a surfaced reason rather than failing the whole update — an auto-updater must not brick upgrades over an optional capability. Pinned `self-update.spec.ts` script assertions are updated in lockstep (archive A6).

*Alternative considered:* a boot-time self-attestation service inside the api ("if I'm the only instance, mint my own attestation"). Rejected — it makes the process both gate evaluator and attestation producer, defeating the deployment-attestation design entirely, and touches the gate semantics this change is committed to leaving alone.

### D6. No cryptographic signing (explicit decision, not omission)

The attestation env var and the release asset live in the same trust domain as `.env` itself: anyone who can write the env can forge either. Structural schema validation + sha256 checksum (transport integrity) suffice for the single-instance path. Offline Sigstore verification in Node is feasible (`@sigstore/bundle` + `@sigstore/verify`, brief W7) and is the recorded upgrade path if a future change wants third-party-verifiable provenance (e.g., for multi-instance or compliance).

### D7. Spec surface: requirement deltas only, no new capability

Deltas land on `release-and-versioning`, `self-hostable-deployment`, `self-update-action`, and `runtime-model-catalog`. The legacy-worker-fence requirement and its scenarios in `runtime-model-catalog` survive unchanged — the new requirement only ADDs the single-instance CI-attested path (archive A1). `TASK_MODEL_SELECTION_CUTOVER.md` documents the CI path as a single-instance alternative, not a replacement; `DEPLOY.md` and the release skill are updated in the same change per the add-release-upgrade-scripts precedent (archive A4).

## Risks / Trade-offs

- **[SHA-context drift: attestation buildIdentity ≠ image GIT_SHA on some trigger contexts]** → Derive both from the single `resolve-release` source of truth in release.yml; add a workflow-level assertion that the attested buildIdentity equals the build-arg passed to the image build.
- **[`compatibilityChecksPassed` asserted for a commit whose compat job never ran (e.g., manually-created release)]** → release.yml explicitly queries the release commit's check-runs and fails the attestation step (and thus release verification) if the compat check-run is absent or unsuccessful.
- **[Custom `CAP_INSTANCE_ID` deployments get a fail-closed writeback and stay 503]** → By design: clear actionable message pointing to the manual runbook; the rest of the upgrade completes. This is the pre-change status quo, not a regression.
- **[Generous `expiresAt` weakens freshness]** → Accepted: validity is enforced by buildIdentity match per release; the clock adds availability risk only. Recorded so a future multi-instance change can revisit.
- **[Self-update silently skips attestation writeback and operators never notice]** → The skip must carry a surfaced reason in the update result, and the upgrade.sh smoke / diagnostics endpoint provide the manual check; not a hard failure by design.
- **[Older releases have no attestation asset; downgrade or pinned-version upgrade to them can't open the gate]** → Consumers treat a 404 asset as "no attestation available" (skip/fail-closed with reason), same UX as the pre-change world.
- **[Pinned-script test assertions drift from updater staging scripts]** → Lockstep update of `self-update.spec.ts` is an explicit task, per the harden-updater-rootfs-extract precedent.

## Migration Plan

1. Ship the change in release N: release.yml starts attaching the attestation asset; upgrade.sh and self-update gain consumption logic.
2. First upgrade to N still runs the *old* upgrade path (chicken-and-egg): operators on the manual path pull the new upgrade.sh from the release; the in-app path opens the gate starting with the N→N+1 upgrade. Document this one-release lag in DEPLOY.md.
3. No rollback machinery needed: the change is additive. Rolling back to a pre-change release simply leaves the gate closed (pre-change status quo); a stale attestation from a newer release fails the buildIdentity match and the gate closes — fail-safe by construction.
4. No DB migrations, no schema changes, no config removals.

## Open Questions

- Whether the attestation generator lives inline in release.yml or as a sibling script beside `release-image-assets.mjs` (leaning script, for testability and reuse by the task-admission gate later) — resolvable at implementation time, no spec impact.
- Exact `expiresAt` horizon (e.g., 1 year vs. 10 years) — pure constant choice; the design only requires it to comfortably outlive upgrade cadence.
