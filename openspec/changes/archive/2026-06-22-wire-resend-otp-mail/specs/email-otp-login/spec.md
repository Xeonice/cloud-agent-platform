## MODIFIED Requirements

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
