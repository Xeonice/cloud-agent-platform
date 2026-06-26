## ADDED Requirements

### Requirement: Retained sandbox artifacts are provider-neutral

The retention system SHALL model retained task sandboxes as provider-owned artifacts rather than only stopped local AIO containers. AIO MAY retain stopped `cap-aio-*` containers; BoxLite MAY retain stopped boxes or provider snapshots when supported. The cleaner SHALL operate through provider retention descriptors and SHALL never remove a running sandbox.

#### Scenario: Cleaner handles AIO and BoxLite retained artifacts
- **WHEN** both AIO and BoxLite retained artifacts exist
- **THEN** the retention cleaner asks each provider retention adapter for eligible stopped artifacts
- **AND** removes only artifacts that provider marks as safe to remove

#### Scenario: Running BoxLite sandbox is never reaped
- **WHEN** the retention cleaner sees a BoxLite sandbox associated with a running task
- **THEN** it does not stop or delete that sandbox

### Requirement: Pre-stop trim and credential clearing use the selected executor

Before retaining or stopping a provider-backed sandbox, the system SHALL run runtime-declared trim and credential-clearing commands through the selected provider's command executor when the executor is reachable. Trim failures SHALL remain fail-open and SHALL NOT block teardown, retention, or slot release.

#### Scenario: BoxLite trim uses BoxLite executor
- **WHEN** a BoxLite-backed task reaches terminal teardown
- **THEN** runtime trim and credential-clearing commands run through the BoxLite command executor
- **AND** no AIO `/v1/shell/exec` URL is required

#### Scenario: Trim failure does not block retention
- **WHEN** the provider executor is unavailable during pre-stop trim
- **THEN** teardown and retention proceed and the failure is logged as best-effort

### Requirement: Durable transcript capture precedes provider-native retention

Provider-native retention, sleep, or snapshot operations SHALL NOT replace durable transcript capture. The system SHALL attempt to capture the runtime transcript through the selected provider before teardown completes, and provider-native retained artifacts SHALL be treated as replay/readoption support only.

#### Scenario: Snapshot is secondary to transcript archive
- **WHEN** a BoxLite-backed task reaches terminal state and BoxLite snapshot is enabled
- **THEN** CAP still attempts transcript capture through the selected provider before relying on the snapshot for any history path
