## ADDED Requirements

### Requirement: Per-task AIO Sandbox container provisioning
The system SHALL provision exactly one AIO Sandbox container per task via dockerode `createContainer`, naming it `cap-aio-<taskId>` from the pinned derived AIO image, configured with `HostConfig.SecurityOpt` containing `seccomp=unconfined`, capable of joining the `cap-net` user-defined network, with `ShmSize` of approximately 2g and `AutoRemove` enabled, and with NO `PortBindings` so the container publishes no host port. After starting the container the system SHALL poll the sandbox `/v1/docs` endpoint until it responds (readiness) before treating the sandbox as usable.

#### Scenario: Container is created with required security and network options
- **WHEN** `AioSandboxProvider` provisions a sandbox for a task with id `<taskId>`
- **THEN** it calls dockerode `createContainer` with name `cap-aio-<taskId>` from the pinned AIO image
- **AND** `HostConfig.SecurityOpt` includes `seccomp=unconfined`
- **AND** the container is attached to the `cap-net` network with no `PortBindings` so no host port is published

#### Scenario: Readiness is confirmed by polling /v1/docs
- **WHEN** the container has been started
- **THEN** the provider polls `GET /v1/docs` on the sandbox and does not return the sandbox as ready until that endpoint responds successfully

#### Scenario: seccomp=unconfined is required
- **WHEN** the container is created without `seccomp=unconfined` in `HostConfig.SecurityOpt`
- **THEN** provisioning is treated as invalid and the sandbox is not used for task execution

### Requirement: SandboxConnection handle returned from provisioning
The `AioSandboxProvider.provision()` SHALL return a `SandboxConnection` handle carrying `taskId`, an HTTP `baseUrl` of the form `http://cap-aio-<taskId>:8080`, and a `wsUrl` of the form `ws://cap-aio-<taskId>:8080/v1/shell/ws`, so that the orchestrator can address the sandbox by container name over `cap-net` and open the terminal WebSocket. The provider SHALL also clone the task repository into the sandbox workspace via `POST /v1/shell/exec` before returning the handle.

#### Scenario: Provision returns an addressable connection handle
- **WHEN** provisioning completes for task `<taskId>`
- **THEN** the returned `SandboxConnection` has `taskId` set, `baseUrl` equal to `http://cap-aio-<taskId>:8080`, and `wsUrl` equal to `ws://cap-aio-<taskId>:8080/v1/shell/ws`

#### Scenario: Task repository is cloned before the handle is returned
- **WHEN** the sandbox is ready and before `provision()` returns
- **THEN** the provider issues a git clone of the task repository into the sandbox workspace via `POST /v1/shell/exec`

### Requirement: AioPtyClient connects into the sandbox terminal without session_id
The system SHALL provide an `AioPtyClient` that opens an OUTBOUND WebSocket as a WS client to the sandbox `ws://.../v1/shell/ws` endpoint and SHALL connect WITHOUT any `session_id` query parameter, so the sandbox creates a fresh tmux-backed session per task. The client SHALL treat the server-sent `session_id` then `ready` frames as the session-established signal. The client SHALL NOT attempt to rejoin an existing session by passing `?session_id=`.

#### Scenario: Connect-in opens a new session per task
- **WHEN** `AioPtyClient` connects for a task
- **THEN** it opens an outbound WebSocket to `ws://cap-aio-<taskId>:8080/v1/shell/ws` with no `session_id` query parameter
- **AND** it waits for the server `session_id` frame followed by the `ready` frame before considering the terminal live

#### Scenario: Rejoining an existing session is never attempted
- **WHEN** `AioPtyClient` establishes its terminal connection
- **THEN** it does not pass a `?session_id=` parameter to rejoin a prior session

### Requirement: Synthetic CPR injection so codex starts
The `AioPtyClient` SHALL watch the sandbox output stream and, on observing a DSR cursor-position query (`\x1b[6n` — standard DSR-6, with NO `?`), SHALL immediately send a synthetic CPR reply input frame `{type:"input",data:"\x1b[1;1R"}` to the sandbox, because codex (crossterm) emits the DSR query on startup and aborts with a cursor-position read error if no CPR reply arrives in time. The detector MUST match the no-`?` form exactly; the private-mode `\x1b[?6n` form is NOT what crossterm emits (matching it silently disables CPR injection and codex never starts — verified against the live sandbox: codex emits bytes `1b 5b 36 6e`). This injection SHALL be performed purely in the bridge layer without any AIO or tmux changes.

#### Scenario: CPR is injected on the DSR query
- **WHEN** the sandbox output stream contains the DSR cursor-position query `\x1b[6n` (standard DSR-6, no `?`)
- **THEN** `AioPtyClient` immediately sends an input frame with data `\x1b[1;1R` to the sandbox

