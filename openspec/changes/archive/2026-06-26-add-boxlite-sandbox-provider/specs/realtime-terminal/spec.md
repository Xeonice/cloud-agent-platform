## ADDED Requirements

### Requirement: TerminalGateway is provider-neutral and remains browser-facing

The live terminal browser protocol SHALL remain owned by CAP's `TerminalGateway` regardless of the selected sandbox provider. Provider terminal endpoints SHALL be consumed only by API-side terminal transports; browsers SHALL NOT connect directly to AIO, BoxLite, or any future provider terminal endpoint.

#### Scenario: Browser protocol is unchanged for BoxLite-backed tasks
- **WHEN** an operator opens a BoxLite-backed interactive task
- **THEN** the browser receives the same CAP terminal WebSocket protocol used by AIO-backed tasks
- **AND** the frontend does not branch on the selected sandbox provider

#### Scenario: Provider terminal URL is not exposed
- **WHEN** the provider returns an internal terminal endpoint descriptor
- **THEN** CAP uses it only server-side
- **AND** the browser receives no provider-native terminal URL

### Requirement: Terminal transport abstracts provider protocol details

The terminal layer SHALL split shared agent-terminal behavior from provider-specific transport. Shared behavior SHALL own detached session launch/attach, startup DSR handling, liveness polling, exit resolution, pause/resume, resize propagation, and stale bridge replacement. Provider transport SHALL own only connect/write/read/resize/close protocol translation for the selected provider.

#### Scenario: AIO uses an AIO transport behind the shared terminal
- **WHEN** an AIO-backed task opens a live terminal after the refactor
- **THEN** shared terminal behavior is unchanged and the AIO transport handles `/v1/shell/ws` frames

#### Scenario: BoxLite uses a BoxLite transport behind the shared terminal
- **WHEN** a BoxLite-backed task opens a live terminal
- **THEN** the shared terminal behavior is reused and the BoxLite transport handles provider-specific terminal or TTY frames

#### Scenario: Unsupported transport fails before terminal open
- **WHEN** the selected provider cannot supply a terminal transport satisfying interactive PTY semantics
- **THEN** the task does not open a live terminal and provisioning fails with a provider capability/preflight error

### Requirement: Gateway-owned recording and replay are provider-independent

The gateway SHALL continue to append raw terminal output to `session.log`, record `session.cast`, maintain snapshots, enforce write-lock, route approvals, and apply backpressure for every interactive provider. Provider transports SHALL NOT own these product-level recording or authorization responsibilities.

#### Scenario: BoxLite output is recorded by the gateway
- **WHEN** terminal output arrives from a BoxLite transport
- **THEN** the gateway appends the bytes to `session.log` and `session.cast` using the same path as AIO output

#### Scenario: Write-lock gates BoxLite input
- **WHEN** multiple operators view a BoxLite-backed task
- **THEN** only the write-lease holder's keystrokes are forwarded through the BoxLite transport

#### Scenario: Reconnect replay is provider-independent
- **WHEN** an operator reconnects to a BoxLite-backed task
- **THEN** reconnect replay uses CAP snapshots and `session.log` tail replay, not provider-native terminal history
