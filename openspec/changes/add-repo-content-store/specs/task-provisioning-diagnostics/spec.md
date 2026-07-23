# task-provisioning-diagnostics Specification (delta)

## ADDED Requirements

### Requirement: Workspace materialization diagnostics identify the injection variant and its stages

Task provisioning diagnostics for the workspace-materialization stage SHALL name the workspace source variant used (`volume`, `archive`, or `git`) and SHALL emit bounded stage events for the variant's own steps (e.g. mount preparation / archive transfer / in-sandbox local clone), under the existing guarantees: bounded event counts, immutable safe-by-construction detail, no raw secret material, and per-poll progress excluded from durable storage. Failures SHALL carry a typed cause sufficient to distinguish copy-not-ready, injection-transfer failure, and in-sandbox local-clone failure.

#### Scenario: Diagnostics name the variant
- **WHEN** a task provisions via `volume` injection
- **THEN** the attempt's workspace-materialization events identify the `volume` variant and its stages

#### Scenario: Typed failure distinguishes injection stages
- **WHEN** an archive transfer fails during materialization
- **THEN** the durable diagnostic identifies the transfer stage as the failure point, distinct from a local-clone failure
