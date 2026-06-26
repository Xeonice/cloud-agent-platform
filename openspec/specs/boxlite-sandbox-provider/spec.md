# boxlite-sandbox-provider Specification

## Purpose
TBD - created by archiving change add-boxlite-sandbox-provider. Update Purpose after archive.
## Requirements
### Requirement: BoxLite provider registration is explicit and capability-gated

The system SHALL register a BoxLite sandbox provider only when BoxLite configuration is explicitly present. The provider SHALL declare only capabilities that its configured client, image, and runtime preflight have validated, and it SHALL NOT be selected for a task whose required capabilities are not fully satisfied.

#### Scenario: BoxLite is disabled by default
- **WHEN** no BoxLite provider configuration is present
- **THEN** no BoxLite provider candidate is registered
- **AND** the existing AIO provider remains the default sandbox provider

#### Scenario: Invalid BoxLite configuration fails closed
- **WHEN** BoxLite configuration is present but the endpoint, credential, image mapping, or client mode is invalid
- **THEN** the BoxLite provider is not advertised as eligible for task provisioning
- **AND** task provisioning selects another compatible provider or fails with a provider-selection error

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

Before BoxLite is selected for a runtime, the system SHALL preflight the selected BoxLite image for required tools and runtime CLIs. Missing tools SHALL fail provider eligibility before credentials are injected, workspace materialization runs, or a long-running task slot is consumed.

#### Scenario: Missing tmux blocks interactive selection
- **WHEN** the selected BoxLite image lacks `tmux` for an interactive runtime
- **THEN** runtime preflight fails and BoxLite is not selected for that task

#### Scenario: Missing agent CLI blocks runtime selection
- **WHEN** a task selects a runtime whose CLI is absent from the BoxLite image
- **THEN** runtime preflight fails with a distinct image/tooling error

### Requirement: BoxLite sleep and snapshot are optional optimizations

The BoxLite provider MAY expose sleep, wake, and snapshot operations when supported by the configured client. These operations SHALL be treated as provider-native optimizations and SHALL NOT replace CAP's durable task, audit, workspace delivery, transcript archive, or retained-session records.

#### Scenario: Snapshot does not become canonical task state
- **WHEN** a BoxLite snapshot is created for a task sandbox
- **THEN** CAP still records task status, audit, delivery result, and transcript archive through provider-neutral durable paths

#### Scenario: Unsupported snapshot is capability-gated
- **WHEN** the configured BoxLite client or backend does not support snapshot
- **THEN** the provider does not advertise snapshot capability
