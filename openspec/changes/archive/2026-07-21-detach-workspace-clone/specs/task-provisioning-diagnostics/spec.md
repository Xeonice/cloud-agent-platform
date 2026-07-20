# task-provisioning-diagnostics

## ADDED Requirements

### Requirement: Detached-job lifecycle is bounded events; per-poll progress is excluded

The detached workspace-transfer job SHALL appear in the diagnostic ledger as at
most one correlated start event and one terminal (or degraded) event per job,
emitted through the existing attempt-scoped diagnostic observer and subject to
the existing per-attempt event ceilings. Per-poll progress observations
(marker reads, percent updates, byte counts sampled by the parked loop) SHALL
NOT be recorded as diagnostic events — progress belongs exclusively to the
mutable provisioning-summary projection. Terminal events for liveness-gate
failures SHALL carry only safe numeric/enum facts (e.g. the gate that fired
and its configured window in milliseconds) and SHALL NOT contain progress-file
text, repository URLs, commands, or raw git output.

#### Scenario: Long transfer produces two events, not hundreds

- **WHEN** a detached transfer runs for many minutes and is polled dozens of times before succeeding
- **THEN** the diagnostic ledger for that job contains at most one start and one terminal event
- **AND** no event corresponds to an individual progress poll or percent update

#### Scenario: Heartbeat-gate failure records safe facts

- **WHEN** a transfer is terminated by the no-progress heartbeat gate
- **THEN** the job's terminal diagnostic event identifies the timeout cause with numeric gate facts (such as the configured window in ms)
- **AND** it contains no progress-file contents, URLs, command text, or raw git stderr

#### Scenario: Stop does not replace the primary cause

- **WHEN** a parked task is stopped and the detached job is killed during cleanup
- **THEN** the attempt's primary diagnostic outcome reflects the cancellation/stop cause
- **AND** cleanup of the job is reported as a secondary outcome without overwriting the primary one
