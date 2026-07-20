## MODIFIED Requirements

### Requirement: Provisioning diagnostic logs carry a bounded safe causal envelope

Every provisioning attempt SHALL mirror its provider-neutral diagnostic events
to structured application stdout using the same validated, versioned envelope
that is accepted by the durable diagnostic recorder. Each event SHALL carry its
`schemaVersion`, owning `taskId`, a CAP-generated `attemptId`, the nonnegative
attempt number, a CAP-generated logical `operationId`, admission mode, a closed
CAP provider-family value, an allowlisted provisioning stage and operation kind,
an allowlisted event state or outcome, and its occurrence time. Terminal or
degraded operation summaries SHALL additionally carry only allowlisted causal
facts that apply, such as duration, safe cause code, retryability, HTTP status
class or code, normalized native status, normalized exit code, timeout state,
and whether the event describes the primary operation or secondary cleanup.

When process settlement and output settlement use independent provider channels,
diagnostics SHALL preserve them as separate bounded facts. A proven process
result SHALL NOT be rewritten by output-channel degradation, while an
output-dependent consuming operation SHALL NOT be reported as successful unless
output completion is also proven. The consuming failure SHALL use the existing
allowlisted `transport_failed`, `protocol_failed`, or `settlement_unknown` cause
that matches the failure and SHALL NOT fabricate a non-zero command exit code or
add a new public diagnostic discriminator.

Task terminal state, primary attempt state, cleanup outcome, and audit SHALL
agree on the same lifecycle winner. When cancellation wins while provisioning
is in flight, later provider success or failure SHALL NOT emit a competing
`provision_failed` log/audit or leave the attempt active. The primary SHALL
settle as cancelled, while cleanup SHALL remain independently pending until a
provider confirms deletion or absence. A synthetic success derived only from a
missing owner row is forbidden.

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

#### Scenario: Attach degradation stays distinct from authoritative process settlement

- **WHEN** native attach cannot prove output drain but polling proves that the process completed successfully
- **THEN** diagnostics emit one bounded degraded attach summary and one successful authoritative process-settlement summary
- **AND** the output-dependent consuming operation fails with the matching existing safe transport, protocol, or settlement outcome without changing the proven native state or exit code
- **AND** no command, output, frame, poll response, or raw provider error is emitted

#### Scenario: Logs and persistence share event identity

- **WHEN** a provisioning diagnostic event is accepted for durable persistence and mirrored to stdout
- **THEN** both representations carry the same task id, attempt id, operation id, stage, outcome, safe cause, and event identity
- **AND** no operator must correlate the records by timestamps or free-form message text alone

#### Scenario: Stop wins over a late provisioning failure

- **WHEN** a task is cancelled while provider provisioning is in flight and that provider later rejects
- **THEN** the task and diagnostic primary remain cancelled and no later force-failed audit or `provision_failed` terminal claim is emitted
- **AND** the attempt becomes complete only after its independent cleanup outcome is provider-confirmed

#### Scenario: Cleanup success carries physical evidence

- **WHEN** terminal cleanup runs before legacy ownership has reached running state
- **THEN** cleanup succeeds only after a provider reports found-and-cleaned or confirmed absence
- **AND** an empty persistence lookup cannot by itself produce a succeeded cleanup summary
