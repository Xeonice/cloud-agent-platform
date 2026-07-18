# task-provisioning-diagnostics Specification

## Purpose
TBD - created by archiving change harden-task-provisioning-diagnostics. Update Purpose after archive.
## Requirements
### Requirement: Every task provisioning attempt has a stable durable identity

The system SHALL mark each newly accepted Task with the diagnostic schema
version expected from its writer and SHALL create a task-owned diagnostic
attempt only when an actual processing attempt wins running capacity and before
provider selection or the first external provider operation, with a stable identifier,
a task-local monotonically increasing attempt number, the admission mode
(`legacy` or `durable`), lifecycle state, current safe stage, and server-assigned
timestamps. The attempt SHALL exist independently of the originating HTTP or MCP
request and SHALL reach exactly one terminal state of `succeeded`, `failed`, or
`cancelled`, or `interrupted`, with an interrupted attempt retaining an
indeterminate safe outcome when settlement cannot be proved. Re-emission within
the same valid claim and attempt identity SHALL reuse the active attempt. When
an expired lease is newly claimed after an open running/provider attempt,
recovery SHALL close that attempt as interrupted/indeterminate and SHALL create
the next attempt number before further provider work. A deliberately scheduled
retry SHALL create the next attempt only after the prior attempt has settled.
Reclaiming accepted or capacity-queued work that has no diagnostic attempt SHALL
NOT create one until running capacity is won. The attempt
identity SHALL NOT contain or derive from a provider sandbox id, endpoint,
repository credential, or command value.

Accepted or capacity-queued durable work that has not begun provider processing
SHALL expose its canonical admission state with `coverage = not_started` and no
fabricated attempt. Queue polling and promotion under the same durable work
lineage SHALL open exactly one diagnostic attempt only when running provider
processing begins. A terminal-recovery claim SHALL continue the existing attempt
when present and SHALL report partial/unavailable evidence when
it is absent; it SHALL NOT invent a complete attempt. Per-attempt event bounds
and a per-task attempt-detail ceiling SHALL keep repeated lease expiry bounded,
with explicit truncation/overflow evidence that always retains the current/latest
detailed attempt and bounded aggregate primary/cleanup counts.

#### Scenario: Legacy admission creates a durable diagnostic attempt

- **WHEN** a task uses the synchronous legacy admission path, wins running capacity, and enters provider processing
- **THEN** the system creates a durable diagnostic attempt before provider selection or the first external provider operation
- **AND** the attempt remains queryable after the create request disconnects or container logs rotate

#### Scenario: Expired running lease re-claim creates the next attempt

- **WHEN** a durable admission lease expires while its running/provider diagnostic attempt is open and another worker newly claims the admission work
- **THEN** recovery closes the old active attempt as interrupted with an indeterminate outcome and creates the next task-local attempt
- **AND** it links or readopts any proven provider-owned sandbox without merging the two attempts' events

#### Scenario: Accepted or queued work has not started a provider attempt

- **WHEN** durable work is committed but unclaimed, or is waiting for running capacity
- **THEN** diagnostics report `coverage = not_started` together with the canonical accepted or queued admission state
- **AND** no provider attempt or failure is fabricated

#### Scenario: Terminal recovery does not fabricate missing history

- **WHEN** terminal recovery observes a task whose expected diagnostic attempt is absent or incomplete
- **THEN** it reports partial or unavailable evidence according to the task's diagnostic schema marker
- **AND** it does not create a synthetic complete attempt

#### Scenario: Re-emission within one valid claim is idempotent

- **WHEN** the same valid worker claim re-emits an event for its current attempt identity
- **THEN** the active attempt is reused and the existing event identity is left unchanged
- **AND** no extra attempt or duplicate operation outcome is created

#### Scenario: A bounded retry receives a new attempt number

- **WHEN** admission classifies an attempt as retryable and schedules a new provider attempt
- **THEN** the retry receives the next task-local attempt number and a new stable attempt id
- **AND** the previous attempt remains terminal and unchanged

### Requirement: Provisioning event detail is immutable bounded and safe by construction

