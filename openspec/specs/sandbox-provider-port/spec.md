# sandbox-provider-port Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
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

### Requirement: Path to restore OS-level isolation is preserved
The `SandboxProvider` port SHALL be defined such that a future implementation can provide OS-level isolation (for example a Claude Code sandbox-runtime) by satisfying the same interface, without requiring changes to the port's consumers.

#### Scenario: A stricter mode is expressible through the same port
- **WHEN** a future implementation is registered that reports a non-`danger-full-access` sandbox mode
- **THEN** existing port consumers use it through the unchanged `SandboxProvider` interface
- **AND** no consumer code requires modification to honor the stricter mode

### Requirement: The transcript read is generalized behind a runtime-declared source-read strategy
The `SandboxProvider` port's transcript read (`readRolloutFromContainer`) SHALL be generalized so
the read strategy is supplied by the task's runtime rather than baked as a single-newest-JSONL
assumption. The provider SHALL resolve WHERE to read from the runtime's `transcriptArtifact(ctx)`
and HOW to read from the runtime's declared `readTranscriptSource` strategy, and SHALL return a
`TranscriptSource` (for codex/claude: `{ format, jsonl: string }`) rather than a bare string. For
the codex and claude single-file path the produced source SHALL be byte-identical in `jsonl`
content to the pre-refactor read — the same lexicographically-newest matching JSONL file's text —
so the existing single-file behavior is preserved. A future multi-record runtime SHALL be able to
supply a non-single-JSONL source through the SAME generalized read seam without breaking the
codex/claude single-file path. The read SHALL remain non-throwing: a miss (no container, no
matching file, unreadable) SHALL resolve to an absent source rather than an error, exactly as
before.

#### Scenario: Codex/claude single-file read returns the same content as before
- **WHEN** the provider reads the transcript for a `codex` or `claude-code` task whose retained container holds the rollout
- **THEN** it resolves the directory + glob from `transcriptArtifact(ctx)`, applies the runtime's single-newest-JSONL `readTranscriptSource` strategy, and returns a `TranscriptSource` whose `jsonl` equals the lexicographically-newest matching file's text — byte-identical to the pre-refactor single-file read

#### Scenario: A multi-record runtime supplies a non-single-JSONL source through the same seam
- **WHEN** a runtime declares a multi-record `readTranscriptSource` strategy
- **THEN** the provider produces that runtime's non-single-JSONL `TranscriptSource` through the same generalized read path, and the codex/claude single-file path is unaffected

#### Scenario: A read miss resolves to an absent source, never an error
- **WHEN** the provider attempts the transcript read but the container is gone, no file matches the glob, or the file is unreadable
- **THEN** the read resolves to an absent source (the prior null-on-miss contract) rather than throwing

### Requirement: Provider selection produces a selected run context

The sandbox scheduler SHALL produce a selected run context for each provisioned task instead of exposing only a raw provider object to downstream callers. The selected run context SHALL carry the selected provider id, effective capabilities, provider connection, terminal descriptor, command executor descriptor, workspace descriptor, image/runtime/preflight result, and retention/readoption policy needed by later lifecycle steps.

#### Scenario: Downstream lifecycle uses the same selected context
- **WHEN** a task is provisioned
- **THEN** runtime setup, terminal attach, delivery, transcript read, retention, teardown, and readoption consume the same selected run context or its durable owner record
- **AND** they do not independently re-select a provider for the already-provisioned task

#### Scenario: Missing selected context fails closed
- **WHEN** a lifecycle step requires a provider-owned sandbox but no selected run context or durable owner can be resolved
- **THEN** the step fails with a provider-owner error rather than guessing a writer provider

### Requirement: Capability vocabulary distinguishes provider features from CAP operations

The system SHALL maintain capability names for provider features such as command execution, interactive terminal transport, archive workspace transfer, retained transcript source, readoption, snapshot, sleep, and port exposure, while preserving operation-level required-capability helpers for CAP workflows. The scheduler SHALL match on capabilities rather than concrete provider class names.

#### Scenario: Provider feature capabilities compose into operation requirements
- **WHEN** CAP provisions an interactive task with workspace materialization
- **THEN** the planner resolves that operation into the required provider feature capabilities before selecting a provider

#### Scenario: Provider class checks are not used for selection
- **WHEN** AIO and BoxLite are both registered
- **THEN** selecting a provider for a task depends on declared capabilities, priority, and location preference, not on `instanceof` checks or provider names

### Requirement: Provider run ownership is durable enough for restart

After a provider successfully provisions a task sandbox, the system SHALL persist enough provider ownership metadata to reattach or tear down that sandbox after API restart. The metadata SHALL include at least the CAP task id, provider id, and provider sandbox identifier or connection key. Older tasks without persisted owner metadata MAY still use provider probing fallback.

#### Scenario: Restart reattaches through stored provider owner
- **WHEN** the API restarts while a task has a persisted provider owner record
- **THEN** readoption, terminal attach, delivery, and teardown first route through that provider owner

#### Scenario: Older tasks use probing fallback
- **WHEN** a retained or running task lacks persisted provider owner metadata
- **THEN** the system may probe compatible providers for backward compatibility
- **AND** it still does not deliver workspace changes through a provider that did not prove ownership

### Requirement: Workspace materialization is provider-neutral

The sandbox provider port SHALL expose workspace materialization and sync through provider-neutral descriptors or helpers. Implementations MAY use git clone, archive upload/download, provider file APIs, or provider-native volumes internally, but orchestration code SHALL not depend on those provider-specific mechanisms.

