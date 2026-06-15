# observability Spec Delta — structured-logging

## ADDED Requirements

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