Each diagnostic attempt SHALL own a sequence of versioned events represented by
a strict discriminated union rather than an arbitrary metadata bag. Retained
events SHALL be immutable after insert, and normal recorder writes SHALL be
append-only. Every event SHALL carry a supported `schemaVersion`, a stable event and idempotency identity, task and attempt
correlation, a bounded stage and operation kind, an outcome, a server timestamp,
and only the allowlisted numeric, boolean, enum, and bounded-string facts defined
for that operation. Supported outcomes SHALL distinguish at least `started`,
`succeeded`, `failed`, `timed_out`, `cancelled`, `degraded`, and
`indeterminate`. A terminal event SHALL carry a stable safe cause and retryability
when applicable. Runtime setup events SHALL identify commands only through an
allowlisted `commandKind`; the system MUST NOT derive a kind by parsing shell
text.

The event recorder SHALL retain at most one start and one terminal or degraded
summary for a logical provider operation and SHALL NOT persist every polling
tick, streaming frame, or repeated equivalent callback. The ledger SHALL apply a
configured per-attempt bound without dropping the attempt terminal outcome,
primary failure, cleanup outcome, or an explicit truncation marker. Repeating an
event with the same idempotency identity SHALL be a no-op.

The ledger SHALL also enforce a configured per-task detailed-attempt ceiling.
When repeated lease expiry reaches that ceiling, a controlled database
transaction SHALL first advance a fixed-schema overflow summary containing the
compacted attempt-number range, bounded counts by closed primary/cleanup outcome,
and an honest truncation count; it MAY then delete event and detailed-attempt rows
only for the oldest fully terminal, cleanup-settled attempts. It SHALL NOT compact
the active/latest or cleanup-pending attempt. A task-level monotonic next-attempt
counter SHALL preserve numbering after detail removal. Controlled compaction and
task retention/deletion are the only permitted event-detail deletion paths, and
the canonical read SHALL expose the summary with `coverage = partial`. This
diagnostic bound SHALL NOT change admission retry or recovery authority.

#### Scenario: Repeated provider polling remains bounded

- **WHEN** a provider polls the same native execution many times before settlement
- **THEN** the ledger records a bounded operation start and final settlement rather than one event per poll tick
- **AND** the attempt remains below its configured event bound

#### Scenario: Same-attempt event replay is idempotent

- **WHEN** a recovered worker emits an event whose idempotency identity was already persisted
- **THEN** the recorder leaves the existing event unchanged and creates no duplicate sequence entry

#### Scenario: Runtime setup records only an allowlisted command kind

- **WHEN** a runtime setup action completes or fails
- **THEN** its event identifies the action through its declared allowlisted `commandKind`
- **AND** no shell text is parsed, persisted, or returned to infer that kind

#### Scenario: Controlled compaction bounds task-owned storage

- **WHEN** cleanup-settled historical attempts reach the configured per-task detail ceiling
- **THEN** one transaction persists the typed overflow summary before deleting only the oldest terminal detail
- **AND** the latest and cleanup-pending attempts remain intact, attempt numbering stays monotonic, and reads report partial coverage with an honest truncation count

### Requirement: Diagnostic persistence contains no raw provider or secret material

The system SHALL keep diagnostic attempts, events, summaries, logs, metrics,
REST responses, MCP results, OpenAPI examples, and Console projections free of command or
argv text, stdout or stderr, request or response bodies, headers, tokens,
credential-bearing URLs, temporary credential paths or contents, prompts,
environment dumps, provider endpoints, native connection URLs, raw provider
resource or execution identifiers, lease-owner
identities, stack traces, or arbitrary provider diagnostics. Provider family,
safe stage and operation enums, duration, HTTP status class, normalized native
terminal state, nullable exit code, retryability, stable safe cause, and bounded
CAP-generated attempt/event/operation correlation identifiers SHALL be recorded
only through the strict allowlist. Raw provider resource/execution identifiers
SHALL remain confined to existing internal ownership records when cleanup
requires them and SHALL be absent from diagnostic persistence, logs, metrics,
REST, MCP, OpenAPI, Playground, and Console. Any value that fails the diagnostic
schema or redaction policy SHALL be rejected
before persistence and emission.

