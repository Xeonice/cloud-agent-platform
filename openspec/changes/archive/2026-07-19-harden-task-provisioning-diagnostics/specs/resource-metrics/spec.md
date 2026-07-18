## ADDED Requirements

### Requirement: Provisioning diagnostics expose honest low-cardinality operational metrics

The session-authenticated aggregate metrics response SHALL add a provisioning
diagnostics block sourced from the same validated safe events and durable
ownership state used by provisioning diagnostics. The block SHALL report
bounded aggregates for attempt and stage duration, terminal outcomes, retries,
cleanup outcomes and failures, oldest active-attempt age, provider-owned orphan
or cleanup-pending sandbox count, and native execution settlement anomalies.
Settlement anomaly categories SHALL distinguish at least terminal failure or
kill without an exit code, invalid poll settlement, poll timeout or transport
failure, and non-fatal attach degradation.

Metric dimensions SHALL come only from closed, low-cardinality vocabularies such
as provider family, provisioning stage, operation kind, outcome, safe cause,
cleanup disposition, and settlement-anomaly kind. Metrics SHALL NOT be labeled
or keyed by task id, attempt id, logical operation id, sandbox id, native
execution id, repository, branch, account, URL, endpoint, request or filesystem
path, command kind, error text, or any credential-bearing value. Duration data
SHALL use bounded aggregate buckets or count/sum/max summaries rather than
retaining an unbounded per-operation time series.

Process-window counters SHALL expose the instant from which they were observed;
durable current gauges, including active attempts and orphan or cleanup-pending
runs, SHALL be rehydrated or reconciled after restart. An unavailable or stale
provisioning-metrics source SHALL mark only this additive block degraded and
SHALL NOT fail or rewrite the existing capacity, occupancy, runner-minutes, or
resource-sampling blocks.

#### Scenario: Stage settlement updates bounded aggregates

- **WHEN** one provisioning stage succeeds and another fails after measurable execution time
- **THEN** the metrics block increments their allowlisted outcome counts and duration aggregates
- **AND** it stores no per-task, per-attempt, per-operation, or raw diagnostic series

#### Scenario: A retry is measured without an attempt label

- **WHEN** a retryable provisioning failure schedules and begins another attempt
- **THEN** the retry aggregate increments once under bounded stage, provider-family, and safe-cause dimensions
- **AND** the attempt number and attempt id are not metric labels

#### Scenario: Cleanup failure and orphan state remain visible

- **WHEN** a primary provisioning failure is followed by an unconfirmed cleanup and reconciliation observes the provider-owned sandbox still present
- **THEN** cleanup-failure and cleanup-pending or orphan aggregates reflect that state independently from the primary failure aggregate
- **AND** successful later reconciliation removes the current orphan gauge without erasing the historical cleanup outcome count

#### Scenario: Missing exit and attach degradation are measured separately

- **WHEN** one native execution terminalizes as failed without an exit code and another loses attach while poll settlement succeeds
- **THEN** the settlement-anomaly metrics count the missing-exit failure and attach degradation in distinct bounded categories
- **AND** the attach anomaly does not increment the authoritative execution-failure outcome for the successfully polled execution

#### Scenario: Restart provenance is honest

- **WHEN** the API process restarts after counters have accumulated while durable active or orphan state still exists
- **THEN** resettable counters expose a new observation start time and durable gauges are rebuilt from reconciled state
- **AND** the response does not present reset counters as lifetime totals or report durable orphan state as zero merely because memory was cleared

#### Scenario: Metrics contain no diagnostic payload or identifier labels

- **WHEN** command text, prompt material, provider output, a request body, a filesystem path, and a credential canary are present in underlying failures
- **THEN** the serialized metrics response contains none of those values and no task, attempt, operation, sandbox, execution, repository, or account identifier
- **AND** only strict safe enum labels and bounded numeric aggregates are returned

#### Scenario: Provisioning metric degradation is isolated

- **WHEN** provisioning metric hydration or reconciliation is unavailable or stale
- **THEN** the provisioning diagnostics block reports its degraded status and freshness honestly
- **AND** the existing exact capacity and occupancy data plus sampled resource data retain their established availability semantics
