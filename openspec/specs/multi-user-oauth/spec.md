# multi-user-oauth Specification

## Purpose
TBD - created by archiving change rebuild-console-tanstack-start. Update Purpose after archive.
## Requirements
### Requirement: GitHub OAuth authorization-code flow

The orchestrator SHALL authenticate human operators via the GitHub OAuth 2.0 authorization-code flow. It SHALL expose an authorization-initiation endpoint that redirects the browser to GitHub's authorize URL with the configured `client_id`, the requested scopes, the registered `redirect_uri`, and a freshly generated anti-CSRF `state` value persisted server-side (or in a signed cookie) for the duration of the round trip. It SHALL expose a callback endpoint that exchanges the returned authorization `code` for a GitHub access token using the confidential `client_secret`, then fetches the authenticated GitHub user's stable identity (numeric `id` plus `login`). The OAuth `client_secret` SHALL NEVER be exposed to the browser; the code-for-token exchange MUST happen server-side only. If `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is unset, the orchestrator SHALL refuse to start the OAuth flow rather than fall back to an unauthenticated or single-shared-token login.

The GitHub identity prototype copy ("GitHub 授权登录", allowlist account `tanghehui`) is the product surface for this flow; the backend behavior defined here is its load-bearing implementation.

#### Scenario: Authorization is initiated with anti-CSRF state

- **WHEN** an unauthenticated operator hits the authorization-initiation endpoint
- **THEN** the orchestrator generates a random `state`, persists it for verification, and redirects the browser to GitHub's authorize URL carrying the configured `client_id`, scopes, `redirect_uri`, and that `state`

#### Scenario: Callback exchanges code for token server-side

- **WHEN** GitHub redirects back to the callback endpoint with a valid `code` and a `state` that matches the persisted value
- **THEN** the orchestrator exchanges the `code` for a GitHub access token using the `client_secret` on the server, fetches the GitHub user's numeric `id` and `login`, and never returns the `client_secret` or raw access token to the browser

#### Scenario: Mismatched or missing state is rejected

- **WHEN** the callback is invoked with a `state` that does not match the persisted value, or with no `state`
- **THEN** the orchestrator rejects the callback, establishes no session, and does not exchange the code

#### Scenario: Refuses to run the flow without OAuth credentials

- **WHEN** the orchestrator boots with `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` unset or empty
- **THEN** the OAuth login flow fails closed with a clear error rather than serving an unauthenticated or shared-token login

### Requirement: Allowlist gate is the load-bearing fail-closed security boundary

The GitHub allowlist gate SHALL be the security boundary that governs who may obtain host-root task execution. Because the backend runs tasks under a host-root `docker.sock` model, the set of identities permitted to authenticate is exactly the set of identities granted root-equivalent execution on the host; "who can log in" == "who can run as root on the host". Therefore, after a successful GitHub code-for-token exchange, the orchestrator SHALL gate session establishment on a hard allowlist of permitted GitHub identities (configured by stable numeric GitHub `id`, with `login` for display). An authenticated GitHub identity that is NOT on the allowlist SHALL be rejected fail-closed: no session is established, no user record grants access, and the operator is returned to the login gate. The allowlist gate SHALL fail closed in all ambiguous conditions — if the allowlist is unset, empty, unparseable, or cannot be evaluated, the orchestrator SHALL deny authentication rather than admit by default. The allowlist match SHALL key on the immutable GitHub numeric `id` (not solely the mutable `login`) so a renamed or reassigned GitHub username cannot impersonate an allowlisted operator.

This gate is not UI decoration; it is the load-bearing control over root-on-host execution and MUST NOT be bypassable by any client-supplied value.

#### Scenario: Allowlisted identity is admitted

- **WHEN** a GitHub identity completes the OAuth exchange and its numeric `id` is present on the configured allowlist
- **THEN** the orchestrator establishes a session for that identity and permits subsequent task execution

#### Scenario: Non-allowlisted identity is rejected fail-closed

- **WHEN** a GitHub identity completes the OAuth exchange successfully but its numeric `id` is NOT on the allowlist
- **THEN** the orchestrator establishes no session, grants no execution access, and returns the operator to the login gate
- **AND** because login grants host-root execution, the rejection is treated as a security denial, not a recoverable form error

#### Scenario: Empty or missing allowlist denies everyone

- **WHEN** the allowlist configuration is unset, empty, or unparseable at evaluation time
- **THEN** the orchestrator denies authentication for every identity rather than admitting by default

#### Scenario: Match keys on immutable numeric id, not mutable login

- **WHEN** a GitHub account whose current `login` equals an allowlisted display name presents a numeric `id` that is not on the allowlist
- **THEN** the orchestrator rejects authentication, because the gate matches on the immutable numeric `id` rather than the renameable `login`

### Requirement: User record keyed by GitHub identity

The orchestrator SHALL persist a user record keyed by the stable GitHub numeric `id`, recording at minimum the GitHub `login`, display name, and avatar reference for console rendering. On a successful allowlisted login the orchestrator SHALL upsert this record (create on first login, refresh mutable profile fields such as `login`/avatar on subsequent logins) so that audit, task ownership, and account-settings capabilities can attribute actions to a durable user identity. Persisting or refreshing a user record SHALL never of itself bypass the allowlist gate — the record exists only for identities that have already passed the allowlist.

#### Scenario: First login creates the user record

- **WHEN** an allowlisted GitHub identity logs in for the first time
- **THEN** the orchestrator creates a user record keyed by the GitHub numeric `id` capturing `login`, display name, and avatar

#### Scenario: Subsequent login refreshes mutable profile fields

- **WHEN** an existing allowlisted user logs in again after their GitHub `login` or avatar changed
- **THEN** the orchestrator updates the stored profile fields against the same numeric-`id` keyed record without creating a duplicate

#### Scenario: Record creation never substitutes for the allowlist

- **WHEN** a non-allowlisted identity authenticates with GitHub
- **THEN** no user record is created or used to grant access, because record persistence happens only after the allowlist gate admits the identity

### Requirement: Session establishment and logout

On successful allowlisted login the orchestrator SHALL establish an authenticated session bound to the user record, represented by an opaque, unguessable session token (or signed session cookie) that the console presents on subsequent requests. The session SHALL carry an expiry and SHALL be revocable. The orchestrator SHALL expose a logout action that invalidates the active session server-side (so a stolen-but-logged-out token cannot be replayed) and clears the session on the client; after logout the operator SHALL be returned to the login gate and SHALL require a fresh OAuth login to regain access.

#### Scenario: Session issued on allowlisted login

- **WHEN** an allowlisted identity completes login
- **THEN** the orchestrator issues an opaque session token bound to the user record with an expiry, and the console treats the operator as authenticated

#### Scenario: Logout invalidates the session server-side

- **WHEN** an authenticated operator invokes logout
- **THEN** the orchestrator invalidates the session server-side, the client session is cleared, and the operator is returned to the login gate
- **AND** presenting the invalidated session token afterward is treated as unauthenticated

#### Scenario: Expired session is not accepted

- **WHEN** a request presents a session token past its expiry
- **THEN** the orchestrator treats the request as unauthenticated and does not perform the requested action

### Requirement: Session validation on REST requests

Every REST endpoint other than the unauthenticated health check and the OAuth initiation/callback endpoints SHALL require a valid, non-expired session resolving to an allowlisted user. The orchestrator SHALL reject a missing, malformed, expired, revoked, or non-allowlisted session with HTTP 401 and SHALL NOT execute the requested action. Session validation SHALL re-confirm that the resolved user is still allowlisted at request time, so removing an identity from the allowlist denies its in-flight sessions on their next request (allowlist removal fails closed without waiting for natural expiry).

#### Scenario: Valid session is accepted

- **WHEN** a REST request carries a session token that resolves to a non-expired session for an allowlisted user
- **THEN** the orchestrator processes the request normally and attributes it to that user

#### Scenario: Missing or invalid session is rejected

- **WHEN** a request to a protected REST endpoint omits the session credential or presents one that is malformed, expired, or revoked
- **THEN** the orchestrator responds 401 and performs no state change

#### Scenario: De-allowlisted user is denied on next request

- **WHEN** a user's GitHub `id` is removed from the allowlist while they hold an unexpired session, and they make a subsequent REST request
- **THEN** the orchestrator responds 401 because session validation re-confirms allowlist membership at request time

### Requirement: Session validation on WebSocket connections

A client WebSocket connection SHALL be authenticated at connect time with the session credential, carried via the connect query parameter and/or the `bearer.<token>` WebSocket subprotocol — because browser WebSocket clients cannot set an `Authorization` header. The orchestrator SHALL resolve that credential to a valid, non-expired session for an allowlisted user before joining the connection to any task stream, and SHALL close an unauthenticated, expired, revoked, or non-allowlisted WebSocket connection before it receives any terminal bytes or control frames.

#### Scenario: Authenticated WebSocket joins the stream

- **WHEN** a client opens a WebSocket presenting a valid session credential via the query parameter or `bearer.<token>` subprotocol that resolves to an allowlisted, non-expired session
- **THEN** the connection is accepted and may subscribe to a task's terminal stream

#### Scenario: Unauthenticated WebSocket is closed before subscribing

- **WHEN** a client opens a WebSocket with a missing, malformed, expired, revoked, or non-allowlisted session credential
- **THEN** the orchestrator closes the connection before it joins any task stream, and the client receives no terminal bytes or control frames

#### Scenario: Credential travels via query/subprotocol, not Authorization header

- **WHEN** a browser establishes the WebSocket and cannot set an `Authorization` header
- **THEN** the orchestrator accepts the session credential from the connect query parameter or the `bearer.<token>` subprotocol and authenticates the connection identically to a REST request

