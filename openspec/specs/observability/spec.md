# observability Specification

## Purpose
TBD - created by archiving change structured-logging. Update Purpose after archive.
## Requirements
### Requirement: Structured JSON application logging to stdout

The api SHALL emit ALL operational logs as single-line structured JSON to stdout (no separate
file/network sink owned by the app), via a pino-based logger that transparently backs NestJS's
`LoggerService` so existing `Logger` call sites are unchanged. NestJS framework logs (bootstrap,
route mapping) SHALL flow through the same logger so there is no plain-text/JSON split. Each log
record SHALL carry at minimum a severity `level`, a timestamp, and a message. The log level SHALL
be configurable via an environment variable (default `info`) WITHOUT a code change.

#### Scenario: App logs are structured JSON on stdout
- **WHEN** the api emits any operational log (app or framework)
- **THEN** the line written to stdout is valid JSON carrying at least `level`, a timestamp, and the message

#### Scenario: Log level is environment-driven
- **WHEN** the configured log level is `info`
- **THEN** `debug` lines are suppressed and `info`/`warn`/`error` lines are emitted
- **AND** raising the level to `debug` (env change + restart) emits `debug` lines without any code change

### Requirement: Request and task correlation on logs

Logs SHALL be correlatable so an operator can retrieve every log line for a single unit of work.
Each HTTP request SHALL be assigned a stable request id and every log emitted during that request
SHALL carry it. Logs emitted on a task-scoped path that runs OUTSIDE an HTTP request (lifecycle
timers, terminal/WebSocket events, exit handling) SHALL carry the owning `taskId` so that "all
logs for task X" is a single field filter. One structured HTTP access log SHALL be recorded per
request, carrying the method, path, response status, duration, and the authenticated user
identity when present.

#### Scenario: Logs within a request share a request id
- **WHEN** the api handles an HTTP request that emits multiple log lines
- **THEN** every line for that request carries the same request id
- **AND** a single HTTP access-log line records the method, path, status, duration, and user (when authenticated)

#### Scenario: Task-scoped logs carry the task id
- **WHEN** a log is emitted on a task-scoped path outside any HTTP request (e.g. exit handling, a guardrail timer, a terminal event)
- **THEN** the log line carries the owning `taskId`
- **AND** filtering logs by that `taskId` yields the task's operational log trail

### Requirement: Secret redaction in logs

Structured logging SHALL NOT widen the secret surface. The logger SHALL redact credential material
before it is written, covering at minimum the `Authorization` header / bearer tokens, the session
cookie (request and response `Cookie`/`Set-Cookie`), the OAuth client secret, the codex credential
encryption key, and compatible-provider API keys. Whole configuration/environment objects SHALL
NOT be logged. A redacted value SHALL appear as a placeholder rather than its content.

#### Scenario: Credentials are redacted in request logs
- **WHEN** a request carrying an `Authorization` header, a session cookie, or an API key is logged
- **THEN** those values appear as a redaction placeholder, never their plaintext

#### Scenario: Secrets are never emitted
- **WHEN** any log line is written
- **THEN** it contains no session secret, OAuth client secret, codex credential encryption key, or provider API key value

### Requirement: Bounded Docker log retention

Container stdout logs SHALL be bounded so they cannot grow without limit or vanish unpredictably.
The api service (and the other long-lived compose services) SHALL configure the `json-file` log
driver with a maximum size and file count, giving each container a hard disk ceiling with
rotation. Per-task sandbox containers created at runtime SHALL likewise be created with a bounded
log configuration so a chatty agent run cannot exhaust host disk.

#### Scenario: Long-lived service logs are size-bounded
- **WHEN** the api container has been running and producing logs
- **THEN** its Docker `json-file` log config has a configured `max-size` and `max-file`
- **AND** logs rotate at the ceiling rather than growing unbounded

#### Scenario: Per-task sandbox logs are bounded
- **WHEN** the orchestrator provisions a per-task sandbox container
- **THEN** that container is created with a bounded log configuration (size + file count)

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

