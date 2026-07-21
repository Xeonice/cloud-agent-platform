# self-hostable-deployment Delta Specification

## ADDED Requirements

### Requirement: The manual upgrade script consumes the release attestation behind fail-closed local preconditions

For a target version, `scripts/upgrade.sh` SHALL download the target's `cap-task-model-attestation-<version>.json` asset plus its `.sha256` companion via the existing `releases/download/<target>/<asset>` convention and SHALL verify the checksum before use. Before writing any gate env key, it SHALL run local single-instance preconditions:

1. exactly one running cap api instance for the deployment (no second api container);
2. no N-1 cap containers (no running cap-namespace container at a version other than the target being staged);
3. `CAP_INSTANCE_ID` unset or exactly `cap-api-1` (the attestation's sole instanceId).

Only when the asset is checksum-verified AND all preconditions pass SHALL the script write `CAP_TASK_MODEL_SELECTION_ENABLED=true` and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON=<verified asset content>` during the existing step-1 atomic `.env` rewrite (env backup preserved, other lines untouched). On a failed precondition, a missing asset, or a checksum mismatch, the script SHALL fail closed on the attestation writeback ONLY — it SHALL print a clear message naming the failed precondition or asset defect and SHALL NOT write or modify the gate env keys, while the rest of the upgrade (image staging, `CAP_VERSION` pin, api recreate) proceeds unchanged.

#### Scenario: Verified asset plus passing preconditions writes the gate env keys atomically

- **WHEN** the upgrade script runs for `vX.Y.Z` on a deployment with one running cap api instance, no N-1 cap containers, and `CAP_INSTANCE_ID` unset or `cap-api-1`, and the attestation asset downloads with a matching checksum
- **THEN** the step-1 `.env` rewrite additionally persists `CAP_TASK_MODEL_SELECTION_ENABLED=true` and `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON` set to the verified asset content, atomically and with the pre-rewrite env backup preserved

#### Scenario: A precondition mismatch fails the writeback closed without breaking the upgrade

- **WHEN** the upgrade script runs and a local precondition fails (e.g. `CAP_INSTANCE_ID` is set to a value other than `cap-api-1`, or a second cap api container is running)
- **THEN** the script prints a clear message naming the exact failed precondition, does NOT write the gate env keys, and the remainder of the upgrade (both-image staging, version pin, recreate, existing smoke) still completes

#### Scenario: A missing or checksum-failed attestation asset is never written

- **WHEN** the attestation asset for the target version is absent from the Release or its content does not match the `.sha256` companion
- **THEN** the script does not write `CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON`, reports the asset defect loudly, and the upgrade otherwise proceeds

### Requirement: Post-upgrade verification includes a task-model catalog success check

The upgrade script's post-upgrade verification SHALL, in addition to the existing `/version` check and provision smoke, verify that the task-model-selection gate outcome matches what the upgrade wrote: after a successful attestation writeback, a task-model catalog query (or the `task-model-selection-v1` deployment-capability diagnostics) against the recreated api SHALL succeed rather than return 503. When the check cannot run (no session credential available), it SHALL be skipped with a loud warning rather than failing the upgrade, consistent with the existing smoke behavior. When the attestation writeback was skipped, the catalog check SHALL NOT fail the upgrade for the gate remaining closed.

#### Scenario: Catalog no longer 503s after an attested upgrade

- **WHEN** the upgrade script completed the attestation writeback, recreated the api at the target version, and runs its post-upgrade verification with a usable credential
- **THEN** the task-model catalog check succeeds (non-503 / gate reported open), and a 503 or closed-gate result surfaces as an upgrade verification failure at upgrade time

#### Scenario: Catalog check is skipped without credentials

- **WHEN** the post-upgrade verification has no session credential to query the catalog
- **THEN** the catalog check is skipped with a loud warning and the upgrade still completes

#### Scenario: Skipped writeback does not fail the catalog check

- **WHEN** the attestation writeback was skipped due to a failed precondition or asset defect
- **THEN** the post-upgrade catalog check reports the gate as expectedly closed (with the skip reason) instead of failing the upgrade