#### Scenario: A secret canary never reaches a diagnostic surface

- **WHEN** private-repository provisioning injects a unique canary into credentials, commands, output, provider bodies, and cleanup errors
- **THEN** the canary is absent from persisted attempts and events, structured logs, metrics, audit, REST, MCP, OpenAPI examples, and Console responses

#### Scenario: An arbitrary provider diagnostic is rejected

- **WHEN** a provider attempts to emit an undeclared field, raw response body, stack, or unbounded string
- **THEN** the diagnostic boundary rejects that field or event before it is persisted or logged
- **AND** provisioning control flow continues according to the underlying operation result

### Requirement: Primary provisioning and cleanup outcomes remain independent

Every terminal attempt SHALL preserve its primary provisioning outcome
independently from a secondary cleanup outcome. Cleanup SHALL have a distinct
state of `not_required`, `pending`, `succeeded`, or `failed`, plus bounded safe
cause and timestamps when applicable. A cleanup exception MUST NOT replace,
rewrite, or reclassify the primary failure. When deletion or retention cleanup
cannot be confirmed, the attempt SHALL remain terminal for task lifecycle
purposes while its cleanup state remains queryable and eligible for bounded
reconciliation.

A provider-level indeterminate, unconfirmed, or failed physical deletion attempt
SHALL update bounded attempt evidence without directly changing durable cleanup
authority. While `SandboxRun.status = deleting`, canonical cleanup SHALL remain
`pending` with a stable safe cause. It SHALL become `succeeded` only after
confirmed removal/absence, or `failed` only when the configured reconciliation
terminal policy atomically sets the authoritative run to `failed` and relinquishes
ownership. The durable work lease and concurrency slot SHALL remain owned until
one of those authoritative transitions. Legacy admission MAY release its
process-local slot after its bounded best-effort teardown disposition because it
has no fenced automatic cleanup owner, while retaining honest pending/failed
evidence and creating no recovery authority. In contrast,
ownership/lease/database failures while authorizing or acknowledging cleanup
SHALL remain orchestration coordination outcomes so the durable worker keeps its
lease/recovery semantics; they SHALL NOT erase the already-persisted primary
causal fact or be misreported as an ordinary physical delete failure.

#### Scenario: Runtime setup and cleanup both fail

- **WHEN** runtime setup produces a primary failure and deleting the provider sandbox also fails
- **THEN** the attempt preserves the runtime-setup failure as its primary outcome
- **AND** it records the physical cleanup-attempt failure separately while durable canonical cleanup remains pending until its authority settles

#### Scenario: Cleanup cannot confirm deletion

- **WHEN** provider deletion returns but sandbox absence cannot be confirmed
- **THEN** the task lifecycle may settle while the attempt records cleanup as pending with a stable confirmation-unknown cause
- **AND** durable reconciliation retains its lease and slot while retrying from the authoritative deleting state without fabricating provisioning success

#### Scenario: Terminal cleanup policy relinquishes durable ownership

- **WHEN** bounded reconciliation reaches its configured terminal policy without confirming removal
- **THEN** it atomically moves the authoritative SandboxRun to failed, records canonical cleanup failed, and relinquishes its durable lease and slot exactly once
- **AND** the primary provisioning outcome remains unchanged

### Requirement: Diagnostic evidence outlives ephemeral operational logs without replacing audit

The system SHALL retain the bounded diagnostic projection, compaction summary,
and non-compacted attempt detail for at least as long as their owning task remains
retained and SHALL NOT be deleted by the operational-log retention window or an
API/container restart. Controlled task-level compaction MAY remove only the old
terminal detail described by the event-bound requirement. Task deletion or the
platform's explicit task-retention policy SHALL remove the remaining task-owned
ledger according to the same ownership boundary. The lifecycle audit SHALL continue to
record durable product milestones and terminal safe causes; the system SHALL NOT
duplicate every provider operation event into `audit_events`.

