# Research Brief: automate-task-model-attestation-in-ci

Synthesis of three parallel research routes (Web prior art / Codebase ground truth / OpenSpec archive precedent) for fixing the recurring `/v1/runtime-models/query` 503 by having CI generate the `task-model-selection-v1` deployment attestation per release and having the upgrade seams consume it.

---

## Web route (external prior art)

### W1. GitHub Artifact Attestations are the first-party pattern for "CI vouches, deploy consumes"
An `actions/attest-build-provenance` step binds an artifact digest to a SLSA provenance predicate, signed with a short-lived Sigstore certificate; consumers verify with `gh attestation verify` or offline bundles. Using the in-toto Statement shape (subject = artifact name + digest, predicateType + predicate) would align the CI-generated task-model-selection attestation with an established, tooling-supported schema rather than a bespoke JSON.
- Evidence: https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds ; https://github.com/actions/attest-build-provenance
- Relevance: direct prior art for the whole proposal shape. Subject-digest binding is the exact analogue of `report.buildIdentity === GIT_SHA/CAP_VERSION`, and per-release regeneration (each build gets its own attestation) is the industry-standard fix for "old attestation invalidates on upgrade".

### W2. in-toto/SLSA deliberately splits builder claims from verifier claims (VSA)
The attestation model separates what the builder can honestly claim (how/from-what the artifact was built) from what it cannot see; SLSA defines a separate Verification Summary Attestation (VSA) for a downstream verifier to assert checks the builder couldn't witness. Predicates only contain facts the signer actually observed.
- Evidence: https://slsa.dev/spec/v0.1/verification_summary ; https://slsa.dev/blog/2023/05/in-toto-and-slsa
- Relevance: supports the honesty requirement for the four deployment-time facts (`databaseMigrationComplete` etc.): CI attests `compatibilityChecksPassed` (its N-1 job really ran), while a second locally-produced verification (upgrade.sh / self-update preflight, analogous to a VSA) asserts deployment-time facts after checking them on the host — CI never signs facts it cannot witness.

