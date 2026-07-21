# release-and-versioning Delta Specification

## ADDED Requirements

### Requirement: Releases publish a build-matched task-model-selection attestation asset

The release workflow SHALL generate and attach a `cap-task-model-attestation-<version>.json` asset plus a `.sha256` checksum companion to each GitHub Release, produced only after the release image identity is final. The attestation SHALL validate against the UNCHANGED contracts attestation schema (`schemaVersion: 1`; no schema modification), and SHALL carry:

- `buildIdentity` derived from the SAME `GIT_SHA` build-arg value baked into the released `cap-api` image (the value `GET /version` reports as `gitSha`), NOT an independently resolved SHA context that can drift from the image;
- exactly ONE instanceId, `cap-api-1` (the codified single-instance convention matching `docker-compose.prod.env.example` and quick-deploy), listed in `expectedWorkers` and carrying all four role reports (`api`, `admission`, `scheduler`, `runtime`), each with the capability, `ready: true`, the matching `buildIdentity`, and a build-time `reportedAt` that is in the past at any runtime evaluation;
- an `expiresAt` generous enough to outlive the release cadence, so validity is effectively bound to the buildIdentity match rather than the wall clock;
- `compatibilityChecksPassed: true` set ONLY from verified CI evidence (see the next requirement), with the four deployment-time booleans (`databaseMigrationComplete`, `writeIngressClosedDuringCutover`, `mcpWritersDisabledDuringCutover`, `legacyWorkersRemoved`) carried as the single-instance convention whose honesty is enforced by consumer-side local preconditions, not claimed as CI-witnessed facts.

The asset SHALL follow the existing `release-image-assets.mjs` naming/checksum discipline and SHALL be fetchable via the existing `releases/download/<target>/<asset>` convention. The CF release-cache Worker SHALL NOT be widened to proxy attestation bytes — it continues to proxy only the `releases/latest` JSON path.

#### Scenario: Release attaches the attestation asset with a build-matched identity

- **WHEN** a GitHub Release `vX.Y.Z` is published and the release workflow completes
- **THEN** the Release assets include `cap-task-model-attestation-vX.Y.Z.json` and its `.sha256` companion, the checksum file matches the uploaded JSON byte-for-byte
- **AND** the attestation's `buildIdentity` equals the `GIT_SHA` value baked into `cap-api:vX.Y.Z` (the same value that image serves as `gitSha` from `GET /version`)

#### Scenario: Attestation asset is the codified single-instance shape

- **WHEN** the published attestation asset is parsed with the unchanged contracts attestation schema
- **THEN** it validates with `schemaVersion: 1`, contains exactly one instanceId `cap-api-1` in `expectedWorkers`, carries all four role reports (`api`, `admission`, `scheduler`, `runtime`) each `ready: true` with a build-time `reportedAt`, and its `expiresAt` is strictly after `attestedAt`

#### Scenario: The Worker mirror is not widened for the new asset

- **WHEN** a consumer fetches the attestation asset for a target version
- **THEN** the fetch goes to the `releases/download/<target>/<asset>` endpoint (with the existing `CAP_RELEASE_ASSET_BASE` override), and the CF release-cache Worker's proxied path set is unchanged (still only the `releases/latest` JSON)

### Requirement: compatibilityChecksPassed is set only from verified check-run evidence

Because the release workflow triggers on `release: published` while the N-1 compatibility evidence is produced by CI on the merged commit, the attestation-generation step SHALL verify — via the GitHub check-runs API for the release commit — that the "task model N-1 compatibility" check-run actually concluded successfully before setting `compatibilityChecksPassed: true`. When that verification cannot confirm a successful conclusion (check-run absent, failed, or unqueryable), the workflow SHALL fail the attestation step rather than publish an attestation claiming compatibility passed.

#### Scenario: Verified compat check-run yields an honest attestation

- **WHEN** the attestation step runs for release commit `S` and the check-runs API reports the "task model N-1 compatibility" check-run for `S` concluded with success
- **THEN** the generated attestation carries `compatibilityChecksPassed: true`

#### Scenario: Unverifiable compat evidence fails the attestation step closed

- **WHEN** the attestation step runs and the release commit's N-1 compatibility check-run is absent, unsuccessful, or cannot be queried
- **THEN** the step fails without uploading an attestation asset that claims `compatibilityChecksPassed: true`

### Requirement: Release verification fails when images are present but the attestation asset is missing or invalid

Release verification SHALL treat the attestation asset as part of the matched release artifact set: for a release whose CAP images were published, verification SHALL fail when the attestation asset is missing, its `.sha256` companion is missing or does not match, the JSON does not validate against the contracts attestation schema, or its `buildIdentity` does not match the released `cap-api` image's baked `GIT_SHA`.

#### Scenario: Missing attestation asset fails release verification

- **WHEN** release verification inspects `vX.Y.Z` and the CAP images exist but `cap-task-model-attestation-vX.Y.Z.json` (or its checksum companion) is absent
- **THEN** verification fails rather than reporting the release complete

#### Scenario: Invalid or mismatched attestation fails release verification

- **WHEN** release verification inspects `vX.Y.Z` and the attestation asset fails schema validation, fails its checksum, or carries a `buildIdentity` different from the released `cap-api` image's baked `GIT_SHA`
- **THEN** verification fails with a message identifying the attestation defect
