# self-update-action Delta Specification

## ADDED Requirements

### Requirement: Self-update stages the attestation asset and persists the gate env keys with the version pin

When an enabled self-update targets a version, the updater SHALL fetch the target's `cap-task-model-attestation-<version>.json` asset and its `.sha256` companion through the existing release-asset staging conventions (`releases/download/<target>/<asset>` with the `CAP_RELEASE_ASSET_BASE` override honored) and SHALL verify the checksum before use. Before persisting any gate env key, the updater SHALL evaluate the same local single-instance preconditions as the manual path, using its existing cap-container enumeration:

1. exactly one running cap api container in the derived topology;
2. no cap-namespace container at a version other than the target;
3. `CAP_INSTANCE_ID` unset or exactly `cap-api-1`.

When the asset is verified and the preconditions pass, the updater SHALL persist `CAP_TASK_MODEL_SELECTION_ENABLED=true` and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON=<verified asset content>` into the deployment's working-dir `.env` using the SAME atomic KEY=VALUE persist seam as the `CAP_VERSION` pin, in the same update run, so the gate configuration and the version pin land together and survive a later manual `docker compose up -d`.

#### Scenario: A successful self-update persists gate env keys alongside CAP_VERSION

- **WHEN** an enabled, admin-confirmed self-update to `vX.Y.Z` runs on a deployment satisfying the local preconditions and the attestation asset checksum-verifies
- **THEN** the deployment `.env` afterwards contains `CAP_VERSION=vX.Y.Z`, `CAP_TASK_MODEL_SELECTION_ENABLED=true`, and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` equal to the verified asset content, each written via the atomic persist seam

#### Scenario: The recreated api opens the gate from the persisted attestation

- **WHEN** the self-update completes its recreate after persisting the gate env keys for `vX.Y.Z`
- **THEN** the recreated api evaluates the persisted attestation against its own baked `GIT_SHA` and reports the `task-model-selection-v1` gate open, so a subsequent task-model catalog query does not return 503

### Requirement: Attestation writeback failures degrade the update, not fail it

When a local precondition fails, the attestation asset is missing for the target, or its checksum does not verify, the self-update SHALL skip the attestation writeback — leaving any existing gate env keys unmodified and never persisting unverified attestation content — and SHALL surface the skip reason in the update's observable outcome (updater log/status), while the rest of the update (image pull, sandbox staging, recreate, `CAP_VERSION` persist) proceeds and completes. A skipped attestation writeback SHALL NOT mark the whole self-update as failed.

#### Scenario: Precondition failure skips writeback with a surfaced reason

- **WHEN** an enabled self-update runs and the cap-container enumeration finds a second cap api container, an N-1 cap container, or a `CAP_INSTANCE_ID` other than `cap-api-1`
- **THEN** the update still pulls, stages, recreates, and persists `CAP_VERSION`, the gate env keys are not written or modified, and the update outcome records the named precondition as the skip reason

#### Scenario: Unverifiable asset is never persisted

- **WHEN** the target version's attestation asset is absent or fails its `.sha256` verification
- **THEN** no attestation content is persisted into `.env`, the skip reason identifies the asset defect, and the update otherwise completes

### Requirement: Pinned updater script assertions cover attestation staging in lockstep

The self-update unit suite's pinned script assertions (`self-update.spec.ts`) SHALL be extended in lockstep so the generated updater script provably contains the attestation behavior: the checksum verification preceding any persist, the precondition gating, and the atomic gate-env persist using the same seam as the `CAP_VERSION` pin.

#### Scenario: Unit suite pins the attestation staging and persist behavior

- **WHEN** the self-update unit suite inspects the generated updater script for a target with attestation staging enabled
- **THEN** it asserts that checksum verification precedes the gate-env persist, that the persist is conditional on the precondition checks, and that the gate env keys are written through the same atomic KEY=VALUE persist mechanism as `CAP_VERSION`
