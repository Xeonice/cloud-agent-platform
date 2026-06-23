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
named transports; the DEFAULT transport SHALL be resolved from the STORED DB SMTP configuration
when present, and SHALL FALL BACK to the unprefixed `SMTP_*` environment variables when no DB
configuration exists (the DB configuration takes precedence). For a given recipient the module
SHALL route to the transport whose rule matches the recipient address, and SHALL fall back to the
DEFAULT transport when no rule matches — today only the default transport is registered, so every
recipient routes to it. The OTP login method SHALL be reported AVAILABLE through the backend
capability flags when at least one usable transport is configured — i.e. when EITHER the DB
configuration OR the `SMTP_*` env is present — and UNAVAILABLE (the console hides the method AND
the OTP request endpoint fails closed) when neither is. Send failures SHALL be surfaced
(logged/visible to the operator) rather than silently swallowed.

#### Scenario: OTP is unavailable when neither DB nor env SMTP is configured

- **WHEN** no DB SMTP configuration exists and the `SMTP_*` env is unset
- **THEN** the capability flag for OTP is false, the console does not render the verification-code method, and the OTP request endpoint fails closed

#### Scenario: A stored DB configuration provides the default transport

- **WHEN** a DB SMTP configuration exists and a valid OTP request arrives
- **THEN** the code is sent via the DB-configured transport (its password decrypted at send time) and the capability flag for OTP is true

#### Scenario: Env configures the default transport as the fallback

- **WHEN** no DB configuration exists but the `SMTP_*` env is configured and a valid OTP request arrives
- **THEN** the code is sent via the env-configured transport and the capability flag for OTP is true

#### Scenario: Recipient routing falls back to the default transport

- **WHEN** a verification code is sent and no recipient-specific transport rule matches the address
- **THEN** the mail module delivers it via the default transport

### Requirement: Verification-code email is a branded HTML template

The verification-code email SHALL be sent as a branded HTML template with a plaintext fallback in
the same message (`multipart/alternative`), rather than a bare plaintext line. The HTML SHALL be
email-safe (table layout + inline CSS so clients that strip `<style>` or lack modern CSS still
render it) and SHALL follow the console's Vercel/Geist design: achromatic palette (no decorative
accent color), the AC brand mark, and the verification code shown prominently in a monospace
treatment. Both the HTML and the plaintext part SHALL contain the verification code and its
validity window, and the subject SHALL be localized. The code interpolated into the template SHALL
be only the generated numeric code (no free-text input enters the template). This changes only the
email's PRESENTATION — generation, TTL, attempt cap, resend cooldown, hash-at-rest storage, and the
uniform non-disclosing response are unchanged.

#### Scenario: The OTP email carries both an HTML part and a plaintext fallback

- **WHEN** a verification code is emailed to an allowed account
- **THEN** the message includes an HTML body AND a plaintext body, and both contain the verification code and its validity window

#### Scenario: The plaintext fallback keeps the code readable without HTML

- **WHEN** the email is opened in a client that does not render HTML
- **THEN** the plaintext part still presents the verification code and its expiry

#### Scenario: Presentation change does not alter OTP security behavior

- **WHEN** the templated email is sent
- **THEN** the code is still a single-use CSPRNG numeric value stored only as a hash with the same TTL, attempt cap, and resend cooldown, and the request response stays uniform and non-disclosing

