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

### Requirement: Post-login redirect target with open-redirect-safe deep-link return
After a successful OAuth exchange + allowlist admission, the orchestrator SHALL
redirect the browser to the CONSOLE by default — the dashboard (`/dashboard`) —
rather than to the repository-import page. The authorization-initiation endpoint
MAY accept an optional `redirect` parameter naming the app destination the
operator was originally trying to reach (so the auth gate can return them there
after login); when present it SHALL be carried through the OAuth round trip
ALONGSIDE the anti-CSRF `state` (in the signed state payload or a paired signed
cookie), never weakening or replacing the `state` verification. At the callback,
the orchestrator SHALL resolve the post-login location as follows: if a carried
`redirect` is present AND passes the open-redirect guard, redirect to
`${webOrigin}${redirect}`; otherwise redirect to `${webOrigin}/dashboard`.

The open-redirect guard is load-bearing because login grants host-root execution,
so a reflected redirect is a phishing vector: the orchestrator SHALL accept a
`redirect` ONLY when it is a SAME-ORIGIN RELATIVE path — it MUST begin with a
single `/`, MUST NOT begin with `//` or `/\`, MUST NOT contain a scheme or
authority (no `http:`/`https:`/`\\`), and any other value SHALL be rejected and
treated as absent (falling back to `/dashboard`). The redirect SHALL never cause
the browser to leave the configured web origin.

#### Scenario: Default post-login lands on the console
- **WHEN** an allowlisted identity completes the OAuth exchange with no `redirect` carried
- **THEN** the orchestrator redirects the browser to `${webOrigin}/dashboard`

#### Scenario: A safe same-origin redirect is honored
- **WHEN** the flow was initiated with a `redirect` of a same-origin relative app path (e.g. `/tasks/abc`) that passes the guard, and the OAuth exchange + allowlist admit succeed
- **THEN** the orchestrator redirects the browser to `${webOrigin}/tasks/abc` rather than the default dashboard

#### Scenario: An unsafe redirect is rejected and falls back to the dashboard
- **WHEN** the carried `redirect` is an absolute URL, protocol-relative (`//evil.example`), scheme-bearing, or otherwise not a same-origin relative path
- **THEN** the orchestrator ignores it and redirects to `${webOrigin}/dashboard`, never sending the browser off the configured web origin

#### Scenario: The redirect never weakens anti-CSRF state
- **WHEN** the callback verifies the round trip
- **THEN** the anti-CSRF `state` is verified exactly as before and a mismatched/missing `state` is still rejected, independent of whether a `redirect` was carried

