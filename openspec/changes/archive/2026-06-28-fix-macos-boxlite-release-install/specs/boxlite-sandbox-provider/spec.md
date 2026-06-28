## ADDED Requirements

### Requirement: BoxLite protocol compatibility is managed by CAP

The BoxLite provider SHALL use a protocol implementation that is delivered and managed by CAP's run package. CAP MAY support BoxLite native REST directly or run a packaged compatibility adapter, but it SHALL NOT require an untracked operator-created script to translate BoxLite APIs.

#### Scenario: Native BoxLite REST is supported

- **WHEN** the configured BoxLite endpoint exposes the supported native BoxLite REST API
- **THEN** CAP provisions, inspects, executes commands, transfers workspace data, and tears down sandboxes through that API without requiring a separate ad-hoc adapter

#### Scenario: Compatibility adapter is managed when used

- **WHEN** CAP uses a compatibility adapter for BoxLite
- **THEN** the adapter is shipped or fetched as part of the source-free run package
- **AND** quick-deploy starts, supervises, health-checks, and configures it before the API reports BoxLite ready

#### Scenario: Unmanaged adapter is rejected

- **WHEN** BoxLite is selected but the configured endpoint only works through an absent or unmanaged adapter
- **THEN** provider readiness fails with a clear message
- **AND** CAP does not report the BoxLite provider as ready

### Requirement: BoxLite capabilities reflect implemented transports

The BoxLite provider SHALL advertise only capabilities backed by the configured protocol implementation and CAP-side transports. In particular, `terminal.websocket` and `terminal.interactive` SHALL NOT be advertised until CAP can open a working BoxLite terminal transport behind `TerminalGateway`.

#### Scenario: Exec-only BoxLite does not advertise terminal

- **WHEN** the BoxLite implementation supports create and command execution but does not support CAP's interactive terminal transport
- **THEN** it may advertise `command.exec`
- **AND** it does not advertise `terminal.websocket` or `terminal.interactive`

#### Scenario: Interactive BoxLite declares terminal only after transport conformance

- **WHEN** BoxLite advertises live terminal capabilities
- **THEN** conformance verifies output, input, resize, close/replacement, and attach behavior through CAP's API-side terminal transport

### Requirement: BoxLite readiness probes validate image and workspace assumptions

BoxLite readiness probes SHALL validate that the configured image or runtime image map can create and start a sandbox, create or verify the configured workspace path during command execution, and execute commands required for provider preflight. Native probes SHALL follow the same live BoxLite 0.9 contract as the runtime client: create without unsupported labels or a future workspace `working_dir`, call the native start endpoint, then exec workspace/tool checks. Missing image, missing shell, missing workspace path, or incompatible architecture SHALL fail readiness before task creation is reported usable.

#### Scenario: BoxLite image missing required runtime tools fails readiness

- **WHEN** the configured BoxLite image starts but lacks required shell/runtime tools for the advertised capabilities
- **THEN** the readiness probe fails with a distinct image/tooling error
- **AND** the provider is not selected for tasks requiring those capabilities

#### Scenario: Native readiness mirrors create-start-exec runtime contract

- **WHEN** quick-deploy runs a native BoxLite readiness probe
- **THEN** it creates the probe sandbox without `working_dir`
- **AND** it calls the native start endpoint before command execution
- **AND** it performs workspace and tool checks through exec after the sandbox is running
