## MODIFIED Requirements

### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL define a `SandboxProvider` port abstraction whose `provision()` method accepts a `ProvisionContext` (which no longer carries a `taskToken`, since there is no dial-back to authenticate) and returns a `SandboxConnection { taskId, baseUrl, wsUrl }` rather than `void`, so that callers can address the provisioned sandbox by container name and open its terminal WebSocket. The port SHALL continue to expose the execution sandbox mode (one of `read-only`, `workspace-write`, `danger-full-access`) as an explicit capability via `getSandboxMode()`, but that mode SHALL be treated as INFORMATIONAL only — under AIO Sandbox the real isolation boundary is the container with `seccomp=unconfined` plus network isolation, not the reported mode. The concrete OS-isolating implementation SHALL remain deferrable and swappable without changing callers. `teardownSandbox` SHALL be unchanged.

#### Scenario: provision returns a SandboxConnection, not void
- **WHEN** a caller invokes `SandboxProvider.provision()` with a `ProvisionContext`
- **THEN** it returns a `SandboxConnection` carrying `taskId`, `baseUrl`, and `wsUrl`
- **AND** the returned handle is sufficient for the caller to open the sandbox terminal WebSocket without any further lookup

#### Scenario: ProvisionContext no longer carries a task token
- **WHEN** the `ProvisionContext` type accepted by `provision()` is inspected
- **THEN** it does not contain a `taskToken` field, because no dial-back handshake needs authenticating

#### Scenario: getSandboxMode is informational under AIO
- **WHEN** `getSandboxMode()` is called on the AIO-backed provider
- **THEN** the returned mode is treated as informational metadata
- **AND** the actual execution isolation boundary is the AIO container with `seccomp=unconfined` plus network isolation rather than the reported mode

#### Scenario: Port exposes a sandbox-mode capability
- **WHEN** the `SandboxProvider` port interface is inspected
- **THEN** it exposes the sandbox mode as an informational capability whose values include `read-only`, `workspace-write`, and `danger-full-access`

#### Scenario: Callers depend on the port, not a concrete impl
- **WHEN** orchestrator and runner code that provisions execution is inspected
- **THEN** it depends on the `SandboxProvider` port interface rather than directly on a specific sandbox implementation
- **AND** it consumes the returned `SandboxConnection` handle rather than assuming a `void` provision result

#### Scenario: teardownSandbox is unchanged
- **WHEN** the `teardownSandbox` signature and behavior are inspected after the redesign
- **THEN** they are unchanged from before the AIO migration

## REMOVED Requirements

### Requirement: Documented minimal Docker implementation forcing danger-full-access
**Reason**: The minimal `DockerSandboxProvider` this requirement documents is deleted and replaced by `AioSandboxProvider`. Its central claim — that Docker is the platform deploy plane and NOT the per-task execution sandbox — is inverted under AIO Sandbox: each task now runs in a dedicated AIO **container** that IS the per-task execution sandbox. The provider's sandbox-mode reporting is also downgraded to informational by the modified port requirement, so the `danger-full-access` reporting no longer drives behavior.
**Migration**: Per-task execution isolation is now specified by the `aio-sandbox-execution` capability — the AIO container with `seccomp=unconfined` plus network isolation (`cap-net`, no host port) is the boundary. codex still runs without an effective inner OS sandbox inside the container, but the boundary is the container itself, not a reported mode. The port's swap-without-changing-callers guarantee is preserved by the modified `SandboxProvider port exposing sandbox-mode as a capability` requirement and the retained `Path to restore OS-level isolation is preserved` requirement.

#### Scenario: No minimal Docker execution provider is documented after removal
- **WHEN** the `sandbox-provider-port` spec is inspected after the AIO migration
- **THEN** it no longer documents a minimal Docker `SandboxProvider` whose effective mode is `danger-full-access`
- **AND** per-task execution isolation is specified by the `aio-sandbox-execution` capability (AIO container + `seccomp=unconfined` + network isolation) instead
