## MODIFIED Requirements

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
