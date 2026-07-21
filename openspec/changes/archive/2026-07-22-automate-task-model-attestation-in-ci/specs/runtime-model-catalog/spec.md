# runtime-model-catalog Delta Specification

## ADDED Requirements

### Requirement: Official upgrade seams keep the single-instance gate open across releases

A single-instance deployment (one cap api instance, `CAP_INSTANCE_ID` unset or exactly `cap-api-1`) that is upgraded through either official seam — the manual upgrade script or the in-app self-update — SHALL end the upgrade with the `task-model-selection-v1` gate open, backed by a valid attestation whose `buildIdentity` matches the running api build, so `/v1/runtime-models/query` does not recur to 503 across upgrades. Renewal SHALL ride the upgrade itself: each release ships a fresh build-matched attestation and the seams re-apply it, with no separate manual re-attestation step required for the single-instance path.

This requirement SHALL be satisfied WITHOUT modifying `evaluateTaskModelSelectionGate`, `verifyLocalProcess`, or the contracts attestation schema, and the existing "Explicit model selection is fenced from legacy workers" requirement and its scenarios remain in force unchanged: deployments that fail the single-instance preconditions keep the gate closed with the existing safe retryable catalog-unavailable semantics, and the multi-instance manual cutover runbook remains the authoritative path for them.

#### Scenario: An upgraded single-instance deployment serves the catalog without 503

- **WHEN** a single-instance deployment is upgraded to `vX.Y.Z` through the manual upgrade script or in-app self-update with the attestation applied
- **THEN** the `task-model-selection-v1` diagnostics report the gate open with all four role reports (`api`, `admission`, `scheduler`, `runtime`) ready for instanceId `cap-api-1` at the running build identity
- **AND** `/v1/runtime-models/query` returns a catalog result rather than a 503 preflight failure

#### Scenario: The next upgrade renews the attestation instead of recreating the 503

- **WHEN** that same deployment is later upgraded to `vX.Y.(Z+1)` through an official seam
- **THEN** the seam applies the new release's attestation whose `buildIdentity` matches the new image, and the catalog query succeeds after the upgrade without any manual re-attestation step

#### Scenario: A stale attestation from a bypassed seam still fails closed

- **WHEN** a deployment's api image is replaced outside the official seams so the running build identity no longer matches the persisted attestation's `buildIdentity`
- **THEN** the unchanged gate evaluation keeps the gate closed and catalog queries fail with the existing safe retryable catalog-unavailable semantics, rather than accepting a build-mismatched attestation

#### Scenario: Non-single-instance deployments keep the fence and the manual runbook

- **WHEN** a deployment does not satisfy the single-instance preconditions (e.g. a custom `CAP_INSTANCE_ID`, or more than one live cap api instance)
- **THEN** neither official seam writes an attestation for it, the gate remains closed with the existing legacy-worker-fence semantics, and opening the gate remains the multi-instance manual cutover procedure
