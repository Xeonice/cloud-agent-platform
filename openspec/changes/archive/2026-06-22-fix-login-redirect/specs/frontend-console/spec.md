## ADDED Requirements

### Requirement: Post-login navigation performs a full document load

The console SHALL enter the authenticated console with a FULL DOCUMENT LOAD (e.g.
`window.location.assign`), NOT an in-app soft navigation, after a credential login succeeds
(email+password or email OTP) and after a forced first-login password change completes. A full
load guarantees the
react-query cache is discarded and the `_app` auth gate re-resolves the session from the existing
session cookie, so a pre-warmed STALE `authSession` value — the `null` cached by the public
landing page, or a `mustChangePassword: true` session cached before the change — cannot cause the
gate to bounce the just-authenticated operator back to `/login`. The destination SHALL remain the
open-redirect-guarded relative `redirect` deep-link when present, otherwise `/dashboard`. The
GitHub OAuth method, which already performs a full-page redirect, is unchanged; the local mock
gate path (sessionStorage) is unaffected.

#### Scenario: Password/OTP login from a landing-prewarmed session reaches the dashboard

- **WHEN** an operator opens the public landing (which pre-warms `authSession` to null), then logs in with email+password or email OTP in REAL/auth-on mode
- **THEN** the console performs a full document load into `/dashboard` (or the carried redirect) and the auth gate admits the operator instead of bouncing back to `/login`

#### Scenario: Forced-change completion reaches the console without looping

- **WHEN** a must-change operator, whose cached session still carries `mustChangePassword`, completes the forced password change
- **THEN** the console performs a full document load into the console and the gate admits the operator, rather than bouncing back into the forced-change dialog

#### Scenario: Post-login navigation does not depend on react-query cache freshness

- **WHEN** the post-login or forced-change-completion navigation runs
- **THEN** it uses a full document load rather than a soft `navigate` into the gate, so a stale in-memory `authSession` cache value cannot reject the freshly established session
