## MODIFIED Requirements

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

For legacy provisioning, cancellation that wins the Task transition SHALL
settle the primary as cancelled even if the provider promise later succeeds or
rejects. Cleanup SHALL remain pending across the physical-create/owner-record
window and SHALL become succeeded only from provider-confirmed removal or
absence. An `entered` create fence has not yet reached the bounded legacy
teardown disposition described above: it SHALL remain a transient cleanup and
capacity fence until the provider invocation settles and removal or absence is
proven, and it SHALL NOT be closed merely because a local join timed out. The
attempt SHALL receive its explicit completeness marker only after the cancelled
primary and non-pending cleanup are both durable; owner-row absence alone SHALL
NOT provide that cleanup or completeness evidence.

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

#### Scenario: Late provider rejection does not replace cancellation

- **WHEN** a cancelled legacy task's provider promise later rejects
- **THEN** the attempt primary remains cancelled with the last authoritative stage
- **AND** no provisioning failure replaces it or leaves the attempt active

#### Scenario: Cancelled attempt waits for physical cleanup proof

- **WHEN** cancellation races a physical sandbox create before running ownership is recorded
- **THEN** the attempt cleanup remains pending until the provider confirms removal or absence
- **AND** only then may the cancelled attempt be marked complete
