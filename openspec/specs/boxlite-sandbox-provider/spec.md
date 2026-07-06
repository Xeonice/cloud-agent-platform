# boxlite-sandbox-provider Specification

## Purpose
TBD - created by archiving change add-boxlite-sandbox-provider. Update Purpose after archive.
## Requirements
### Requirement: BoxLite provider registration is explicit and capability-gated

The system SHALL register a BoxLite sandbox provider only when BoxLite
configuration is explicitly present. The provider SHALL declare only capabilities
that its configured client, sandbox source, and runtime preflight have validated,
and it SHALL NOT be selected for a task whose required capabilities are not fully
satisfied.

#### Scenario: BoxLite is disabled by default

- **WHEN** no BoxLite provider configuration is present
- **THEN** no BoxLite provider candidate is registered
- **AND** the existing AIO provider remains the default sandbox provider

#### Scenario: Invalid BoxLite configuration fails closed

- **WHEN** BoxLite configuration is present but the endpoint, credential, image
  mapping, rootfs mapping, or client mode is invalid
- **THEN** the BoxLite provider is not advertised as eligible for task
  provisioning
- **AND** task provisioning selects another compatible provider or fails with a
  provider-selection error

#### Scenario: BoxLite capabilities gate selection

- **WHEN** a task requires capabilities that BoxLite does not advertise
- **THEN** the scheduler does not select BoxLite for that task

### Requirement: BoxLite provision returns a CAP run context

The BoxLite provider SHALL provision an addressable sandbox for a task and return provider-neutral run descriptors consumed by CAP, including the provider id, task id, provider sandbox id, command executor descriptor, workspace descriptor, terminal transport descriptor when supported, and retention/readoption policy. Provisioning SHALL be idempotent for the same task while the provider-owned sandbox still exists.

#### Scenario: Provision creates one task-scoped BoxLite sandbox
- **WHEN** the scheduler selects BoxLite for a task
- **THEN** the provider creates or reuses one BoxLite sandbox associated with that task id
- **AND** it returns a run context that identifies both the CAP task id and the provider sandbox id

#### Scenario: Repeated provision is idempotent
- **WHEN** provisioning is retried for a task whose BoxLite sandbox already exists and is usable
- **THEN** the provider returns the existing run descriptors rather than creating a second sandbox for the same task

### Requirement: BoxLite command and archive operations normalize to CAP contracts

The BoxLite provider SHALL expose command execution and archive/file transfer through CAP's provider-neutral executor and workspace descriptors. Command execution SHALL normalize exit code, stdout/stderr, timeout, working directory, and error shape so runtime setup, preflight, delivery, trim, transcript capture, and liveness checks do not depend on BoxLite-specific response formats.

#### Scenario: Command execution returns normalized results
- **WHEN** CAP runs a setup or preflight command through the BoxLite executor
- **THEN** the result carries a normalized exit code and output text independent of the BoxLite client response shape

#### Scenario: Workspace materialization can upload an archive
- **WHEN** CAP materializes a workspace into a BoxLite sandbox via archive transfer
- **THEN** the provider uploads and extracts the archive at the selected workspace path without exposing provider-specific file APIs to orchestration code

#### Scenario: Workspace sync can download an archive
- **WHEN** CAP needs to capture or sync provider workspace files from BoxLite
- **THEN** the provider downloads an archive through the workspace descriptor and CAP consumes it through the provider-neutral workspace bridge

### Requirement: BoxLite terminal transport stays behind CAP TerminalGateway

When BoxLite advertises interactive terminal support, it SHALL provide an internal terminal transport descriptor for the API process. Browsers SHALL continue to connect only to CAP's `TerminalGateway`; BoxLite terminal URLs or sockets SHALL NOT be exposed as browser-facing endpoints.

#### Scenario: Browser never receives a BoxLite terminal URL
- **WHEN** an operator opens the live terminal for a BoxLite-backed task
- **THEN** the browser WebSocket connects to CAP's terminal endpoint
- **AND** the provider terminal URL or socket is consumed only by the API-side terminal transport

#### Scenario: Terminal transport supports interactive PTY operations
- **WHEN** BoxLite advertises live terminal capability
- **THEN** the transport supports output, operator input, resize, close, replacement after stale connection, and attach to the task's detached session

#### Scenario: Streaming exec alone is not advertised as live terminal
- **WHEN** the configured BoxLite client supports only non-interactive or polling command output
- **THEN** the provider does not advertise the interactive terminal capability

### Requirement: BoxLite runtime preflight proves image readiness

Before BoxLite is selected for a runtime, the system SHALL preflight the selected
BoxLite sandbox source for required tools and runtime CLIs. The source MAY be a
registry image or a local rootfs path. Missing tools, an unreadable rootfs path,
or an unsupported sandbox source SHALL fail provider eligibility before
credentials are injected, workspace materialization runs, or a long-running task
slot is consumed.

