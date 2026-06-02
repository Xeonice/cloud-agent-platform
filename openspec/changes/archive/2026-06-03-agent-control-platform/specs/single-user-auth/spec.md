## ADDED Requirements

### Requirement: Operator token gates the REST API
Every REST endpoint other than the unauthenticated health check SHALL require a valid operator bearer token in the `Authorization` header. The orchestrator SHALL reject a missing, malformed, or non-matching token with HTTP 401 and SHALL NOT execute the requested action. This operator token is a SEPARATE trust domain from the runner `TASK_TOKEN` (which authenticates sandbox dial-back, not operators).

#### Scenario: Valid token is accepted
- **WHEN** a request carries `Authorization: Bearer <token>` matching the configured operator token
- **THEN** the orchestrator processes the request normally

#### Scenario: Missing or invalid token is rejected
- **WHEN** a request to a protected REST endpoint omits the `Authorization` header or carries a token that does not match the configured operator token
- **THEN** the orchestrator responds 401 and performs no state change

#### Scenario: A runner TASK_TOKEN cannot authenticate an operator request
- **WHEN** a REST request presents a per-task runner `TASK_TOKEN` as the operator bearer token
- **THEN** the orchestrator responds 401 because the two token domains are distinct

### Requirement: Operator token gates WebSocket connections
A client WebSocket connection SHALL be authenticated with the operator token at connect time (handshake header or connect parameter defined in the contracts package). The orchestrator SHALL close an unauthenticated or invalid WebSocket connection before joining it to any task stream.

#### Scenario: Authenticated client joins the stream
- **WHEN** a client opens a WebSocket presenting a valid operator token
- **THEN** the connection is accepted and may subscribe to a task's terminal stream

#### Scenario: Unauthenticated client is closed before subscribing
- **WHEN** a client opens a WebSocket with a missing or invalid operator token
- **THEN** the orchestrator closes the connection and the client receives no terminal bytes or control frames

### Requirement: Single configured operator token with constant-time comparison
The orchestrator SHALL read a single operator token from configuration (`AUTH_TOKEN`) and SHALL compare presented tokens using a constant-time comparison to avoid timing leaks. If `AUTH_TOKEN` is unset the orchestrator SHALL refuse to start rather than run unauthenticated.

#### Scenario: Token compared in constant time
- **WHEN** a presented token is checked against the configured token
- **THEN** the comparison uses a constant-time function rather than a short-circuiting string equality

#### Scenario: Refuses to start without a configured token
- **WHEN** the orchestrator boots with `AUTH_TOKEN` unset or empty
- **THEN** startup fails with a clear error rather than serving an unauthenticated API

### Requirement: Health check is unauthenticated
The orchestrator SHALL expose a `/health` endpoint reachable without the operator token so platform/orchestrator liveness probes (Fly, compose) work without injecting secrets.

#### Scenario: Health probe needs no token
- **WHEN** `/health` is requested without an `Authorization` header
- **THEN** the orchestrator responds 200 with a health payload