### W3. TUF is the canonical treatment of expiry in update metadata
Every TUF metadata role carries an expiration timestamp plus a version number; clients reject expired metadata (freshness) and lower versions (rollback protection). Freshness comes from a frequently re-signed short-lived "timestamp" role; expiry windows are tiered by how cheap re-issuance is.
- Evidence: https://theupdateframework.github.io/specification/latest/ ; https://theupdateframework.io/docs/security/
- Relevance: since a fresh attestation is minted automatically on every release, expiry can be tied to release cadence (valid until superseded / generous fixed TTL) and "renewal" is simply upgrading. Warns that an expiry with no automated re-issuance path (today's manual runbook) is exactly what produces recurring 503s.

### W4. Sigstore: verify "was it valid when signed", not "is it still valid now"
Sigstore's analysis concludes short-lived signing material needs a trusted timestamp (Rekor integratedTime or RFC 3161 TSA) so verification is anchored to signing time; for many deployments a signed timestamp alone suffices with far less operational complexity.
- Evidence: https://docs.sigstore.dev/cosign/verifying/timestamps/ ; https://blog.sigstore.dev/trusted-time/
- Relevance: a self-hosted single instance has no revocation channel, so a hard wall-clock `expiresAt` mostly creates availability failures (503 recurrence) without adding real security. Anchoring validity to "attestation matches the running buildIdentity" (validity bound to the artifact, not the clock) is the lower-risk choice, with `expiresAt` kept long or advisory.

### W5. Keygen offline licenses + GitLab license UX: TTL must pair with automated renewal and graceful expiry UX
Keygen's signed offline license files embed a tamper-proof payload plus expiry/TTL, verified fully offline; renewal = checking out a new file, with explicit guidance that every offline artifact needs a defined re-issuance path before TTL lapse. GitLab shows the UX side: a banner warns 15 days before expiry and a 30-day grace period applies after.
- Evidence: https://keygen.sh/docs/choosing-a-licensing-model/offline-licenses/ ; https://docs.gitlab.com/administration/license_file/
- Relevance: lifecycle precedent for the env-injected attestation JSON — each GitHub Release ships a fresh attestation asset; if expiry is kept, the console should surface expiring-soon warning + grace window instead of flipping straight to 503.

### W6. electron-updater's `latest.yml` is the dominant OSS manifest-asset delivery pattern
CI publishes a small machine-readable manifest asset (version + sha512 checksums) next to the binaries; the self-update client fetches the manifest by convention first. The manifest is generated only after artifacts exist (accurate hashes) and uploaded automatically by the release pipeline.
- Evidence: https://www.electron.build/auto-update ; https://www.electronjs.org/docs/latest/tutorial/updates
- Relevance: template for delivery mechanics — release.yml should generate the attestation after image digests/GIT_SHA are final and upload it with a stable, predictable filename so upgrade.sh and in-app self-update fetch it by convention. Also flags checking whether the releases.cap.douglasdong.com mirror needs to carry the asset (answered by C10/A5: no).

### W7. Offline cryptographic verification is feasible in plain Node.js
`gh attestation download` fetches Sigstore bundles (JSONL) verifiable with no network using the GitHub CLI or sigstore-js (`@sigstore/bundle` + `@sigstore/verify`) — no gh CLI dependency on the consuming host.
- Evidence: https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline ; https://github.com/sigstore/sigstore-js
- Relevance: if the design wants cryptographic (not just structural) validation, the apps/api Node process can verify offline. Conversely, skipping signing for the single-instance path should be an explicit decision — unsigned release assets are trivially forgeable by anyone who can already write env vars (same trust domain).

### W8. Admission-gate ecosystems stay strict by shipping attestation with every artifact
Sigstore policy-controller and Kyverno verifyImages match the attested digest to the exact artifact being admitted; a new artifact without a matching attestation is rejected by default.
- Evidence: https://github.com/sigstore/policy-controller ; https://main.kyverno.io/docs/policy-types/cluster-policy/verify-images/sigstore/
- Relevance: validates keeping the gate default-closed and buildIdentity-strict (do not weaken multi-instance semantics). The fix is not loosening the check but ensuring every released artifact ships with its matching attestation.

### W9. GitLab/Sentry put deployment-time preflight facts on the host, not in CI
GitLab self-managed runs pre/post-upgrade checks on the host (background migrations finished, components healthy) and blocks the upgrade until migrations complete; Sentry self-hosted makes install.sh the single entrypoint that stops services, runs migrations, and enforces hard-stop versions.
- Evidence: https://docs.gitlab.com/update/upgrade/ ; https://develop.sentry.dev/self-hosted/releases/
- Relevance: prior art for putting the four CI-unwitnessable facts into consumer-side preflight — upgrade.sh/self-update locally verify "single instance, migrations applied, no N-1 containers" before writing the attestation env.

### W10. Cutover checklists degenerate for single-node stop-the-world upgrades
Migration-cutover literature scopes write-freeze / parallel-run / drain-legacy-workers to rolling/multi-node scenarios, and treats fresh installs or single-node stop-the-world upgrades as a degenerate case where those steps are trivially satisfied because downtime is accepted (Sentry: "services are shut down and then data migrations are run, so expect downtime").
- Evidence: https://develop.sentry.dev/self-hosted/releases/ ; https://gitplumbers.com/blog/the-zerodowntime-cutover-checklist-we-actually-use-in-production/
- Relevance: supports the honest scoping claim — for a single-instance compose stack that stops the old container before starting the new one, `writeIngressClosedDuringCutover` / `mcpWritersDisabledDuringCutover` / `legacyWorkersRemoved` are structurally true by the upgrade procedure itself. Multi-instance keeps the manual runbook.

### W11. Known SHA-context drift pitfall in CI image stamping
docker/metadata-action's `org.opencontainers.image.revision` label is the standard way CI stamps git SHA into images, and it can drift from the checked-out commit in some trigger contexts, requiring explicit override.
- Evidence: https://github.com/docker/metadata-action
- Relevance: release.yml must derive the attestation's buildIdentity from the same source of truth baked into the image (the build-arg GIT_SHA), or `report.buildIdentity === process GIT_SHA` can fail even on a correct release.

### W12. Graceful-degradation guidance: capability-off is a 200-with-reason, not a 5xx
Unleash FeatureOps and AWS Well-Architected REL05-BP01: a frontend should treat a disabled/unavailable backend capability as a soft dependency — query availability once, visibly downgrade with an explanatory state, never surface a raw 5xx; capability endpoints should return 200 + availability payload for an expected-off feature.
- Evidence: https://www.getunleash.io/blog/graceful-degradation-featureops-resilience ; https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_mitigate_interaction_failure_graceful_degradation.html
- Relevance: even after the fix, gate-closed remains a legitimate state (fresh install pre-upgrade, expired attestation). Best practice argues for distinguishing "feature disabled" (200 + reason the selector can render as default-model fallback/setup hint) from genuine server failure (503). Codebase route (C11) shows the current UI already degrades non-blockingly, so this is optional polish.

---

## Codebase route (ground truth in this repo)

### C1. 503 root cause confirmed: double `assertOpen()` on a default-closed gate
`/v1/runtime-models/query` calls `capability.assertOpen()` twice (before catalog resolution and again after, to reject catalogs obtained across an expiry); `assertOpen` throws `RuntimeModelPreflightError` whenever the gate is closed, and the gate is default-closed with reason `disabled` when `CAP_TASK_MODEL_SELECTION_ENABLED` is unset.
- Evidence: `apps/api/src/v1/v1-runtime-models.controller.ts:36,40`; `apps/api/src/runtime-models/task-model-capability.service.ts:83-86`; `packages/contracts/src/task-model-capability.ts:212-213`
- Relevance: any fix must open the gate via env config — no bypass code path exists; an attestation expiring mid-request also 503s.

### C2. buildIdentity = GIT_SHA baked at build time; CI knows it for every release image
`buildIdentity` is `process.env.GIT_SHA ?? process.env.CAP_VERSION` (fallback `unknown-build`); GIT_SHA is an image ENV from a build-arg that release.yml sets to `github.sha`.
- Evidence: `apps/api/src/runtime-models/task-model-capability.service.ts:44-47`; `apps/api/Dockerfile:67,70`; `.github/workflows/release.yml:125`
- Relevance: root cause of 503 recurrence on upgrade — `verifyLocalProcess` requires `report.buildIdentity === this.buildIdentity` (service.ts:131), so every new image invalidates old attestations. CI emitting `reports.buildIdentity = github.sha` per release matches exactly.

### C3. Two validation layers; a CI attestation must synthesize exactly 4 role reports
Contracts-level `evaluateTaskModelSelectionGate` (expiry, five booleans, complete membership) plus service-level `verifyLocalProcess` requiring the local instanceId in `expectedWorkers` with all four roles (`api`,`admission`,`scheduler`,`runtime`), each with a report carrying the capability, `ready:true`, matching buildIdentity, and `reportedAt` not in the future.
- Evidence: `apps/api/src/runtime-models/task-model-capability.service.ts:107-142,22-27`; `packages/contracts/src/task-model-capability.ts:208-265`
- Relevance: the CI product must contain 4 reports for one instanceId with build-time `reportedAt` (past at runtime). No wildcard instance ids — instanceId must byte-match the deployment's `CAP_INSTANCE_ID`.

### C4. `cap-api-1` is already the codified single-instance convention
instanceId falls back `CAP_INSTANCE_ID ?? HOSTNAME ?? os.hostname()` with random-uuid last resort; both `docker-compose.prod.env.example:28` and `scripts/quick-deploy.sh:1087-1088,1108` establish `CAP_INSTANCE_ID=cap-api-1`.
- Evidence: `apps/api/src/runtime-models/task-model-capability.service.ts:40-43`; `docker-compose.prod.env.example:28`; `scripts/quick-deploy.sh:1087-1088,1108`
- Relevance: CI hardcoding `cap-api-1` aligns with shipped defaults; consumers must detect an overridden `CAP_INSTANCE_ID` (would fail closed with `worker_report_missing`, service.ts:114-115).

### C5. Schema imposes no max validity duration; expiry policy is a pure product decision
`TaskModelSelectionDeploymentAttestationSchema` (strict): schemaVersion literal 1, safe-text grammar `^[A-Za-z0-9._:@/+-]{1,256}$` for ids, unique worker/report keys, five explicit booleans, `expiresAt` strictly after `attestedAt` — no max TTL. Env payload capped at 256KB; any parse failure ⇒ `deployment_attestation_invalid` 503. Gate config is captured at service construction, so env changes require api recreate — which both upgrade paths already do.
- Evidence: `packages/contracts/src/task-model-capability.ts:63-113`; `packages/contracts/src/deployment-capability.ts:4-19`; `apps/api/src/runtime-models/task-model-capability.service.ts:28,48,164-177`
- Relevance: CI can set `expiresAt` to outlive upgrade cadence, or renewal simply rides the upgrade seam (buildIdentity changes force a rewrite anyway).

### C6. Only `compatibilityChecksPassed` is already CI-backed; the other four facts are deployment-time
A required CI job "task model N-1 compatibility" (`pnpm --filter @cap/api test:compat:task-model-n-minus-one`) uploads sanitized evidence.json; the cutover manual explicitly warns `localReports.ready` proves none of the other four facts.
- Evidence: `.github/workflows/ci.yml:66-103`; `deploy/TASK_MODEL_SELECTION_CUTOVER.md:14-17,102-107`; `packages/contracts/src/task-model-capability.ts:69-73`
- Relevance: CI can truthfully assert only `compatibilityChecksPassed`; design must scope the CI product to "fresh install or continuously-run single instance ≥ first model-aware release" and put local prechecks on the consumer side.

### C7. Consumer-side seams already exist in self-update and upgrade.sh
Self-update auto-detects compose topology from the api container's own labels and enumerates running cap containers via the `ghcr.io/<owner>/cap-*` regex (usable to prove "single api instance, no N-1 container"); its updater already atomically persists arbitrary KEY=VALUE into the deployment `.env` (same grep -v + mv pattern as the CAP_VERSION pin). upgrade.sh's step-1 `.env` rewrite is the manual-path insertion point; upgrade.sh explicitly disclaims being a cutover procedure today.
- Evidence: `apps/api/src/self-update/self-update.service.ts:83,113-126,418-424,637-644`; `scripts/upgrade.sh:59-64`; `deploy/TASK_MODEL_SELECTION_CUTOVER.md:192-194`
- Relevance: both delivery seams named in the direction exist — self-update can write `CAP_TASK_MODEL_SELECTION_ENABLED` / `_ATTESTATION_JSON` alongside the CAP_VERSION pin.

### C8. Per-version release-asset fetching pattern already exists
Self-update's release-assets delivery builds URLs as `https://github.com/<GITHUB_RELEASES_REPO>/releases/download/<target>/<asset>` (overridable via `CAP_RELEASE_ASSET_BASE`); naming/checksum conventions centralized in `scripts/release-image-assets.mjs` (assetFileName + `.sha256` companions + `cap-image-assets.json` manifest).
- Evidence: `apps/api/src/self-update/self-update.service.ts:459-467`; `scripts/release-image-assets.mjs:24,74-80`
- Relevance: a `cap-task-model-attestation-<version>.json` + `.sha256` asset can follow this exact discipline with no new transport.

### C9. release.yml has a natural attach point — with a cross-workflow evidence caveat
The `attach-run-assets` job (release event only, contents:write) already uploads compose assets via `gh release upload`; `resolve-release` exposes version/build_time, and `github.sha` is in the same context. Caveat: release.yml triggers on release:published while the compat evidence lives in ci.yml on the merged commit — release.yml must verify the release commit's compat job passed (e.g. `gh api` check-runs), not blindly set the boolean.
- Evidence: `.github/workflows/release.yml:73-93,279-295`
- Relevance: attestation generation slots in as a step in attach-run-assets or a sibling job; the honesty of `compatibilityChecksPassed` needs an explicit CI-status check.

### C10. The CF Worker mirror needs NO change for a new asset
`apps/release-cache-worker/src/proxy.ts:30-31` proxies only the exact `releases/latest` path; update-status parses only `tag_name`; asset downloads go direct to github.com and never through the Worker.
- Evidence: `apps/release-cache-worker/src/proxy.ts:30-31`; `apps/api/src/update-status/update-status.service.ts:29,304-309`; `apps/api/src/self-update/self-update.service.ts:463-465`
- Relevance: contrary to the tasking's concern, adding a release asset requires no Worker change unless the design deliberately routes attestation bytes through the mirror.

### C11. Gate fences many call sites, but the frontend already degrades gracefully
tasks.service asserts only when an explicit model is present (create + pre-write race recheck); scheduled-tasks asserts at 6 sites; MCP server on model-aware paths; omitted-model creation untouched. The selector shows "当前模型目录暂不可用，仍可使用运行时默认模型" with retry, keeps the form submittable with runtime default, and clears stale explicit values. Both "disabled" and transient failure map to the same `runtime_model_catalog_unavailable` code (deliberately hiding closed reason from clients).
- Evidence: `apps/api/src/tasks/tasks.service.ts:1106-1110,1383-1388,1455-1466`; `apps/api/src/scheduled-tasks/scheduled-tasks.service.ts:226,321,401,492,1438,1449`; `apps/api/src/mcp/mcp.server.ts:112-115`; `apps/web/src/components/runtime-model-selector.tsx:70-92,104-112,234-247`; `apps/api/src/runtime-models/task-model-capability.service.ts:192-196`
- Relevance: fix scope can stay backend/CI-side; UI change is optional polish (distinguish "gate disabled by deployment" from transient outage).

### C12. Diagnostics endpoint exists for post-fix acceptance
`GET /deployment-capabilities/task-model-selection-v1` returns `{ gate, localReports }` (never the raw attestation) behind normal auth — the source of the live evidence (reason=disabled, four ready localReports, instanceId=cap-api-1). CI doesn't need it (all report fields are computable at build time); it is the post-upgrade acceptance check.
- Evidence: `apps/api/src/runtime-models/task-model-capability.controller.ts:10-22`; `apps/api/src/runtime-models/task-model-capability.service.ts:93-105`; `deploy/TASK_MODEL_SELECTION_CUTOVER.md:56-70,80-101`

### C13. A sibling gate (task-admission v2) has the identical attestation pattern
`CAP_TASK_ADMISSION_V2_ENABLED` + `CAP_TASK_ADMISSION_V2_ATTESTATION_JSON`, its own cutover doc, and quick-deploy.sh already normalizes/writes its env keys (while scrubbing process-only `CAP_CUTOVER_BEARER_TOKEN`).
- Evidence: `docker-compose.prod.env.example:33-40`; `apps/api/src/task-admission/task-admission-capability.service.ts`; `scripts/quick-deploy.sh:1092-1096,1113-1115`; `deploy/TASK_ADMISSION_V2_CUTOVER.md`
- Relevance: shape the mechanism (asset naming, buildIdentity binding, consumer prechecks) to be reusable for the task-admission gate later; `packages/contracts/src/deployment-capability.ts:4-19` is the common schema layer.

### C14. Multi-instance semantics live in doc comments + manual; the gate evaluator need not change
Service comment: "one N process cannot prove that an N-1 writer is absent"; schema comment explains the five facts (N-1 Zod schemas strip unknown model fields); the manual keeps ingress/MCP closure and complete-membership attestation as the multi-instance path.
- Evidence: `apps/api/src/runtime-models/task-model-capability.service.ts:30-36`; `packages/contracts/src/task-model-capability.ts:58-62,203-207`; `deploy/TASK_MODEL_SELECTION_CUTOVER.md:1-11,192-194,299-303`
- Relevance: constraint (4) is satisfiable without touching schema or evaluate logic at all — add only a CI producer + consumer-side prechecked writer.

---

## Archive route (OpenSpec precedent in this repo)

### A1. The gate originates in 2026-07-14-add-task-model-selection; the new change is a delta against its spec
design.md Decision 9 defines the default-closed `task-model-selection-v1` gate with mandatory write-maintenance cutover; `specs/runtime-model-catalog/spec.md:254-285` hard-requires "Explicit model selection is fenced from legacy workers"; Task 9.6 produced the N/N-1 harness and the runbook that became `deploy/TASK_MODEL_SELECTION_CUTOVER.md`.
- Evidence: `openspec/changes/archive/2026-07-14-add-task-model-selection/design.md`, `specs/runtime-model-catalog/spec.md:254-285`, `tasks.md:27,174,259`
- Relevance: the new change must ADD a single-instance CI-attested path as a new requirement/scenario without deleting the legacy-worker-fence scenarios — the archived spec's explicit rejection ("an N-only gate cannot prevent N-1 stripping") IS the multi-instance semantics constraint. Reuse its artifact structure (proposal + design with per-decision alternatives + research-brief + per-capability spec deltas + track-annotated tasks + surface-impact.json).

### A2. Frontend degrade behavior for a closed gate is already specced
The same archived change's `specs/frontend-console/spec.md:9,41,57` requires loading/empty/constrained/unavailable/ready catalog states, runtime-default fallback, and operator notification on `runtime_model_catalog_unavailable`.
- Relevance: 503-with-retryable-degrade is by design; the new change probably needs no frontend spec delta unless it wants to distinguish "gate disabled, ask operator to upgrade" from transient outage in copy.

### A3. 2026-06-30-release-asset-sandbox-images is the closest structural precedent
release.yml gained a packaging/upload job attaching a machine-readable manifest (`cap-image-assets.json`) + per-asset checksums bound to the release tag; a delivery-mode env (`CAP_SANDBOX_IMAGE_DELIVERY=registry|release-assets|auto`) where explicit mode fails closed on missing/invalid asset; release verification extended so a release cannot pass with images present but assets missing; self-update extended to stage the asset before reporting ready.
- Evidence: `openspec/changes/archive/2026-06-30-release-asset-sandbox-images/proposal.md`, design.md D1/D3/D5
- Relevance: reuse wholesale — manifest-bound-to-tag + checksum + fail-closed explicit consumption + release-verification coverage is the proven pattern, and it already modified `release-and-versioning` and `self-update-action`, the same capabilities this change touches. Its tag↔asset binding is directly analogous to attestation↔buildIdentity binding.

### A4. 2026-06-23-add-release-upgrade-scripts defines the upgrade.sh philosophy and its blast radius
"No single-service door": always force-stage everything together, then verify at upgrade time (`/version == target` + provision smoke); it updated `deploy/DEPLOY.md` and the release-pr-bundle skill in the same change.
- Evidence: `openspec/changes/archive/2026-06-23-add-release-upgrade-scripts/proposal.md`
- Relevance: upgrade.sh is where "download attestation asset + run local precondition checks + write env" belongs; its post-upgrade smoke is the natural home for "catalog query no longer 503s"; follow its precedent of updating DEPLOY.md and the release skill in the same change.

### A5. 2026-06-19-mirror-release-checks-via-worker forbids widening the Worker
The cache-only CF Worker strictly proxies only `GET .../releases/latest` JSON with path validation so it "never becomes an arbitrary proxy"; asset bytes go direct to GitHub; `GITHUB_API_BASE` has a mandatory direct-GitHub escape hatch.
- Relevance: the new asset appears in the mirrored latest-release JSON automatically (modulo cache TTL). Avoid extending the Worker to proxy attestation bytes — that would violate its injection-safety / "pure cache, no release gating" requirement. If asset-download resilience is wanted, make it a separate deliberate decision (vibe-zlyan-class hosts can't reach GitHub assets at all and use a local bridge).

### A6. Self-update `.env` writeback seam + pinned-script test assertions
2026-06-17-self-update-resident-topology established that the updater persists CAP_VERSION into the detected working dir's `.env` on success; 2026-07-21-harden-updater-rootfs-extract (most recent updater change) shows self-update.service.ts staging scripts are locked by pinned-text unit assertions that must be updated in lockstep — and is the best template for a small updater-focused change (tight proposal + surface-impact.json + verification-report.md, single Modified Capability `self-update-action`).
- Evidence: `archive/2026-06-17-self-update-resident-topology/proposal.md:27-28,52`; `archive/2026-07-21-harden-updater-rootfs-extract/proposal.md`
- Relevance: writing `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` uses this exact seam; expect lockstep updates to pinned `self-update.spec.ts` script assertions.

### A7. Manual-path artifacts to preserve; change directory already scaffolded
`deploy/` contains `TASK_MODEL_SELECTION_CUTOVER.md`, `TASK_ADMISSION_V2_CUTOVER.md` (second cutover doc, same pattern), and example evidence JSONs; `openspec/changes/automate-task-model-attestation-in-ci/` already exists (only `.openspec.yaml`, created today).
- Relevance: the CI product must be documented as an alternative alongside the runbook, not a replacement; decide explicitly whether to generalize the mechanism to task-admission or scope to task-model-selection only. New artifacts go under the scaffolded directory.

### A8. Established doctrine: honest evidence labeling, fail-closed when unprovable
The task-model-selection design rejected "nullable-schema compatibility alone" and "UI-only flags" as safety boundaries, and its Claude-catalog decision labels `supported-subset`/`cli-version-verified` rather than claiming completeness.
- Evidence: `archive/2026-07-14-add-task-model-selection/design.md` (Decision 3, Decision 9 Alternatives)
- Relevance: the proposal's split — CI attests only `compatibilityChecksPassed`, four deployment-time facts get consumer-side local verification with an honest validity scope — is a direct continuation of established doctrine and will align with existing spec language under opsx-verify's refutation style.

---

## Implications for the proposal

1. **Adopt the two-party honesty split (converges across all three routes).** CI (builder) attests only what it witnessed: buildIdentity (= `github.sha`, same build-arg baked into the image — beware SHA-context drift, W11/C2) and `compatibilityChecksPassed` — and even that must be verified against the release commit's actual ci.yml check-run status, not assumed (C9). The four deployment-time facts are asserted by the consumer side (upgrade.sh / self-update preflight, the VSA analogue: W2, W9) after locally checking single-api-instance (self-update's cap-* container enumeration, C7), migrations applied, and no N-1 containers. This mirrors GitLab/Sentry (W9) and continues the repo's own "honest evidence labeling" doctrine (A8).

2. **Bind validity to the artifact, not the clock.** The buildIdentity match already invalidates stale attestations on every upgrade (C2), which is the industry-standard per-release regeneration model (W1, W8). Schema imposes no max TTL (C5), so set `expiresAt` generously (outliving upgrade cadence) or treat it as advisory; a hard short expiry on a host with no revocation channel only recreates the 503 (W3, W4). Renewal = upgrading, TUF-style cheap re-issuance (W3). If a UI touch is in scope, prefer expiring-soon warning + grace over hard cutoff (W5).

3. **Delivery = release asset following existing conventions; no new transport, no Worker change.** Generate the attestation in release.yml's `attach-run-assets` (or sibling job) after identity is final (C9, W6), name it `cap-task-model-attestation-<version>.json` + `.sha256` per `release-image-assets.mjs` discipline (C8), fetch via the existing `releases/download/<target>/<asset>` URL scheme with `CAP_RELEASE_ASSET_BASE` override (C8). The CF Worker mirror needs no change and must not be widened to proxy asset bytes (C10, A5); offline/bridged hosts (vibe-zlyan-class) are a separate deliberate decision (A5).

4. **Hardcode the single-instance shape CI can produce: instanceId `cap-api-1`, 4 role reports.** The attestation must contain exactly four reports (api/admission/scheduler/runtime) for one instanceId with build-time `reportedAt` (C3). `cap-api-1` is already the codified convention in prod.env.example and quick-deploy (C4); consumers must detect an overridden `CAP_INSTANCE_ID` and fail closed with a clear message rather than emit a mismatched attestation.

5. **Do not touch the gate evaluator, schema, or multi-instance semantics.** Constraint (4) is satisfiable with zero changes to `evaluateTaskModelSelectionGate`, `verifyLocalProcess`, or the contracts schema (C14); admission-gate ecosystems stay strict the same way — every artifact ships with its matching attestation (W8). The legacy-worker-fence scenarios in the archived spec must survive as-is; the new change only ADDs a single-instance CI-attested requirement (A1). Scope the CI asset's declared validity to "fresh install or continuously-run single-instance ≥ v0.38" — defensible because single-node stop-the-world upgrades make the cutover facts structurally true (W10, C6).

6. **Consumer seams are already built; the work is wiring, plus lockstep test updates.** upgrade.sh step-1 `.env` rewrite (manual path) and self-update's atomic env-persist helper (in-app path) both exist (C7, A4, A6); expect to update pinned `self-update.spec.ts` script assertions in lockstep (A6) and to add "catalog query no longer 503s" to upgrade.sh's post-upgrade smoke (A4). Update `deploy/DEPLOY.md` and the release skill in the same change per precedent (A4). `TASK_MODEL_SELECTION_CUTOVER.md` stays authoritative for multi-instance; document the CI path as an alternative, not a replacement (A7, C14).

7. **Decide signing explicitly.** Offline Sigstore verification in Node is feasible (W7), but for a single-instance deployment the attestation env var and the release asset live in the same trust domain (whoever can write `.env` can forge either), so structural validation + sha256 checksum may be the right simplification — record it as an explicit alternatives-considered decision, not an omission (W7, A1's per-decision alternatives structure).

8. **Frontend is optional polish, not fix scope.** The selector already degrades non-blockingly and self-heals (C11, A2). If polished, follow W12/A2: distinguish "gate disabled by deployment — upgrade to enable" from transient unavailability, which today share one error code by design (C11).

9. **Design for reuse by the sibling task-admission v2 gate.** Same attestation pattern, env keys, cutover doc, and quick-deploy handling already exist (C13); shape asset naming, buildIdentity binding, and consumer prechecks so the mechanism generalizes later — while explicitly scoping this change to task-model-selection (A7).

10. **Follow the archive's artifact template.** Structure per 2026-07-14-add-task-model-selection (proposal + design with alternatives + spec deltas + track-annotated tasks + surface-impact.json, A1); for the updater-side slice, 2026-07-21-harden-updater-rootfs-extract is the size/shape template (A6); release-asset mechanics per 2026-06-30-release-asset-sandbox-images D1/D3/D5 including fail-closed explicit consumption and release-verification coverage (A3).