#### Scenario: Missing tmux blocks interactive selection

- **WHEN** the selected BoxLite sandbox source lacks `tmux` for an interactive
  runtime
- **THEN** runtime preflight fails and BoxLite is not selected for that task

#### Scenario: Missing agent CLI blocks runtime selection

- **WHEN** a task selects a runtime whose CLI is absent from the BoxLite sandbox
  source
- **THEN** runtime preflight fails with a distinct image/tooling error

#### Scenario: Missing rootfs path blocks selection

- **WHEN** BoxLite is configured with a rootfs path that is absent or unreadable
  by the BoxLite service
- **THEN** runtime preflight fails with a distinct rootfs readiness error
- **AND** BoxLite is not selected for that task

### Requirement: BoxLite sleep and snapshot are optional optimizations

The BoxLite provider MAY expose sleep, wake, and snapshot operations when supported by the configured client. These operations SHALL be treated as provider-native optimizations and SHALL NOT replace CAP's durable task, audit, workspace delivery, transcript archive, or retained-session records.

#### Scenario: Snapshot does not become canonical task state
- **WHEN** a BoxLite snapshot is created for a task sandbox
- **THEN** CAP still records task status, audit, delivery result, and transcript archive through provider-neutral durable paths

#### Scenario: Unsupported snapshot is capability-gated
- **WHEN** the configured BoxLite client or backend does not support snapshot
- **THEN** the provider does not advertise snapshot capability

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

BoxLite readiness probes SHALL validate that the configured image, image map,
rootfs path, or rootfs map can create and start a sandbox, create or verify the
configured workspace path during command execution, and execute commands required
for provider preflight. Native probes SHALL follow the same live BoxLite
contract as the runtime client: create without unsupported labels or a future
workspace `working_dir`, call the native start endpoint, then exec
workspace/tool checks. Missing image, missing rootfs path, missing shell, missing
workspace path, or incompatible architecture SHALL fail readiness before task
creation is reported usable.

#### Scenario: BoxLite image missing required runtime tools fails readiness

- **WHEN** the configured BoxLite sandbox source starts but lacks required
  shell/runtime tools for the advertised capabilities
- **THEN** the readiness probe fails with a distinct image/tooling error
- **AND** the provider is not selected for tasks requiring those capabilities

#### Scenario: Native readiness mirrors create-start-exec runtime contract

- **WHEN** quick-deploy runs a native BoxLite readiness probe
- **THEN** it creates the probe sandbox without `working_dir`
- **AND** it calls the native start endpoint before command execution
- **AND** it performs workspace and tool checks through exec after the sandbox is
  running

#### Scenario: Native readiness can probe rootfs path

- **WHEN** quick-deploy runs a native BoxLite readiness probe with
  `BOXLITE_ROOTFS_PATH`
- **THEN** it creates the probe sandbox from `rootfs_path`
- **AND** it performs the same start, workspace, and tool checks as image mode

### Requirement: BoxLite terminal output preserves streaming UTF-8
The BoxLite terminal transport SHALL decode stdout and stderr as streaming UTF-8 rather than decoding each WebSocket frame independently. It SHALL preserve multibyte code points split across provider frame boundaries before emitting output into CAP's provider-neutral terminal gateway.

#### Scenario: Split stdout character is preserved
- **WHEN** BoxLite sends stdout bytes for a multibyte UTF-8 character split across two WebSocket frames
- **THEN** CAP emits the original character in terminal output
- **AND** the browser terminal does not receive replacement characters for that split sequence

#### Scenario: Split stderr character is preserved independently
- **WHEN** BoxLite sends stderr bytes for a multibyte UTF-8 character split across two WebSocket frames
- **THEN** CAP emits the original character in terminal output without mixing stdout and stderr decoder state

#### Scenario: Decoder state is flushed on terminal close
- **WHEN** the BoxLite terminal stream exits or closes with buffered decoder state
- **THEN** the transport flushes any complete buffered text before closing the CAP terminal stream

### Requirement: BoxLite can provision from a local rootfs path

The BoxLite provider SHALL support a local rootfs source in addition to registry
image names. Configuration MAY provide `BOXLITE_ROOTFS_PATH` or
`BOXLITE_ROOTFS_PATH_MAP`, parallel to `BOXLITE_IMAGE` and `BOXLITE_IMAGE_MAP`.
For each runtime, the provider SHALL resolve exactly one sandbox source: either
an image name or a rootfs path. Native BoxLite create requests SHALL use
`rootfs_path` when a rootfs source is selected.

#### Scenario: Rootfs path configuration enables BoxLite without an image

