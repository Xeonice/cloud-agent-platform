## ADDED Requirements

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
