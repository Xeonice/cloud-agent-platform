## MODIFIED Requirements

### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL define a `SandboxProvider` port abstraction whose `provision()` method accepts a `ProvisionContext` (which no longer carries a `taskToken`, since there is no dial-back to authenticate) and returns a `SandboxConnection { taskId, baseUrl, wsUrl }` rather than `void`, so that callers can address the provisioned sandbox by container name and open its terminal WebSocket. Providers SHALL be exposed through provider descriptors that include an id, location (`local` or `cloud`), priority, supported capabilities, and the provider implementation. Capability selection SHALL be provider-neutral: callers declare required capabilities, the scheduler SHALL consider only providers satisfying all required capabilities, and selection SHALL order candidates by priority with optional preferred-location tie-breaking. The port SHALL continue to expose the execution sandbox mode (one of `read-only`, `workspace-write`, `danger-full-access`) as an explicit capability via `getSandboxMode()`, but that mode SHALL be treated as INFORMATIONAL only and SHALL NOT be the scheduling boundary — under AIO Sandbox the real isolation boundary is the container with `seccomp=unconfined` plus network isolation, not the reported mode. The concrete OS-isolating implementation SHALL remain deferrable and swappable without changing callers. `teardownSandbox` SHALL be unchanged.

Reusable provider contracts, capability helpers, scheduler logic, lifecycle helpers, workspace clone planning, local AIO provider code, cloud HTTP provider code, and conformance tests SHALL live in dedicated workspace packages rather than inside `@cap/api`, so future providers can be added without importing API internals.

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

#### Scenario: Provider selection is capability based
- **WHEN** a task requires a set of sandbox capabilities
- **THEN** the scheduler only selects a provider whose descriptor advertises every required capability
- **AND** if multiple providers qualify, priority and optional preferred location determine the winner

#### Scenario: Local and cloud providers share the same port
- **WHEN** both local AIO and cloud HTTP providers are configured
- **THEN** the API consumes them through the same provider descriptor and `SandboxProvider` surface
- **AND** it does not branch on concrete implementation classes to provision a task

#### Scenario: Sandbox package boundaries are enforceable
- **WHEN** sandbox provider logic is inspected
- **THEN** reusable contracts, scheduler, lifecycle, workspace-git, local AIO, cloud HTTP, conformance, and facade code live in workspace packages
- **AND** `@cap/api` imports package surfaces rather than duplicating those reusable primitives locally

### Requirement: The transcript read is generalized behind a runtime-declared source-read strategy
The `SandboxProvider` port's transcript read (`readRolloutFromContainer`) SHALL be generalized so the read strategy is supplied by the task's runtime rather than baked as a single-newest-JSONL assumption. The provider SHALL resolve WHERE to read from the runtime's `transcriptArtifact(ctx)` and HOW to read from the runtime's declared `readTranscriptSource` strategy, and SHALL return a `TranscriptSource` (for codex/claude: `{ format, jsonl: string }`) rather than a bare string. For the codex and claude single-file path the produced source SHALL be byte-identical in `jsonl` content to the pre-refactor read — the same lexicographically-newest matching JSONL file's text — so the existing single-file behavior is preserved. A future multi-record runtime SHALL be able to supply a non-single-JSONL source through the SAME generalized read seam without breaking the codex/claude single-file path. When multiple providers are available, transcript reads SHALL be routed through the provider/facade capable of materializing the retained source for the task and runtime. The API SHALL consume that provider-neutral `TranscriptSource` rather than assuming the local AIO retained container. The read SHALL remain non-throwing: a miss (no container, no matching file, unreadable, or no provider able to materialize the source) SHALL resolve to an absent source rather than an error, exactly as before.

#### Scenario: Codex/claude single-file read returns the same content as before
- **WHEN** the provider reads the transcript for a `codex` or `claude-code` task whose retained container holds the rollout
- **THEN** it resolves the directory + glob from `transcriptArtifact(ctx)`, applies the runtime's single-newest-JSONL `readTranscriptSource` strategy, and returns a `TranscriptSource` whose `jsonl` equals the lexicographically-newest matching file's text — byte-identical to the pre-refactor single-file read

#### Scenario: A multi-record runtime supplies a non-single-JSONL source through the same seam
- **WHEN** a runtime declares a multi-record `readTranscriptSource` strategy
- **THEN** the provider produces that runtime's non-single-JSONL `TranscriptSource` through the same generalized read path, and the codex/claude single-file path is unaffected

#### Scenario: Transcript read is provider-neutral
- **WHEN** the API reads a retained transcript for a task
- **THEN** it requests the runtime-tagged source through the sandbox provider/facade seam
- **AND** parsing is selected from the returned runtime format rather than from a concrete provider class

#### Scenario: A read miss resolves to an absent source, never an error
- **WHEN** the provider attempts the transcript read but the container is gone, no file matches the glob, the file is unreadable, or no provider can materialize a retained transcript source for the task
- **THEN** the read resolves to an absent source (the prior null-on-miss contract) rather than throwing
