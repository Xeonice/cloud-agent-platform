## ADDED Requirements

### Requirement: Provision context carries resolved resources and deterministic workspace intent

The provider-neutral provision context SHALL carry the immutable resolved
sandbox resources plus a workspace materialization plan containing the
normalized repository URL, resolved branch, independent materialization
deadline, and an OPTIONAL typed exact-host credential descriptor. The plan
SHALL distinguish caller-supplied branch intent from the branch resolved for
checkout. A provider SHALL enforce every resolved resource it advertises and
SHALL fail eligibility before task sandbox creation when it cannot do so.

The credential descriptor SHALL be consumed only by a provider secret-write
primitive that does not place secret content in a guest command, argv,
environment, ordinary execution request field, connection metadata, audit
event, or log. Workspace commands SHALL receive only a temporary secret-file
path, and providers SHALL remove that file after use and before sandbox
retention.

#### Scenario: Provider receives immutable resources and branch

- **WHEN** orchestration provisions a task from a resolved environment and repository
- **THEN** the selected provider receives the snapshotted resources and resolved checkout branch in one provision context
- **AND** provider-specific orchestration does not re-read mutable environment defaults or invent a branch

#### Scenario: Secret content is absent from command execution

- **WHEN** a private workspace is materialized or pushed with an owner-scoped forge credential
- **THEN** command argv, command text, environment values, normal execution fields, logs, and persisted run metadata contain no credential value
- **AND** the provider consumes the secret through the redacted secret-write primitive and commands reference only its temporary path

#### Scenario: Explicit unsupported resource fails closed

- **WHEN** the resolved provision context contains a resource the provider cannot enforce
- **THEN** the provider rejects provisioning before creating a task sandbox
- **AND** orchestration records a safe provider/resource failure rather than silently ignoring the resource

### Requirement: Workspace materialization reports bounded stages and typed failures

Provider workspace materialization SHALL execute under a deadline independent
from control-plane request timeouts and SHALL report stable stages covering
credential setup, remote-ref resolution, repository transfer, checkout,
submodules, and credential cleanup. Failures SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results. Cleanup SHALL execute in all
success, failure, timeout, cancellation, and retry paths, and a retry SHALL be
idempotent for the same task/workspace plan.

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
