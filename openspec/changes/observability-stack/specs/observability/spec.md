# observability Spec Delta — observability-stack

## ADDED Requirements

### Requirement: Opt-in durable log aggregation and query

The platform SHALL provide an OPT-IN aggregation layer that collects the structured stdout logs
into a durable, queryable store independent of any container's lifetime, enabled via a compose
profile and disabled by default. Collection SHALL ship container stdout to the store WITHOUT
coupling the application to the store (the app remains stdout-only) and WITHOUT requiring access to
the Docker control socket. The store SHALL be queryable by the correlation fields the structured
logs carry (`taskId`, `reqId`, `level`, `service`) both programmatically (a CLI / HTTP query API)
and, when the visualization layer is enabled, through a UI. The store SHALL run within the
single-host resource budget (filesystem-backed, no external object storage) and each aggregation
service SHALL declare a memory limit so it cannot starve the per-task sandboxes.

#### Scenario: Operational logs are durable beyond a container restart
- **WHEN** the aggregation profile is enabled and a task produces logs, then its container (or the api) is restarted/redeployed
- **THEN** the task's logs remain retrievable from the store after the restart
- **AND** they are retrievable by a single `taskId` query

#### Scenario: Collection does not require the Docker socket
- **WHEN** the log collector ships container stdout to the store
- **THEN** it does so by reading container log files read-only, without mounting the Docker control socket

#### Scenario: Aggregation services are memory-bounded
- **WHEN** the aggregation profile is running
- **THEN** each aggregation service has a configured memory limit

### Requirement: Operational logs are retained for 14 days

The aggregation store SHALL retain operational logs for approximately 14 days and SHALL
automatically delete data older than the window. This retention SHALL apply ONLY to the
operational log store; the `audit_events` record SHALL remain permanent and append-only and SHALL
NOT be deleted by this window.

#### Scenario: Logs older than the window are removed
- **WHEN** operational logs age past the 14-day retention window
- **THEN** the store compacts and deletes them automatically

#### Scenario: Audit events are not subject to the 14-day window
- **WHEN** the 14-day operational-log retention runs
- **THEN** `audit_events` rows older than 14 days still exist and remain queryable

### Requirement: Unified visualization of logs and audit without duplication

The platform SHALL provide an OPT-IN visualization layer (a SEPARATE compose profile from the
aggregation layer) that presents operational logs and the `audit_events` record in one pane. The
audit record SHALL be queried IN PLACE from its existing store via a READ-ONLY datasource — it
SHALL NOT be copied or dual-written into the log store. The visualization layer SHALL be reachable
ONLY through the authenticated tunnel and SHALL NOT be exposed on a bare public port.

#### Scenario: One pane shows both logs and audit
- **WHEN** the visualization profile is enabled
- **THEN** an operator can view operational logs (from the log store) and audit events (from the audit store) in the same tool
- **AND** the audit events are read in place, not duplicated into the log store

#### Scenario: Visualization is not publicly exposed
- **WHEN** the visualization layer is running
- **THEN** it is reachable only via the authenticated tunnel, never on a bare public port

### Requirement: Layers enable independently without breaking lower layers

Each observability layer SHALL be independently enableable/disableable via its own compose profile,
and disabling an upper layer SHALL NOT break a lower one. With the visualization layer disabled,
the aggregated logs SHALL remain present and queryable via the CLI/HTTP query API. With the
aggregation layer disabled, the always-on structured stdout + bounded Docker rotation (from
`structured-logging`) SHALL still capture logs.

#### Scenario: Visualization off, storage still queryable
- **WHEN** the visualization profile is stopped but the aggregation profile is running
- **THEN** the aggregated logs are still present and queryable via the CLI / HTTP query API

#### Scenario: Aggregation off, stdout floor still captures logs
- **WHEN** the aggregation profile is not running
- **THEN** logs are still emitted to stdout and retained under the bounded Docker log rotation

### Requirement: Optional error alerting

The platform SHALL support OPT-IN alerting on operational-log error conditions (e.g. an error-rate
spike), OFF by default. When enabled, an alert SHALL be deliverable to the operator's existing
notification channel (Telegram). The alerting MAY live in the visualization layer or in the
aggregation layer; whichever is chosen, enabling it SHALL NOT be required for the logging or
storage layers to function.

#### Scenario: Error spike notifies the operator when enabled
- **WHEN** alerting is enabled and operational-log errors exceed the configured condition
- **THEN** an alert is delivered to the operator's notification channel

#### Scenario: Alerting is off by default
- **WHEN** no alerting is explicitly enabled
- **THEN** no alerts are evaluated or delivered, and logging + storage still function
