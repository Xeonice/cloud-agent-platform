## ADDED Requirements

### Requirement: Per-principal request rate limiting

The system SHALL rate-limit requests per RESOLVED PRINCIPAL via a throttler guard registered as a SECOND global guard ordered AFTER the auth guard (so the principal is already attached when the limiter keys on it). The tracker key SHALL be the api-key id for an `api-key` principal and the owner's GitHub id for a session principal — NOT the raw client IP (so two keys behind one IP get independent buckets). A principal exceeding its window SHALL be rejected with 429. For the single-node resident deployment an in-process store is sufficient.

#### Scenario: Two API keys from one IP get independent buckets

- **WHEN** two distinct api-keys issue requests from the same client IP
- **THEN** each is limited against its own per-key bucket, not a shared per-IP bucket

#### Scenario: Exceeding the window returns 429

- **WHEN** a principal exceeds its configured request rate within the window
- **THEN** further requests in that window are rejected with 429 until the window resets

#### Scenario: The limiter runs after auth so it can key on the principal

- **WHEN** the global guards run
- **THEN** the auth guard resolves and attaches the principal BEFORE the throttler guard reads it for the tracker key (verified by the guard registration order)

### Requirement: Per-principal task-creation rate cap

Task creation SHALL be capped per principal independently of the running-task concurrency semaphore. Because the semaphore bounds RUNNING tasks but not CREATED ones, an unbounded queued backlog is the real abuse surface; the create-rate cap SHALL bound how fast a single principal can enqueue tasks, rejecting over-rate creates with 429 without admitting a sandbox.

#### Scenario: A burst of creates from one principal is capped

- **WHEN** one principal issues task-create requests faster than its create-rate cap
- **THEN** the over-rate creates are rejected with 429 and no sandbox is admitted for them, while the running-task concurrency semaphore continues to bound only concurrent execution