Coverage SHALL use the closed states `not_started`, `partial`, `complete`, and
`unavailable`. `complete` requires an explicit durable terminal completeness
marker plus verified sequence/operation invariants and a cleanup state other than
pending. A write failure, sequence gap, interrupted attempt, compaction/truncation
marker, terminal Task with an active or cleanup-pending attempt, or unsupported event version SHALL remain `partial`; lack of observed
gap evidence alone SHALL NOT prove completeness.

#### Scenario: Logs rotate after a provisioning failure

- **WHEN** Docker or aggregated operational logs containing a failed attempt rotate or expire
- **THEN** the owning task's bounded detailed attempts plus any typed compaction summary, primary outcome, cleanup outcome, and retained safe events remain queryable

#### Scenario: Diagnostic events do not flood lifecycle audit

- **WHEN** a provisioning attempt performs multiple native provider operations
- **THEN** those bounded operation events remain in the task-owned diagnostic ledger
- **AND** audit history records only its existing lifecycle and provisioning milestones

### Requirement: Authorized callers query one canonical paginated diagnostic projection

The system SHALL expose one canonical, secret-free task provisioning diagnostic
response containing evidence availability, attempt summaries, primary and
cleanup outcomes, and keyset-paginated operation events with a bounded maximum
page size. The operation SHALL declare `tasks:diagnostics`; any principal that
carries a scope set SHALL contain it explicitly. Public V1 and MCP SHALL also
require a non-null authenticated account owner and `ownerPolicy = required`.
Identity-less principals and tasks whose `ownerUserId` is null SHALL return no
public/MCP evidence. Session-authenticated Console reads SHALL allow the
task owner and SHALL allow an enabled `role = admin` account to inspect another
owner's task only after a live User-row recheck. A principal lacking the diagnostic scope, owner identity, ownership,
or administrator role SHALL receive no diagnostic evidence. Ordinary Task
create/list/get/stop responses SHALL remain unchanged and SHALL NOT embed the
diagnostic ledger.

For tasks that predate the ledger, the canonical response SHALL return an
explicit evidence-availability state with an empty event page; it SHALL NOT
fabricate attempts from generic audit prose or provider logs. REST, MCP, OpenAPI,
API Playground, and Console projections SHALL validate the same canonical safe
attempt and event schemas.

The public/MCP diagnostics operation SHALL remain behind a deployment capability
gate until every serving role supports the same schema, owner policy, scope
parser, and registry mapping. While closed it SHALL fail with a stable retryable
unavailable response and SHALL return no evidence.

#### Scenario: Owner reads diagnostics through Public V1 and MCP

- **WHEN** a task owner with `tasks:diagnostics` reads the same task through Public V1 and MCP
- **THEN** both transports return schema-equivalent attempt summaries and paginated safe events
- **AND** neither response contains provider-private or secret material

#### Scenario: Existing scoped credential gains no implicit access

- **WHEN** a previously minted API key or MCP token has `tasks:read` but lacks `tasks:diagnostics`
- **THEN** a diagnostic read is denied and returns no attempt or event evidence

#### Scenario: Identity-less legacy token cannot read diagnostics

- **WHEN** a scopeless legacy token without an account owner calls the Public V1 diagnostic operation
- **THEN** the owner-required boundary rejects it without reading or disclosing a task

#### Scenario: Capability gate fails closed during mixed deployment

- **WHEN** the diagnostics registry or scope-parser capability is not attested across every serving role
- **THEN** Public V1 and MCP return retryable `task_provisioning_diagnostics_unavailable`
- **AND** no diagnostic evidence or new diagnostics-scoped credential grant is enabled

#### Scenario: Administrator reads another owner's task through the Console route

- **WHEN** an enabled session account with `role = admin` opens diagnostics for another owner's task
- **THEN** the Console route returns the same canonical secret-free diagnostic projection
- **AND** a non-admin session that does not own the task is denied

#### Scenario: A pre-ledger task reports unavailable evidence

- **WHEN** an authorized caller reads a task created before diagnostic attempts were persisted
- **THEN** the response explicitly reports that detailed evidence is unavailable and returns no fabricated events
- **AND** the ordinary task lifecycle and safe failure projection remain readable through existing task operations
