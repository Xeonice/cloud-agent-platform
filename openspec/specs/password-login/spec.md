# password-login Specification

## Purpose
TBD - created by archiving change add-private-account-identity. Update Purpose after archive.
## Requirements
### Requirement: Email and password authentication

The orchestrator SHALL expose a public, pre-authentication endpoint that accepts an
email and password and establishes a session when the email resolves to an existing
account that has a `password` identity, the password verifies against the stored
argon2 hash, and the account is `allowed`. Passwords SHALL be stored only as argon2
hashes (never plaintext, never reversibly encrypted) and verified in constant time.
The endpoint SHALL fail closed — unknown email, no password identity, wrong
password, or `allowed = false` SHALL all return the same generic failure without
disclosing which condition failed, and SHALL NOT establish a session. A successful
password login SHALL mint the same opaque session credential as any other login
method.

#### Scenario: Correct credentials for an allowed account establish a session

- **WHEN** an allowed account with a password identity submits its correct email and
  password
- **THEN** the orchestrator verifies the argon2 hash and mints a session

#### Scenario: Wrong password is rejected without disclosure

- **WHEN** a known email is submitted with an incorrect password
- **THEN** the orchestrator returns a generic authentication failure, establishes no
  session, and does not reveal whether the email exists

#### Scenario: Password login never auto-creates an account

- **WHEN** an email with no existing account submits a password
- **THEN** the orchestrator returns the same generic failure and creates no account
  (there is no public registration)

### Requirement: Forced first-login password change

An account flagged `mustChangePassword` SHALL be required to set a new password
before gaining console access. After such an account authenticates, the orchestrator
SHALL deny every action except the change-password endpoint (and logout) until a new
password is set. Setting a new password SHALL store its argon2 hash, clear
`mustChangePassword`, and invalidate any prior temporary credential.

#### Scenario: Must-change account is blocked until it sets a password

- **WHEN** an account with `mustChangePassword = true` authenticates and requests any
  protected action other than changing its password
- **THEN** the orchestrator denies the action and signals that a password change is
  required

#### Scenario: Setting a new password clears the flag

- **WHEN** the account submits a valid new password through the change-password
  endpoint
- **THEN** the new argon2 hash is stored, `mustChangePassword` is cleared, the old
  temporary password no longer authenticates, and console access is granted

### Requirement: Changing a password rotates the session

A successful change-password SHALL rotate the account's session: it SHALL invalidate the
account's sessions that existed BEFORE the change (including the session that issued the change
request) and SHALL mint a FRESH session credential for the current request, returned to the
current client in the same response so that client continues WITHOUT re-authenticating while
previously-established sessions are signed out. This applies to BOTH the forced first-login change
and any self-service password change. Rotation SHALL NOT leave the current request
unauthenticated — the new credential SHALL be issued in the same change-password response. The
session credential remains the same opaque, stateful kind minted by any other login (it does not
encode the password).

#### Scenario: Pre-change session tokens stop working after a password change

- **WHEN** an account changes its password and a subsequent request is made with a session token that existed before the change
- **THEN** that pre-change token no longer authenticates and the request is rejected as unauthenticated

#### Scenario: The current client continues seamlessly after changing its password

- **WHEN** the account completes a change-password from its current session
- **THEN** the response issues a fresh session credential for that client and the client remains authenticated using it, with no re-login required

#### Scenario: Forced first-login change clears the flag and rotates together

- **WHEN** a `mustChangePassword` account completes the forced password change
- **THEN** `mustChangePassword` is cleared, the prior temporary credential no longer authenticates, AND the session is rotated (pre-change sessions invalidated, a fresh credential issued for the current client)

