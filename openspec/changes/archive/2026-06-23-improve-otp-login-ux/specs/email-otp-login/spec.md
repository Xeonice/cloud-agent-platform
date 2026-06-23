## ADDED Requirements

### Requirement: OTP login panel gives non-disclosing send feedback and enforces a resend countdown

The OTP login panel SHALL, after a successful code send, display a NON-DISCLOSING notice that a code
was sent if the email is a provisioned account — advising the user to check inbox/spam and to contact
the administrator if nothing arrives — WITHOUT revealing whether the email corresponds to a real
account. The panel SHALL enforce a client-side resend countdown that mirrors the backend resend
cooldown: after a send, the send control SHALL be disabled and show the remaining seconds, restoring
to a resend affordance only when the countdown reaches zero. A FAILED send SHALL NOT start the
countdown nor show the sent notice, so the user may retry immediately.

#### Scenario: Post-send notice is non-disclosing

- **WHEN** the user sends a code
- **THEN** a neutral notice appears advising an inbox/spam check and contacting the admin, never stating whether the email is a real account

#### Scenario: Resend is disabled during the countdown

- **WHEN** a code has just been sent successfully
- **THEN** the send control is disabled and shows the remaining seconds, and re-enables only after the countdown reaches zero

#### Scenario: A failed send allows immediate retry

- **WHEN** the send request fails
- **THEN** no countdown starts and no sent-notice shows, so the user can retry immediately