#### Scenario: Archive-backed provider materializes a workspace
- **WHEN** a provider supports archive upload/download rather than AIO-style git setup
- **THEN** CAP can materialize the selected workspace through the workspace descriptor without changing guardrails or terminal code

#### Scenario: Provider-native volumes are not canonical truth
- **WHEN** a provider uses a native volume or snapshot internally
- **THEN** CAP still treats its database, audit records, transcript archive, and configured workspace delivery as the durable truth

### Requirement: Provider conformance covers terminal, executor, workspace, and ownership contracts

Provider conformance SHALL verify not only basic provision/teardown shape, but also the provider's advertised terminal transport, command executor, workspace transfer, readoption, retention, transcript, and ownership behavior. A provider SHALL NOT advertise a capability that does not pass its conformance scenario.

#### Scenario: Terminal capability requires terminal conformance
- **WHEN** a provider declares interactive terminal capability
- **THEN** conformance verifies output, input, resize, close/replacement, and attach semantics

#### Scenario: Workspace delivery capability requires executor ownership
- **WHEN** a provider declares workspace delivery capability
- **THEN** conformance verifies delivery commands run in the provider-owned sandbox for the selected task

### Requirement: Explicit provider selection constrains eligible providers

When an operator explicitly selects a sandbox provider through deployment configuration, the scheduler registry SHALL restrict provisioning to that provider family. If the explicitly selected provider is unavailable, invalid, or missing required capabilities, provisioning SHALL fail closed with a provider-selection error instead of silently falling back to another provider.

#### Scenario: Explicit BoxLite does not fall back to AIO

- **WHEN** `CAP_SANDBOX_PROVIDER=boxlite` is configured
- **AND** BoxLite is invalid, unreachable, or missing required capabilities
- **THEN** task provisioning fails with a BoxLite/provider-selection error
- **AND** the scheduler does not provision an AIO sandbox as a fallback

#### Scenario: Explicit AIO does not select BoxLite

- **WHEN** `CAP_SANDBOX_PROVIDER=aio` is configured
- **THEN** the scheduler considers only AIO-compatible providers for task provisioning
- **AND** a configured BoxLite provider is not selected for new tasks

#### Scenario: Auto mode keeps capability selection

- **WHEN** `CAP_SANDBOX_PROVIDER=auto` or the variable is absent
- **THEN** platform policy chooses the default eligible provider family
- **AND** selection within that family still uses declared capabilities and priorities

### Requirement: Provider-selection errors are actionable

Provider-selection failures SHALL include the selected provider family and the missing or invalid dependency that prevented provisioning.

#### Scenario: Missing capability is reported

- **WHEN** the selected provider family lacks a capability required by the task's provision plan
- **THEN** the provisioning error names the provider family and the missing capabilities

### Requirement: Provision context carries a resolved sandbox environment

The sandbox provider port SHALL allow callers to pass a resolved sandbox
environment through `SandboxProvisionContext`. The resolved environment SHALL be
provider-neutral and non-secret. Providers SHALL consume this resolved metadata
instead of independently reading task or environment database rows.

#### Scenario: Provider receives resolved environment during provisioning

- **WHEN** a task is provisioned with a selected sandbox environment
- **THEN** `provision()` receives a `ProvisionContext` that includes the resolved
  environment metadata
- **AND** the provider does not query Prisma or task services to discover the
  environment

#### Scenario: Missing required environment fails closed

- **WHEN** a provider needs a resolved environment but none can be resolved from
  the task selection or deployment default
- **THEN** provider selection or provisioning fails with an environment
  resolution error
- **AND** the scheduler does not silently choose a different provider family to
  hide the mismatch

### Requirement: Selected run context carries environment metadata

The selected sandbox run context and durable owner metadata SHALL include
non-secret resolved environment metadata for provisioned tasks. Lifecycle steps
SHALL route through the selected provider owner and retain the environment
metadata for readoption, debugging, and task read surfaces.

#### Scenario: Selected run exposes environment metadata

- **WHEN** a sandbox run is selected or reattached after provisioning
- **THEN** the selected run context includes the environment id/source metadata
  that was used at provision time
- **AND** lifecycle steps do not re-resolve a new environment for that existing
  sandbox

#### Scenario: Owner record persists environment metadata

- **WHEN** the provider router records sandbox ownership for a provisioned task
- **THEN** the durable owner record includes non-secret environment metadata
- **AND** API restart readoption can report the environment that was used without
  reselecting a provider

### Requirement: Provisioning supports provider-neutral image parameter setup

The sandbox provider orchestration SHALL support a provider-neutral image parameter setup step that runs after workspace materialization and before agent runtime launch. The setup step SHALL use the selected provider's command executor and SHALL NOT require provider packages to import database services or secret storage. Providers SHALL receive only command-ready setup actions or non-secret descriptors from the host harness.

#### Scenario: Image parameter setup runs before runtime launch

- **WHEN** a task is provisioned with selected image parameters
- **THEN** CAP runs the image parameter setup step before launching the selected agent runtime
- **AND** tools invoked by the agent can read `/home/gem/.cap/image-env` during the first turn

#### Scenario: Provider packages stay database-free

- **WHEN** AIO or BoxLite performs image parameter setup
- **THEN** the provider executes commands supplied by the host harness through its command executor
- **AND** the provider does not query Prisma or decrypt secret parameters itself

#### Scenario: Missing optional image parameters do not block provider selection

- **WHEN** no image parameters are configured for the selected environment
- **THEN** provider selection and sandbox provisioning can continue
- **AND** no empty or placeholder secret is materialized