### Requirement: Session cookie has a single canonical scope (no shadow cookies)
When the deployment is cross-subdomain (a parent `SESSION_COOKIE_DOMAIN` is configured so the session cookie is domain-scoped and the web SSR can read it on the browser's top-level request), the orchestrator SHALL ensure the browser never holds MORE THAN ONE `cap_session` cookie for the api host. Because two same-name cookies (a domain-scoped one plus a stale host-only one left by an earlier cookie-domain config) are sent together to the api and the server reads only the FIRST, a stale shadow makes EVERY browser→api request fail authentication (401) even with a valid session — while the web SSR, which only ever sees the single domain-scoped cookie on the web host, still authenticates, so the console renders its shell but all client-side data and the session-aware UI break.

To prevent this, on BOTH login (when setting the domain-scoped session cookie) and logout (when clearing it) the orchestrator SHALL also emit a `Set-Cookie` that EXPIRES the HOST-ONLY variant of the session cookie (same name + path, no `Domain`), so a stale host-only shadow is purged. Logout SHALL clear every scope the cookie could have been set under (both the host-only and the configured parent-domain variant), so sign-out is complete and leaves no cookie behind. A host-only clear and a domain-scoped set target different cookies and do not conflict.

#### Scenario: Login purges a stale host-only shadow cookie
- **WHEN** an allowlisted identity completes the OAuth exchange on a cross-subdomain deploy (parent `SESSION_COOKIE_DOMAIN` configured)
- **THEN** the callback sets the domain-scoped session cookie (`SameSite=None; Secure; Domain=<parent>`) AND also emits a host-only `cap_session` clear (`Max-Age=0`, no `Domain`), so any stale host-only shadow from an earlier config is removed and cannot 401 subsequent browser→api requests

#### Scenario: Logout clears every cookie scope
- **WHEN** the operator logs out on a cross-subdomain deploy
- **THEN** the orchestrator emits clears for BOTH the host-only and the parent-domain variant of the session cookie, so neither lingers to shadow a later login and sign-out leaves no session cookie behind

### Requirement: Bearer credentials are routed by token prefix before session resolution

Operator-principal resolution SHALL dispatch a presented `Authorization: Bearer` (or, on the WebSocket channel, the single presented) credential by its token PREFIX as the FIRST step, before any session lookup. A `cap_sk_`-prefixed credential SHALL be tried ONLY against API-key resolution; an `mcp_`-prefixed credential SHALL be tried ONLY against the reserved MCP resolver; any other credential SHALL fall through to the existing session-then-legacy paths unchanged. Each domain SHALL be reachable by exactly one prefix, so a credential of one domain is NEVER tried against another domain's resolver. The prefix is a non-secret routing decision and SHALL NOT weaken the constant-time comparisons each domain performs. This ordering SHALL hold identically on the REST `Authorization` header and on the WebSocket channel (where the same presented token is supplied to both the session and legacy candidates today).

#### Scenario: Prefixed credential never reaches the session lookup

- **WHEN** a `cap_sk_…` or `mcp_…` credential is presented on either the REST `Authorization` header or the WebSocket channel
- **THEN** it is routed to its own resolver and is NEVER tried as a session token (no `Session` table lookup) nor compared against the legacy operator token

#### Scenario: Unprefixed credentials keep existing behavior

- **WHEN** a credential without a reserved prefix is presented
- **THEN** resolution proceeds with the existing session-first, then gated legacy-token, behavior unchanged

### Requirement: Operator principal supports machine kinds and authorization scopes

The operator principal SHALL support an `api-key` kind in addition to `session` and `legacy-token`, and SHALL reserve an `mcp` kind. The principal SHALL be able to carry an optional set of authorization scopes and an optional key identifier. A principal that carries no scopes SHALL be treated as allow-all by scope-gated operations, preserving the behavior of session and legacy principals.

#### Scenario: API-key principal carries owner and scopes

- **WHEN** an API key resolves successfully
- **THEN** the resulting principal has kind `api-key`, a user equal to the key owner, and the key's granted scopes

### Requirement: Reserved MCP credential slot denies until bound

The `mcp_` prefix SHALL be reserved for the MCP machine-identity track. Until that track binds an MCP resolver, an `mcp_`-prefixed credential SHALL resolve to no principal (fail closed). Reserving the slot SHALL NOT create any dependency on the MCP track being present.

#### Scenario: MCP credential denied while resolver is unbound

- **WHEN** an `mcp_…` credential is presented and no MCP resolver is bound
- **THEN** resolution returns no principal and the request is rejected, with no state change

### Requirement: The legacy operator token must not collide with a reserved prefix

Because the legacy `AUTH_TOKEN` is an operator-chosen free-form value, the orchestrator SHALL refuse to boot when `AUTH_TOKEN` is configured AND begins with any reserved credential prefix (`cap_sk_`, `mcp_`), with a clear error. This prevents a legacy token from being silently mis-routed to a machine resolver and never reaching its constant-time comparison.

#### Scenario: Boot refused on a colliding AUTH_TOKEN

- **WHEN** the orchestrator starts with an `AUTH_TOKEN` that begins with a reserved prefix
- **THEN** it refuses to boot and emits a clear error naming the reserved prefixes

#### Scenario: Non-colliding AUTH_TOKEN boots normally

- **WHEN** the orchestrator starts with an `AUTH_TOKEN` that does not begin with any reserved prefix (or with the legacy path disabled)
- **THEN** it boots normally

### Requirement: Task actions attribute to the resolved principal's owner

When a task-changing operation runs behind the operator guard, the controller SHALL read the resolved principal and pass its owner's GitHub identity to the task service so the audit record attributes the action to that user. An `api-key` or `session` principal SHALL attribute to its owner; a principal with no user (legacy token, or an unattributable system action) SHALL attribute to the system sentinel as before.

#### Scenario: API-key-created task attributes to the key owner

- **WHEN** a task is created by a request authenticated with an `api-key` principal
- **THEN** the task's audit record attributes creation to the key owner's user, not the system sentinel

#### Scenario: Session-created task attributes to the session user

- **WHEN** a task is created by a GitHub-session principal
- **THEN** the task's audit record attributes creation to that session user

### Requirement: Public OpenAPI metadata endpoints are unauthenticated

The global operator auth guard SHALL exempt `GET /v1/openapi.json` and `GET /v1/docs` from authentication — they expose only read-only API metadata (the generated OpenAPI document and its interactive viewer) and carry no secrets, exactly like the existing `/health` / `/version` public-metadata exemptions. Every OTHER `/v1` route SHALL remain guarded; the exemption SHALL be exact-match (never a `/v1` prefix match) so the data-plane `/v1` routes are never accidentally unauthenticated. The guarded `/v1` routes SHALL admit BOTH session and `api-key` principals through the existing `resolveOperatorPrincipal`, and the `/v1` controllers SHALL read the attached principal and `hasScope` to gate scoped operations.

#### Scenario: The OpenAPI doc is reachable without a credential

- **WHEN** an unauthenticated client requests `GET /v1/openapi.json` or `GET /v1/docs`
- **THEN** it is served (200) without an operator credential, like `/version`

#### Scenario: Data-plane /v1 routes stay guarded

- **WHEN** an unauthenticated client requests any `/v1` data route (e.g. `GET /v1/tasks`)
- **THEN** it is rejected with 401 — the exemption is exact-match on the two metadata paths only, never a `/v1` prefix

#### Scenario: /v1 admits both session and api-key principals

- **WHEN** a guarded `/v1` route is reached with a valid GitHub session OR a valid `cap_sk_` api-key
- **THEN** the request is admitted as the resolved principal and scoped operations are gated by `hasScope`

### Requirement: /mcp is session-guard-exempt but bearer-protected

The global operator auth guard SHALL exempt `/mcp` from the SESSION guard so the MCP server's own bearer validation runs instead — but `/mcp` SHALL remain PROTECTED by the SDK `requireBearerAuth` → `resolveMcpToken`, never unauthenticated. The exemption SHALL be EXACT-MATCH on `/mcp` (never a broad `/mcp`-prefix that could expose another route). A test SHALL assert `/mcp` is `401` without a valid `mcp_` bearer while a `/v1` data route also stays `401` without a credential. There is NO OAuth `.well-known` discovery surface to exempt (the settings-minted-token model needs none).

#### Scenario: /mcp is bearer-gated, not session-gated

- **WHEN** `/mcp` is requested without a GitHub session but WITH a valid `mcp_` bearer
- **THEN** it is admitted (the session guard is exempt; `requireBearerAuth` validates the bearer)

#### Scenario: /mcp without a bearer is rejected

- **WHEN** `/mcp` is requested with neither a session nor a valid `mcp_` bearer
- **THEN** it returns 401 — the exemption removes only the session guard, not authentication

### Requirement: The reserved mcp_ slot binds the real resolver and reuses the GitHub allowlist

This change SHALL bind the real `resolveMcpToken` into the reserved `mcp_` prefix slot of `resolveOperatorPrincipal` (replacing the deny-until-bound default), so a `mcp_` credential resolves to an `mcp` principal — still routed by prefix to EXACTLY that domain (never tried against the session / legacy / api-key domains). The MCP token reuses the SAME hard allowlist (`isAllowlistedRaw`) that governs who may obtain a console session or an API key, so one allowlist governs all three credential kinds.

#### Scenario: A bound mcp_ token resolves to an mcp principal

- **WHEN** a credential with the `mcp_` prefix is presented and resolves
- **THEN** `resolveOperatorPrincipal` routes it to `resolveMcpToken` and returns an `mcp` principal, never tried against the other domains

### Requirement: /mcp uses route-scoped, bearer-only CORS

`/mcp` SHALL use a route-scoped, bearer-only, NON-credentialed CORS policy distinct from the console's cookie-credentialed CORS. An MCP-client browser origin SHALL NOT be added to the cookie-credentialed origin allowlist (that would let it carry the `cap_session` cookie).

#### Scenario: MCP CORS never carries the session cookie

- **WHEN** CORS is configured for `/mcp`
- **THEN** it is bearer-only / non-credentialed and route-scoped, and no MCP-client origin is added to the console's credentialed CORS allowlist

