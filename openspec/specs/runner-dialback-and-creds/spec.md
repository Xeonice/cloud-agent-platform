# runner-dialback-and-creds Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Runner dials back to the orchestrator
The runner SHALL establish its connection by dialing **out** to the orchestrator over WebSocket rather than listening on an inbound port, so that no sandbox exposes an inbound network port.

#### Scenario: Runner initiates the outbound connection
- **WHEN** a runner starts for a task
- **THEN** it opens an outbound WebSocket connection to the orchestrator
- **AND** it does not bind or listen on an inbound port for the orchestrator to connect to

### Requirement: Dial-back handshake authenticated by a short-lived TASK_TOKEN
The first frame the runner sends SHALL be a dial-back handshake frame, defined as a first-class frame type in the contracts package, carrying a short-lived per-task `TASK_TOKEN`, and the orchestrator SHALL reject the connection if the token is missing, malformed, expired, or not bound to the claimed task.

#### Scenario: Handshake frame is defined in contracts
- **WHEN** the WebSocket frame schema in the contracts package is inspected
- **THEN** it defines a dial-back handshake frame type that carries a `TASK_TOKEN` field

#### Scenario: Valid token is accepted
- **WHEN** a runner sends a dial-back handshake with a valid, unexpired `TASK_TOKEN` bound to its task
- **THEN** the orchestrator accepts the connection and associates it with that task

#### Scenario: Expired or wrong token is rejected
- **WHEN** a runner sends a dial-back handshake with a missing, malformed, expired, or mismatched `TASK_TOKEN`
- **THEN** the orchestrator rejects the connection and does not associate it with any task

### Requirement: Per-task token scope and one-task binding
Each `TASK_TOKEN` SHALL be scoped to exactly one task, and SHALL NOT be reusable to authenticate a connection for a different task.

#### Scenario: Token cannot authenticate a different task
- **WHEN** a runner presents a `TASK_TOKEN` issued for task A while claiming to be task B
- **THEN** the orchestrator rejects the handshake

### Requirement: Ephemeral credentials destroyed with the session
The sandbox-scoped credentials provisioned for a task SHALL be ephemeral and SHALL be destroyed when the session ends, and these ephemeral, session-bound credentials SHALL be treated as the primary safety boundary for the task.

#### Scenario: Credentials are revoked at session end
- **WHEN** a task's session ends, whether by completion, failure, or teardown
- **THEN** the credentials provisioned for that session are destroyed and can no longer authenticate

#### Scenario: Credentials are scoped to the session
- **WHEN** a session's ephemeral credentials are inspected
- **THEN** they are scoped to that single session and are not shared across tasks or persisted beyond the session lifetime
