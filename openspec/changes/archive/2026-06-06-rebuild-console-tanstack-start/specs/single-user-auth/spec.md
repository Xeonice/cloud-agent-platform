# single-user-auth (delta)

This delta retires the single-operator identity model. GitHub OAuth multi-user
identity, the hard allowlist gate, and browser session cookies are defined in the
**multi-user-oauth** capability and are NOT duplicated here.

What remains in scope for this capability after the change:
- The REST and WebSocket auth *gates* themselves (still load-bearing — the backend
  runs tasks via a host-root `docker.sock` model, so "who is admitted" == "who runs
  as root on the host"). These gates are MODIFIED to admit GitHub-OAuth-derived
  sessions as the primary principal, while still accepting the operator bearer token
  as a narrow, explicitly-enabled legacy/service path.
- The runner `TASK_TOKEN` trust domain stays distinct and is unaffected.
- The `/health` exemption is unchanged and is therefore not restated below.

The single, configured, *human-facing* operator token as the sole way to identify a
person is REMOVED.

## MODIFIED Requirements

### Requirement: Operator token gates the REST API

Every protected REST endpoint SHALL require an authenticated principal (the
unauthenticated health check and the GitHub OAuth start/callback endpoints, owned
by **multi-user-oauth**, are exempt). The orchestrator SHALL accept a request as
authenticated if EITHER:

1. it carries a valid GitHub-OAuth-derived session whose GitHub login is on the hard
   allowlist (session establishment, allowlist gating, and cookie/CSRF handling are
   owned by **multi-user-oauth**); OR
2. it carries `Authorization: Bearer <token>` matching the configured operator token
   AND the legacy operator-token path is explicitly enabled in configuration
   (`AUTH_TOKEN_LEGACY_ENABLED=true`, default `false`).

The orchestrator SHALL reject a request that satisfies neither path with HTTP 401 and
SHALL NOT execute the requested action. Both authentication paths grant the SAME
host-root-equivalent authority; the operator-token path is a service/break-glass
fallback, not a second privilege tier. This authority is a SEPARATE trust domain from
the runner `TASK_TOKEN` (which authenticates sandbox dial-back, not operators), and a
`TASK_TOKEN` SHALL NEVER satisfy either path.

#### Scenario: Allowlisted OAuth session is accepted
- **WHEN** a request carries a valid GitHub-OAuth session cookie whose GitHub login is on the allowlist
- **THEN** the orchestrator processes the request normally
- **AND** it does so without requiring any operator bearer token

#### Scenario: Operator bearer token is accepted only when the legacy path is enabled
- **WHEN** a request carries `Authorization: Bearer <token>` matching the configured operator token
- **AND** `AUTH_TOKEN_LEGACY_ENABLED` is `true`
- **THEN** the orchestrator processes the request normally as a service/break-glass principal

#### Scenario: Operator bearer token is rejected when the legacy path is disabled
- **WHEN** a request carries an otherwise-valid operator bearer token
- **AND** `AUTH_TOKEN_LEGACY_ENABLED` is `false` (the default)
- **THEN** the orchestrator responds 401 and performs no state change

#### Scenario: Request with no recognized principal is rejected
- **WHEN** a request to a protected REST endpoint carries neither an allowlisted OAuth session nor an accepted operator bearer token
- **THEN** the orchestrator responds 401 and performs no state change

#### Scenario: A runner TASK_TOKEN cannot authenticate an operator request
- **WHEN** a REST request presents a per-task runner `TASK_TOKEN` as the operator bearer token or session credential
- **THEN** the orchestrator responds 401 because the runner token domain is distinct from operator authentication

### Requirement: Operator token gates WebSocket connections

A client WebSocket connection SHALL be authenticated at connect time, before it is
joined to any task stream. Because browser WebSocket handshakes cannot set an
`Authorization` header, the connection SHALL be authenticated by EITHER:

1. the GitHub-OAuth session cookie sent with the WebSocket upgrade request, validated
   against the hard allowlist (owned by **multi-user-oauth**); OR
2. the existing token connect parameter / `bearer.<token>` subprotocol mechanism
   defined in the contracts package, matching the configured operator token, AND only
   when `AUTH_TOKEN_LEGACY_ENABLED=true`.

The orchestrator SHALL close an unauthenticated, non-allowlisted, or invalid
WebSocket connection before joining it to any task stream, and SHALL NOT emit any
terminal bytes or control frames on a connection it has not authenticated.

#### Scenario: Allowlisted OAuth session joins the stream
- **WHEN** a client opens a WebSocket whose upgrade request carries a valid OAuth session cookie for an allowlisted login
- **THEN** the connection is accepted and may subscribe to a task's terminal stream

#### Scenario: Operator-token subprotocol still works as the legacy path
- **WHEN** a client opens a WebSocket presenting the valid operator token via the contracts-defined connect parameter / `bearer.<token>` subprotocol
- **AND** `AUTH_TOKEN_LEGACY_ENABLED` is `true`
- **THEN** the connection is accepted and may subscribe to a task's terminal stream

#### Scenario: Unauthenticated or non-allowlisted client is closed before subscribing
- **WHEN** a client opens a WebSocket with no valid OAuth session and no accepted operator token (or with the legacy path disabled)
- **THEN** the orchestrator closes the connection and the client receives no terminal bytes or control frames

## REMOVED Requirements

### Requirement: Single configured operator token with constant-time comparison

**Reason**: The product moves from a single shared operator secret to GitHub OAuth
multi-user identity gated by a hard allowlist. A single `AUTH_TOKEN` can no longer be
the sole way to identify *who* is operating the platform — it cannot attribute
actions to a person, cannot be revoked per-user, and the design prototype itself
shows "OAuth identity + allowlist account `tanghehui`". The token mechanism survives
only as an optional, off-by-default service/break-glass fallback that is now folded
into the two gate requirements above (`AUTH_TOKEN_LEGACY_ENABLED`); it is no longer a
standalone "single configured operator token" requirement, and the
"refuse-to-start-when-`AUTH_TOKEN`-unset" rule is dropped because the platform now
boots on OAuth configuration instead.

**Migration**: See the **multi-user-oauth** capability for the replacement
requirements — GitHub OAuth start/callback flow, server-side session issuance and
validation, the hard allowlist gate (`tanghehui` and any additional configured
logins), per-user identity/attribution, and refuse-to-start-without-OAuth-config
behavior. Operators that still need a non-interactive credential set
`AUTH_TOKEN_LEGACY_ENABLED=true` and continue to use the existing constant-time
operator-token comparison via the legacy path described in the modified REST and
WebSocket gate requirements; constant-time comparison of the operator token, when
that path is enabled, is retained as part of those requirements rather than as a
standalone requirement.
