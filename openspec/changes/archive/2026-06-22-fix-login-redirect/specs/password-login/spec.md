## ADDED Requirements

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
