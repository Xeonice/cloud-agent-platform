## MODIFIED Requirements

### Requirement: GitHub OAuth authorization-code flow

The orchestrator SHALL authenticate human operators via the GitHub OAuth 2.0 authorization-code flow. It SHALL expose an authorization-initiation endpoint that redirects the browser to GitHub's authorize URL with the configured `client_id`, the requested scopes (including `user:email` so the operator's email can be read), the registered `redirect_uri`, and a freshly generated anti-CSRF `state` value persisted server-side (or in a signed cookie) for the duration of the round trip. It SHALL expose a callback endpoint that exchanges the returned authorization `code` for a GitHub access token using the confidential `client_secret`, then fetches the authenticated GitHub user's stable identity (numeric `id` plus `login`) and the user's primary verified email when available. The OAuth `client_secret` SHALL NEVER be exposed to the browser; the code-for-token exchange MUST happen server-side only. If `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is unset, the orchestrator SHALL refuse to start the OAuth flow rather than fall back to an unauthenticated or single-shared-token login.

GitHub is one of several login methods (alongside email+password and email verification code); the backend behavior defined here is its load-bearing implementation.

#### Scenario: Authorization is initiated with anti-CSRF state

- **WHEN** an unauthenticated operator hits the authorization-initiation endpoint
- **THEN** the orchestrator generates a random `state`, persists it for verification, and redirects the browser to GitHub's authorize URL carrying the configured `client_id`, scopes (including `user:email`), `redirect_uri`, and that `state`

#### Scenario: Callback exchanges code for token server-side

- **WHEN** GitHub redirects back to the callback endpoint with a valid `code` and a `state` that matches the persisted value
- **THEN** the orchestrator exchanges the `code` for a GitHub access token using the `client_secret` on the server, fetches the GitHub user's numeric `id`, `login`, and primary verified email, and never returns the `client_secret` or raw access token to the browser

#### Scenario: Mismatched or missing state is rejected

- **WHEN** the callback is invoked with a `state` that does not match the persisted value, or with no `state`
- **THEN** the orchestrator rejects the callback, establishes no session, and does not exchange the code

#### Scenario: Refuses to run the flow without OAuth credentials

- **WHEN** the orchestrator boots with `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` unset or empty
- **THEN** the OAuth login flow fails closed with a clear error rather than serving an unauthenticated or shared-token login

### Requirement: Allowlist gate is the load-bearing fail-closed security boundary

Because the backend runs tasks under a host-root `docker.sock` model, "who can act" == "who can run as root on the host", so the authorization boundary is load-bearing and MUST fail closed. The runtime boundary SHALL be the resolved user's `allowed` flag, re-confirmed on every request (see `local-account-identity`). For GitHub logins specifically, `AUTH_ALLOWLIST` (numeric GitHub ids) SHALL act as the login-time provisioning input that decides whether a GitHub identity is granted `allowed`: a GitHub identity whose numeric id is NOT on the allowlist SHALL NOT be granted access, and the allowlist SHALL fail closed when unset, empty, or unparseable (deny rather than admit by default). The allowlist match SHALL key on the immutable GitHub numeric `id`, never solely the mutable `login`. The runtime request gate SHALL NOT itself read `AUTH_ALLOWLIST`; once provisioned, a GitHub user is revoked by setting `allowed = false`.

This gate is not UI decoration; it is the load-bearing control over root-on-host execution and MUST NOT be bypassable by any client-supplied value.

#### Scenario: Allowlisted GitHub identity is provisioned and admitted

- **WHEN** a GitHub identity completes the OAuth exchange and its numeric `id` is present on the configured allowlist
- **THEN** the orchestrator provisions/keeps the user as `allowed = true`, establishes a session, and permits subsequent task execution

#### Scenario: Non-allowlisted GitHub identity is rejected fail-closed

- **WHEN** a GitHub identity completes the OAuth exchange successfully but its numeric `id` is NOT on the allowlist
- **THEN** the orchestrator grants no access, establishes no session, and returns the operator to the login gate
- **AND** because login grants host-root execution, the rejection is treated as a security denial, not a recoverable form error

#### Scenario: Empty or missing allowlist denies every GitHub login

- **WHEN** the allowlist configuration is unset, empty, or unparseable at GitHub-login time
- **THEN** the orchestrator denies provisioning for every GitHub identity rather than admitting by default

#### Scenario: Match keys on immutable numeric id, not mutable login

- **WHEN** a GitHub account whose current `login` equals an allowlisted display name presents a numeric `id` that is not on the allowlist
- **THEN** the orchestrator rejects provisioning, because the gate matches on the immutable numeric `id` rather than the renameable `login`

### Requirement: User record keyed by GitHub identity

The orchestrator SHALL persist a provider-agnostic `User` account and represent the GitHub login as a `github` `IdentityLink` keyed on the stable GitHub numeric `id` (see `local-account-identity`), recording the GitHub `login`, display name, avatar reference, and (when available) primary verified email for console rendering and account resolution. On a successful allowlisted GitHub login the orchestrator SHALL upsert the `User` + its `github` identity (create on first login, refresh mutable profile fields such as `login`/avatar on subsequent logins) so that audit, task ownership, and account-settings capabilities can attribute actions to a durable user identity. Provisioning or refreshing a record SHALL never of itself bypass the `allowed` gate.

#### Scenario: First GitHub login creates the account and identity

- **WHEN** an allowlisted GitHub identity logs in for the first time
- **THEN** the orchestrator creates a `User` and a `github` `IdentityLink` keyed by the GitHub numeric `id`, capturing `login`, display name, avatar, and verified email when present

#### Scenario: Subsequent login refreshes mutable profile fields

- **WHEN** an existing GitHub user logs in again after their `login` or avatar changed
- **THEN** the orchestrator updates the stored profile fields against the same identity without creating a duplicate account

#### Scenario: Record creation never substitutes for the gate

- **WHEN** a non-allowlisted GitHub identity authenticates with GitHub
- **THEN** no account is granted access, because provisioning happens only after the allowlist admits the identity and the runtime gate still requires `allowed = true`

### Requirement: Session validation on REST requests

Every REST endpoint other than the unauthenticated health/metadata endpoints and the public auth endpoints (OAuth initiation/callback, password login, OTP request/verify, change-password, and the one-time admin reveal) SHALL require a valid, non-expired session resolving to an `allowed` user. The orchestrator SHALL reject a missing, malformed, expired, revoked, or disallowed session with HTTP 401 and SHALL NOT execute the requested action. Session validation SHALL re-confirm `User.allowed` at request time, so disabling an account denies its in-flight sessions on their next request (revocation fails closed without waiting for natural expiry). Additionally, when the resolved user has `mustChangePassword` set, every protected action other than the change-password endpoint (and logout) SHALL be denied with a signal that a password change is required.

#### Scenario: Valid session for an allowed user is accepted

- **WHEN** a REST request carries a session token that resolves to a non-expired session for an `allowed` user without a pending password change
- **THEN** the orchestrator processes the request normally and attributes it to that user

#### Scenario: Missing or invalid session is rejected

- **WHEN** a request to a protected REST endpoint omits the session credential or presents one that is malformed, expired, or revoked
- **THEN** the orchestrator responds 401 and performs no state change

#### Scenario: Disabled user is denied on next request

- **WHEN** a user's `allowed` is set false while they hold an unexpired session, and they make a subsequent REST request
- **THEN** the orchestrator responds 401 because session validation re-confirms `allowed` at request time

#### Scenario: Pending password change blocks protected actions

- **WHEN** an allowed user with `mustChangePassword = true` requests a protected action other than changing the password
- **THEN** the orchestrator denies it and signals that a password change is required

### Requirement: Session validation on WebSocket connections

A client WebSocket connection SHALL be authenticated at connect time with the session credential, carried via the connect query parameter and/or the `bearer.<token>` WebSocket subprotocol — because browser WebSocket clients cannot set an `Authorization` header. The orchestrator SHALL resolve that credential to a valid, non-expired session for an `allowed` user before joining the connection to any task stream, and SHALL close an unauthenticated, expired, revoked, or disallowed WebSocket connection before it receives any terminal bytes or control frames.

#### Scenario: Authenticated WebSocket joins the stream

- **WHEN** a client opens a WebSocket presenting a valid session credential via the query parameter or `bearer.<token>` subprotocol that resolves to an `allowed`, non-expired session
- **THEN** the connection is accepted and may subscribe to a task's terminal stream

#### Scenario: Unauthenticated WebSocket is closed before subscribing

- **WHEN** a client opens a WebSocket with a missing, malformed, expired, revoked, or disallowed session credential
- **THEN** the orchestrator closes the connection before it joins any task stream, and the client receives no terminal bytes or control frames

#### Scenario: Credential travels via query/subprotocol, not Authorization header

- **WHEN** a browser establishes the WebSocket and cannot set an `Authorization` header
- **THEN** the orchestrator accepts the session credential from the connect query parameter or the `bearer.<token>` subprotocol and authenticates the connection identically to a REST request
