# sandbox-detached-jobs Specification (delta)

## ADDED Requirements

### Requirement: In-sandbox network clone is no longer the primary workspace materialization consumer

The detached-job primitive SHALL remain available for long-running in-sandbox work, but workspace materialization SHALL NOT depend on a detached in-sandbox network `git clone` by default; that consumer survives only behind the explicitly gated `git` fallback variant of the workspace source. The detached-job contracts (setsid survival, exit markers, atomic publish, killability) SHALL be preserved unchanged for their remaining consumers and for the gated fallback.

#### Scenario: Default materialization spawns no detached clone job
- **WHEN** a task provisions with default configuration on a provider supporting copy injection
- **THEN** no detached in-sandbox clone job is launched for workspace materialization

#### Scenario: Gated fallback still honors detached-job contracts
- **WHEN** the git fallback gate is enabled and materialization uses the legacy path
- **THEN** the detached clone job behaves per the existing detached-job requirements