#### Scenario: codex starts after CPR injection
- **WHEN** codex launches in the sandbox and the bridge injects the synthetic CPR reply
- **THEN** codex proceeds past startup and renders its TUI rather than aborting with a cursor-position read error

### Requirement: JSON to cap-frame translation preserving the browser protocol
The `AioPtyClient` SHALL translate between the sandbox AIO JSON WebSocket frames and the EXISTING base64 raw + control-frame protocol the front-end xterm speaks, leaving the browser-facing protocol unchanged. Sandbox `output` frames SHALL be surfaced as raw output (base64 raw chunks) into the existing terminal pipeline; operator keystrokes SHALL be sent as `{type:"input"}` frames; resize SHALL be sent as `{type:"resize",data:{cols,rows}}` frames; and a sandbox `ping` frame SHALL be answered with an internal `{type:"pong"}` that is distinct from the operator write-lease heartbeat.

#### Scenario: Sandbox output becomes raw browser output
- **WHEN** the sandbox sends an `{type:"output",data}` frame
- **THEN** `AioPtyClient` emits that data into the existing raw output pipeline so the browser xterm receives it via the unchanged base64 raw protocol

#### Scenario: Operator input and resize are forwarded as AIO frames
- **WHEN** an operator keystroke or a resize event reaches `AioPtyClient`
- **THEN** the keystroke is sent to the sandbox as a `{type:"input"}` frame and the resize as a `{type:"resize",data:{cols,rows}}` frame

#### Scenario: AIO ping is answered internally
- **WHEN** the sandbox sends a `ping` frame
- **THEN** `AioPtyClient` replies with an internal `{type:"pong"}` frame
- **AND** this pong is not conflated with the operator write-lease heartbeat

### Requirement: codex launched in-shell over the terminal channel
The system SHALL launch codex INSIDE the AIO shell over the `/v1/shell/ws` terminal channel (execution model A), preserving the interactive TUI, and SHALL NOT run codex via the request/response `exec`/MCP surfaces for the interactive terminal channel. The derived sandbox image SHALL be baked FROM the pinned AIO image with codex, `~/.codex/hooks.json`, and the compiled `dist/hooks` included.

#### Scenario: codex runs over the interactive terminal channel
- **WHEN** a task begins execution
- **THEN** codex is started inside the AIO shell over the `/v1/shell/ws` terminal channel
- **AND** codex is not launched through the request/response `exec` or MCP surfaces for the interactive terminal channel

#### Scenario: Derived image bakes codex and hooks
- **WHEN** the derived sandbox image is inspected
- **THEN** it is built FROM the pinned AIO image and includes codex, `~/.codex/hooks.json`, and the compiled `dist/hooks`

### Requirement: Blocking approval hooks re-homed via outbound HTTP callback
The blocking approval hooks (`permission_request` and `post_tool_use`) SHALL be re-homed to make an OUTBOUND HTTP callback from the sandbox to a NEW orchestrator approvals endpoint reachable over `cap-net`, reusing the EXISTING `onPermissionRequest`/`onDecision` approval routing so that only the transport changes. The approval semantics and routing above the transport SHALL remain unchanged.

#### Scenario: Approval request travels over HTTP callback to the orchestrator
- **WHEN** a hook inside the sandbox fires a `permission_request` or `post_tool_use`
- **THEN** the sandbox makes an outbound HTTP call to the orchestrator approvals endpoint over `cap-net`
- **AND** the orchestrator handles it through the existing `onPermissionRequest`/`onDecision` routing

#### Scenario: Approval routing is unchanged above the transport
- **WHEN** an approval decision is produced for a re-homed hook
- **THEN** the decision flows through the same `onDecision` routing used before the migration, with only the sandbox-to-orchestrator transport changed to an HTTP callback

### Requirement: Exit detection mapped to guardrails
Because the node-pty `onExit` signal no longer exists, the `AioPtyClient` SHALL detect task termination by observing the terminal WebSocket close and SHALL determine the exit status using `POST /v1/shell/exec` running `echo $?` and/or `/v1/shell/wait`, mapping a zero exit status to guardrails `recordSuccess` and a non-zero or abnormal termination to guardrails `recordFailure`.

#### Scenario: WS close triggers exit-status resolution
- **WHEN** the sandbox terminal WebSocket closes
- **THEN** `AioPtyClient` resolves the task exit status via `/v1/shell/exec` `echo $?` and/or `/v1/shell/wait`

#### Scenario: Exit status maps to guardrails outcome
- **WHEN** the resolved exit status is zero
- **THEN** the system calls guardrails `recordSuccess`
- **AND** when the resolved exit status is non-zero or the termination is abnormal, the system calls guardrails `recordFailure`
