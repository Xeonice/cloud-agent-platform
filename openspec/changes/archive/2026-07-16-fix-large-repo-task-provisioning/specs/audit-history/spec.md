## ADDED Requirements

### Requirement: Provisioning history records structured stages and safe causes

The orchestrator SHALL durably record task-correlated provisioning progress and
terminal provisioning causes so an operator can distinguish acceptance,
sandbox creation, remote-ref resolution, repository transfer, checkout,
submodules, runtime setup, readiness, and cleanup without accessing ephemeral
sandbox logs. A terminal provisioning detail SHALL carry a stable safe cause
covering at least capacity exhaustion, timeout, forge authentication,
TLS/network, missing branch/ref, and an unknown fallback, plus attempt and
timestamp information. It SHALL accompany rather than replace the central task
lifecycle transition.

Audit descriptions and structured fields SHALL NOT contain a forge token,
authorization header, credential-bearing URL, temporary secret content/path,
authenticated command, raw exec request, provider endpoint, or unsanitized git
output. Recording stage/audit detail SHALL be idempotent across admission lease
replay, and failure to persist a progress event SHALL NOT block the controlled
provisioning action; the durable admission work state remains the recovery
source of truth.

#### Scenario: Disk exhaustion is recorded after authenticated refs succeed

- **WHEN** refs authentication succeeds and repository transfer later fails with filesystem capacity exhaustion
- **THEN** audit history records the repository-transfer stage and capacity-specific safe cause
- **AND** the central terminal task event is still recorded

#### Scenario: Clone timeout is distinct from control-plane failure

- **WHEN** workspace materialization exceeds its Git deadline
- **THEN** audit history records a workspace timeout at the active stage
- **AND** it does not report a forge credential rejection or generic BoxLite health failure

#### Scenario: Lease replay does not duplicate terminal detail

- **WHEN** a worker loses its lease after persisting a terminal provisioning cause and recovery replays the work item
- **THEN** the same idempotency identity prevents a duplicate terminal detail event
- **AND** task settlement remains exactly once

#### Scenario: Secret canary never reaches history

- **WHEN** a private-repository provisioning test uses a unique credential canary and exercises success, failure, timeout, retry, and retention
- **THEN** the canary is absent from audit rows, task failure projections, structured logs, and retained workspace credential files
