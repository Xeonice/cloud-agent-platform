# email-otp-login Specification

## Purpose
TBD - created by archiving change add-private-account-identity. Update Purpose after archive.
## Requirements
### Requirement: Email verification-code (OTP) authentication

The orchestrator SHALL support passwordless login by emailed verification code for
accounts that have a stored, verified email and are `allowed`. It SHALL expose a
public request endpoint that, given an email resolving to such an account, generates
a single-use numeric code, stores only its hash with a short expiry, and emails the
code; and a public verify endpoint that establishes a session when the presented
code matches the stored hash, is unexpired, and is unconsumed. Codes SHALL be stored
hashed at rest (never plaintext), SHALL expire within a short window (default 10
minutes), and SHALL be marked consumed on successful use so they cannot be replayed.
The request endpoint SHALL NOT disclose whether the email maps to an account
(uniform response), and SHALL NOT create accounts (no public registration).

#### Scenario: Requesting a code for an allowed account emails a hashed code

- **WHEN** an email resolving to an allowed account with a verified email requests a
  code
- **THEN** the orchestrator generates a code, stores only its hash with an expiry,
  and sends the code by email

#### Scenario: Valid code establishes a session and cannot be replayed

- **WHEN** the account submits a matching, unexpired, unconsumed code
- **THEN** a session is minted and the code is marked consumed so re-submitting it
  fails

#### Scenario: Request for an unknown email reveals nothing

- **WHEN** a code is requested for an email with no matching allowed account
- **THEN** the response is indistinguishable from the success path and no code is
  sent and no account is created

#### Scenario: Expired or wrong code is rejected

- **WHEN** a submitted code is expired, already consumed, or does not match the
  stored hash
- **THEN** verification fails and no session is established

### Requirement: SMTP delivery and capability gating

Verification-code email SHALL be sent over SMTP through a mail module that selects a transport
PER RECIPIENT address via a transport-selection seam. The mail module SHALL register one or more
named transports, each configured by an SMTP tuple (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`); a DEFAULT transport SHALL be configured by the unprefixed `SMTP_*`
variables. For a given recipient the module SHALL route to the transport whose rule matches the
recipient address, and SHALL fall back to the DEFAULT transport when no rule matches — today only
the default transport is registered, so every recipient routes to it. The OTP login method SHALL
be reported AVAILABLE through the backend capability flags when at least one usable transport is
configured, and UNAVAILABLE — the console hides the method AND the OTP request endpoint fails
closed — when none is. Send failures SHALL be surfaced (logged/visible to the operator) rather
than silently swallowed.

#### Scenario: OTP is unavailable when no transport is configured

- **WHEN** no SMTP transport is configured (the default `SMTP_*` tuple is unset and no other transport is registered)
- **THEN** the capability flag for OTP is false, the console does not render the verification-code method, and the OTP request endpoint fails closed

#### Scenario: Configured default transport delivers the code

- **WHEN** the default `SMTP_*` transport is configured and a valid OTP request arrives
- **THEN** the code is sent via the transport selected for the recipient (the default transport) and the capability flag for OTP is true

#### Scenario: Recipient routing falls back to the default transport

- **WHEN** a verification code is sent and no recipient-specific transport rule matches the address
- **THEN** the mail module delivers it via the default transport

