# sandbox-provider-port Specification (delta)

## ADDED Requirements

### Requirement: Archive workspace transfer feeds the provisioning progress snapshot

Archive-variant workspace materialization SHALL report byte-based transfer progress into the existing provisioning progress snapshot (the `workspace_transfer` stage's percent/receivedBytes/throughput projection) so task reads surface live transfer feedback with no wire-schema change. Snapshot writes SHALL be time-throttled to at most one write per second. The total size SHALL be estimated from the stored copy's disk usage, with percent capped below 100 until the transfer completes; when no estimate is available, percent SHALL be null (the existing indeterminate semantics, never rendered as 0%). On deployments without a provisioning work row (legacy admission), progress reporting SHALL be silently skipped without affecting materialization.

#### Scenario: Large archive transfer exposes growing progress
- **WHEN** an archive injection transfers a copy large enough to span multiple throttle windows
- **THEN** successive task reads during the transfer expose the `workspace_transfer` stage with increasing receivedBytes and a percent value derived from the estimated total

#### Scenario: Writes are throttled to one per second
- **WHEN** many parts complete within one second
- **THEN** at most one progress snapshot write occurs for that second

#### Scenario: Legacy admission skips progress silently
- **WHEN** the deployment runs legacy admission with no provisioning work row
- **THEN** the transfer proceeds normally and no progress write is attempted or errored
