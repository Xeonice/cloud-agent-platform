# request-rate-limiting Specification

## Purpose
TBD - created by archiving change public-v1-api. Update Purpose after archive.
## Requirements
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

### Requirement: Anonymous brute-force throttle on pre-auth auth endpoints

The orchestrator SHALL apply a dedicated throttle tier to the public authentication endpoints (password login, OTP request, OTP verify, change-password attempts) keyed on a combination of client IP and the submitted email rather than on a principal, because the existing per-principal throttle has no principal for pre-authentication requests. This tier SHALL cap repeated attempts per IP and per email within a window (env-tunable) so a single attacker cannot brute-force a password or exhaust OTP issuance, and SHALL apply IN ADDITION to any per-email OTP issuance cooldown. Exceeding the cap SHALL return a throttling response without performing the authentication attempt.

#### Scenario: Repeated password attempts from one source are throttled

- **WHEN** password-login attempts from the same IP/email exceed the configured cap
  within the window
- **THEN** further attempts are rejected with a throttling response and no credential
  check is performed until the window resets

#### Scenario: OTP issuance is rate-capped per email and IP

- **WHEN** OTP requests for the same email (or from the same IP) exceed the configured
  cap within the window
- **THEN** further OTP requests are throttled, in addition to the per-email resend
  cooldown, so codes cannot be mass-issued

#### Scenario: Anonymous throttle does not depend on a resolved principal

- **WHEN** a pre-authentication request hits an auth endpoint with no principal
- **THEN** the throttle decision is made from IP + submitted email rather than falling
  into a single shared principal-less bucket

