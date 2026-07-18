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

### Requirement: Provisioning diagnostic logs carry a bounded safe causal envelope

Every provisioning attempt SHALL mirror its provider-neutral diagnostic events
to structured application stdout using the same validated, versioned envelope
that is accepted by the durable diagnostic recorder. Each event SHALL carry its
`schemaVersion`, owning `taskId`, a CAP-generated `attemptId`, the nonnegative attempt number, a
CAP-generated logical `operationId`, admission mode, a closed CAP provider-family
value, an allowlisted provisioning stage and operation kind, an allowlisted
event state or outcome, and its occurrence time.
Terminal or degraded operation summaries SHALL additionally carry only
allowlisted causal facts that apply, such as duration, safe cause code,
retryability, HTTP status class or code, normalized native status, normalized
exit code, timeout state, and whether the event describes the primary operation or
secondary cleanup.

The envelope SHALL be a strict discriminated union rather than an arbitrary
metadata or diagnostic bag. A logical provider operation SHALL emit at most one
start event and one terminal or degraded summary; BoxLite poll ticks, attach
frames, and command output chunks SHALL NOT produce one log record each. The
same event identity and correlation values SHALL be used in stdout and durable
diagnostic persistence so an operator can join both sources without parsing a
message string.

#### Scenario: A failed native execution remains causally queryable

- **WHEN** a BoxLite runtime-setup execution starts and later settles as failed without a native exit code
- **THEN** stdout contains a structured start event and one terminal safe-cause event with the same task, attempt, and logical operation correlation
- **AND** the terminal event identifies the allowlisted missing-exit settlement anomaly without a command, output, or raw provider error

#### Scenario: Attach degradation stays distinct from authoritative settlement

- **WHEN** native attach fails but polling proves that the execution completed successfully
- **THEN** the operation emits one bounded degraded attach summary and one successful authoritative settlement summary
- **AND** the degraded summary does not change the successful execution outcome or expand into per-frame or per-poll logs

#### Scenario: Logs and persistence share event identity

- **WHEN** a provisioning diagnostic event is accepted for durable persistence and mirrored to stdout
- **THEN** both representations carry the same task id, attempt id, operation id, stage, outcome, safe cause, and event identity
- **AND** no operator must correlate the records by timestamps or free-form message text alone

### Requirement: Provisioning diagnostic logs exclude payload and provider-private data

Provisioning diagnostic emission SHALL classify raw failures before the raw
value is discarded, but SHALL NOT serialize that value or derive an unbounded
message from it. Diagnostic log records SHALL exclude command or argument text,
stdout, stderr, combined output, prompts, provider request or response bodies,
HTTP or WebSocket headers, repository-authenticated URLs, provider endpoints or
request paths, guest or host filesystem paths, temporary credential paths,
environment or configuration dumps, tokens, credentials, lease owners,
provider-native sandbox/resource/execution or connection metadata, stack traces,
and raw error messages or causes. Only CAP-generated attempt/event/operation
identities MAY join diagnostic records; raw provider identifiers remain confined
to existing internal ownership state where cleanup requires them. This
restriction SHALL apply to successful, failed,
timed-out, cancelled, indeterminate, cleanup, and late-settlement paths.

Generic HTTP access logging MAY continue to record the CAP request path required
by the existing access-log contract; that access path SHALL NOT be copied into
the provisioning diagnostic envelope. Redaction SHALL be defense in depth: an
event that does not validate against the strict safe envelope SHALL be rejected
before it reaches either stdout or persistence rather than relying on key-name
redaction to make an unsafe object acceptable. As defense in depth, the shared
structured logger SHALL redact nested fields named for commands or arguments,
stdout, stderr, output, prompts, bodies or responses, URLs or endpoints,
headers, environments, credentials, secrets, paths, and provider error objects
if an unsafe caller attempts to log one outside the diagnostic recorder.

#### Scenario: A secret-bearing provider failure is reduced to safe facts

- **WHEN** a provider error message, cause, stack, response body, output, command, or temporary path contains a unique credential canary
- **THEN** the emitted diagnostic contains only its allowlisted stage, operation, outcome, numeric facts, and safe cause code
- **AND** neither the canary nor any raw, encoded, or path-bearing form of the source value appears in structured stdout

#### Scenario: Successful commands are not logged either

- **WHEN** a runtime-setup or cleanup command succeeds
- **THEN** the diagnostic summary may identify only its allowlisted `commandKind`, timing, and outcome
- **AND** the shell command, arguments, prompt material, working directory, and output are absent

#### Scenario: Invalid diagnostic metadata fails closed

- **WHEN** a provider attempts to attach an unknown field, free-form diagnostic message, provider request path, or provider connection metadata to a provisioning event
- **THEN** strict envelope validation rejects that field before logging or persistence
- **AND** provisioning records a bounded safe fallback outcome without forwarding the rejected value

