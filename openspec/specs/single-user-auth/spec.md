# single-user-auth Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
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

### Requirement: Health check is unauthenticated
The orchestrator SHALL expose a `/health` endpoint reachable without the operator token so platform/orchestrator liveness probes (Fly, compose) work without injecting secrets.

#### Scenario: Health probe needs no token
- **WHEN** `/health` is requested without an `Authorization` header
- **THEN** the orchestrator responds 200 with a health payload

