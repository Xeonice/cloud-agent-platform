# account-settings Spec Delta — configurable-task-slots

## ADDED Requirements

### Requirement: System-level task slot ceiling setting
The system SHALL persist a single SYSTEM-LEVEL (instance-wide) task slot ceiling (`maxConcurrentTasks`) that is explicitly carved out from the per-account scoping rule: unlike per-account preferences (which "SHALL NOT leak across accounts"), this value is one shared setting for the whole deployment, stored in single-row system-level storage (fixed row identity with upsert semantics), NOT in the per-account preferences row. Any authenticated, allowlisted operator SHALL be able to read and write it through the established settings read/update surface, and a write by one operator SHALL be observed by every operator on subsequent reads. The update API SHALL validate the value against the shared contracts schema as an integer in the range 1–20 (default 5); an invalid value SHALL be rejected with HTTP 400 without mutating the stored value, and a valid update SHALL read back exactly on a subsequent read. On first boot, when no persisted row exists, the value SHALL be seeded from env `MAX_CONCURRENT_TASKS` (falling back to 5 when unset); thereafter the persisted value is authoritative over the env variable. A successful save SHALL propagate the new value synchronously (push, not poll) to the running concurrency semaphore so it takes effect without a process restart.

#### Scenario: Slot ceiling is shared across accounts
- **WHEN** allowlisted operator A saves a slot ceiling of 8 and allowlisted operator B subsequently reads settings
- **THEN** operator B's read returns 8 — both operators read and write the same single system-level value

#### Scenario: Valid ceiling update persists, reads back, and takes effect immediately
- **WHEN** an operator submits a settings update with a slot ceiling that is an integer between 1 and 20
- **THEN** the API responds 200 with the updated sanitized settings, a subsequent read returns exactly that value
- **AND** the running concurrency semaphore reflects the new ceiling immediately (observable via the metrics ceiling and the next admission decision) without a process restart

#### Scenario: Out-of-range ceiling is rejected without mutation
- **WHEN** an update submits a slot ceiling of 0, 21, a negative number, or a non-integer
- **THEN** the API responds with HTTP 400, the stored value is unchanged, and the live semaphore ceiling is unchanged

#### Scenario: First boot seeds the value from env
- **WHEN** settings are read on a deployment where no system-level row has ever been persisted and `MAX_CONCURRENT_TASKS=7` is set
- **THEN** the slot ceiling reads as 7 (and as 5 when the env variable is unset)

#### Scenario: Persisted value wins over env on subsequent boots
- **WHEN** a slot ceiling has been saved through the settings API and the process later restarts with a different `MAX_CONCURRENT_TASKS` value
- **THEN** the settings read and the effective semaphore ceiling both report the persisted value, not the env value