- **WHEN** BoxLite env includes `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, and a
  valid `BOXLITE_ROOTFS_PATH`
- **THEN** BoxLite provider configuration is valid without `BOXLITE_IMAGE`
- **AND** the provider registers with the configured capabilities after runtime
  preflight passes

#### Scenario: Native create uses rootfs_path

- **WHEN** CAP provisions a BoxLite sandbox and the resolved runtime source is a
  rootfs path
- **THEN** the native BoxLite create request includes that path as `rootfs_path`
- **AND** it does not include a registry image value for the sandbox source

#### Scenario: Image mode remains unchanged

- **WHEN** BoxLite env includes `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` and no
  rootfs path for the selected runtime
- **THEN** the provider creates sandboxes with the resolved image name exactly as
  before

#### Scenario: Ambiguous runtime source fails closed

- **WHEN** a runtime resolves to both an image name and a rootfs path
- **THEN** BoxLite provider configuration is invalid
- **AND** the error identifies the conflicting runtime source configuration

#### Scenario: Rootfs path is rejected for unsupported protocol mode

- **WHEN** BoxLite rootfs-path configuration is selected with a protocol mode
  that cannot create native rootfs sandboxes
- **THEN** provider readiness fails with a clear compatibility error
- **AND** CAP does not advertise the BoxLite provider as ready

### Requirement: BoxLite provider-backed terminal story validates readiness

When the provider-backed terminal story is configured to use BoxLite, the system SHALL validate BoxLite endpoint configuration, image configuration, terminal mode, and terminal capabilities before creating the story session. Missing or invalid BoxLite configuration SHALL fail the story setup clearly and SHALL NOT fall back to AIO.

#### Scenario: Missing BoxLite configuration blocks story setup

- **WHEN** the provider-backed terminal story is configured for BoxLite and `BOXLITE_ENDPOINT`, `BOXLITE_API_TOKEN`, or `BOXLITE_IMAGE`/image map is missing
- **THEN** story setup fails before creating a sandbox
- **AND** the failure names the missing BoxLite configuration

#### Scenario: BoxLite terminal capability is required

- **WHEN** the provider-backed terminal story is configured for BoxLite without `BOXLITE_TERMINAL_MODE=pty` or without `terminal.websocket` and `terminal.interactive` capabilities
- **THEN** story setup fails before opening a terminal session
- **AND** the failure explains that interactive BoxLite terminal capability is required

#### Scenario: BoxLite endpoint readiness is checked

- **WHEN** the provider-backed terminal story is configured for BoxLite
- **THEN** the setup verifies the configured BoxLite endpoint is reachable using the configured API token before creating the story session
- **AND** an unreachable endpoint produces a clear readiness failure

#### Scenario: BoxLite story session stays behind CAP gateway

- **WHEN** the BoxLite-backed terminal story opens in the browser
- **THEN** the browser connects only to CAP's terminal gateway
- **AND** the BoxLite endpoint, API token, sandbox id, and native terminal URL remain server-side

#### Scenario: BoxLite terminal story verifies resize and UTF-8

- **WHEN** the BoxLite-backed terminal story verification runs
- **THEN** it proves output, input, resize, and UTF-8 text pass through the BoxLite terminal transport behind CAP's gateway
- **AND** the verification reports BoxLite as the provider path exercised

### Requirement: BoxLite provisions from a resolved environment source

The BoxLite provider SHALL provision a task sandbox from the resolved sandbox
environment when the environment source is compatible with BoxLite image or
rootfs execution. If task creation omits an environment and no managed default
exists, BoxLite SHALL continue to use the existing deployment-level image/rootfs
configuration and runtime maps.

#### Scenario: Selected BoxLite image environment is used

- **WHEN** a task selects a ready BoxLite image environment
- **THEN** BoxLite creates the sandbox with that resolved image source
- **AND** it does not use `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` for that task

#### Scenario: Selected BoxLite rootfs environment is used

- **WHEN** a task selects a ready BoxLite rootfs-path environment
- **THEN** BoxLite creates the sandbox with `rootfs_path` from that resolved
  environment
- **AND** it does not send a registry image value for the sandbox source

#### Scenario: Omitted environment preserves current BoxLite default

- **WHEN** a task omits `sandboxEnvironmentId` and no managed default environment
  is configured
- **THEN** BoxLite resolves the source from the existing deployment-level
  image/rootfs configuration for the selected runtime
- **AND** existing BoxLite deployments continue to provision as before

#### Scenario: BoxLite does not silently fall back on mismatch

- **WHEN** a task selects an environment that is not ready or not compatible with
  the selected runtime/provider family
- **THEN** BoxLite provisioning is not attempted
- **AND** CAP returns an environment compatibility error rather than silently
  using a different BoxLite image/rootfs
