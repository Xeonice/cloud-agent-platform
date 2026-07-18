## ADDED Requirements

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
