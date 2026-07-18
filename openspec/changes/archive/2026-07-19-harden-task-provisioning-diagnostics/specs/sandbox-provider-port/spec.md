## ADDED Requirements

### Requirement: Task provisioning context carries a provider-neutral diagnostic emitter

Every task-scoped `SandboxProvisionContext` SHALL carry an attempt-scoped,
provider-neutral diagnostic emitter created by orchestration before the first
provider operation. The emitter SHALL accept only the shared strict diagnostic
event union and SHALL supply task, attempt, event-idempotency, and timestamp
correlation without exposing persistence or logging implementations to provider
packages. Providers SHALL report safe operation facts through CAP-generated
operation correlation identities and
SHALL NOT import Prisma, an audit service, an application logger, or a
provider-specific diagnostic store. Taskless environment validation and health
probes SHALL use an explicitly non-persisting observer rather than fabricate a
task attempt.

#### Scenario: Provider emits without owning persistence

- **WHEN** a provider starts and settles a task-scoped sandbox operation
- **THEN** it emits validated operation facts through the diagnostic emitter in the provision context
- **AND** the provider package performs no database, audit, or application-log write directly

#### Scenario: Taskless validation creates no task evidence

- **WHEN** a provider validates an environment or health probe without an owning task
- **THEN** it uses the explicit non-persisting observer
- **AND** no synthetic task id or diagnostic attempt is created

### Requirement: Provider cleanup reports a secondary outcome without replacing the primary failure

A provider operation that creates or may create a sandbox-owned resource SHALL
attempt required cleanup on success, failure, timeout, cancellation, and
supersession paths. The provider SHALL return or emit a distinct cleanup outcome
and MUST preserve any preceding primary provisioning failure unchanged. Cleanup
outcomes SHALL distinguish confirmed success, definitive failure, and
indeterminate/unconfirmed deletion using safe typed facts. Orchestration SHALL
record each physical result as cleanup-attempt evidence. For a durable owner,
any failed, indeterminate, or unconfirmed physical attempt SHALL leave canonical
cleanup `pending` while authoritative status remains deleting; only confirmed
removal or the configured atomic terminal policy may settle canonical cleanup.
A cleanup result SHALL contain no
raw provider error, resource endpoint, command, output, or credential material.

Physical provider deletion/confirmation failures are secondary to an already
recorded provisioning failure. Failures to authorize or acknowledge cleanup
through the ownership/lease/database fence are orchestration coordination errors
and SHALL retain durable worker recovery semantics rather than being downgraded
to ordinary physical cleanup failures.

#### Scenario: Cleanup failure follows a primary failure

- **WHEN** a provider operation fails and the subsequent cleanup also fails
- **THEN** the provider reports the original operation as the primary failure
- **AND** it reports the physical cleanup attempt as separate secondary evidence without replacing the primary error or prematurely settling durable cleanup authority

#### Scenario: Delete response is not proof of absence

- **WHEN** a provider accepts a delete request but resource absence cannot be confirmed
- **THEN** the provider reports an indeterminate physical result that orchestration projects as cleanup pending with a stable safe cause
- **AND** it does not report cleanup success merely because the delete request returned

## MODIFIED Requirements

### Requirement: Provider conformance covers terminal, executor, workspace, and ownership contracts

Provider conformance SHALL verify every provider family eligible for task
provisioning, including AIO, cloud-http, and BoxLite, not only basic provision/teardown shape, but
also the provider's advertised terminal transport, command executor, workspace
transfer, readoption, retention, transcript, ownership, diagnostic emission, and
cleanup behavior. Conformance SHALL fault-inject provider operation failure,
timeout, cancellation, indeterminate settlement, and cleanup failure and SHALL
verify bounded events, stable correlation, primary/cleanup preservation, and
secret absence. A provider SHALL NOT advertise a capability that does not pass
its conformance scenario.

#### Scenario: Terminal capability requires terminal conformance

- **WHEN** a provider declares interactive terminal capability
- **THEN** conformance verifies output, input, resize, close/replacement, and attach semantics

#### Scenario: Workspace delivery capability requires executor ownership

- **WHEN** a provider declares workspace delivery capability
- **THEN** conformance verifies delivery commands run in the provider-owned sandbox for the selected task

#### Scenario: Task provisioning requires diagnostic conformance

- **WHEN** a provider is eligible for task provisioning
- **THEN** conformance verifies its create, execution, settlement, cancellation, and cleanup paths emit bounded correlated safe outcomes
- **AND** a secret canary and raw provider diagnostic are absent from every emitted and persisted event

#### Scenario: Cleanup conformance preserves the primary failure

- **WHEN** conformance injects an operation failure followed by a cleanup failure
- **THEN** the provider returns the operation failure as primary and cleanup as secondary
- **AND** no cleanup exception replaces the primary failure

#### Scenario: Every eligible provider family passes diagnostic conformance

- **WHEN** AIO, cloud-http, and BoxLite are each eligible for task provisioning
- **THEN** each family passes bounded start/settlement, cancellation, cleanup, correlation, and secret-canary conformance
- **AND** Guardrails supplies shared outer-boundary evidence where a provider has no finer native operation

### Requirement: Workspace materialization reports bounded stages and typed failures

Provider workspace materialization SHALL execute under a deadline independent
from control-plane request timeouts and SHALL report stable stages covering
credential setup, remote-ref resolution, repository transfer, checkout,
submodules, and credential cleanup. Failures SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results. Each logical stage SHALL emit
at most one correlated start and one terminal or degraded diagnostic outcome,
and the emitted stage/cause SHALL agree with the provider-neutral result.
Diagnostic events SHALL NOT contain repository URLs, command or argv text,
stdout/stderr, temporary credential paths, request bodies, or raw Git/provider
errors. Cleanup SHALL execute in all success, failure, timeout, cancellation,
and retry paths, a cleanup failure SHALL remain secondary to the materialization
failure, and a retry SHALL be idempotent for the same task/workspace plan.

#### Scenario: Slow repository uses the workspace deadline

- **WHEN** repository transfer exceeds the provider's short control-plane timeout but completes within the configured workspace deadline
- **THEN** materialization continues and succeeds
- **AND** unrelated BoxLite health/create/inspect requests retain their shorter timeout

#### Scenario: Disk exhaustion is distinguishable from authentication

- **WHEN** repository transfer fails because the guest filesystem is full after refs authentication succeeded
- **THEN** the provider returns the transfer stage with a capacity-exhaustion reason
- **AND** it does not misclassify the failure as an invalid forge credential

#### Scenario: Cancellation cleans temporary authentication

- **WHEN** a task is stopped or a materialization lease is superseded during repository transfer
- **THEN** provider execution is cancelled or fenced
- **AND** temporary credentials are removed before the sandbox is retained or deleted

#### Scenario: Materialization failure survives credential-cleanup failure

- **WHEN** repository transfer fails and removing its temporary credential state also fails
- **THEN** the transfer stage and its safe primary cause remain unchanged
- **AND** credential cleanup is emitted as a separate safe cleanup outcome
