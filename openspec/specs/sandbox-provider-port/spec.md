# sandbox-provider-port Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: SandboxProvider port exposing sandbox-mode as a capability
The system SHALL define a `SandboxProvider` port abstraction whose `provision()` method accepts a `ProvisionContext` (which no longer carries a `taskToken`, since there is no dial-back to authenticate) and returns a `SandboxConnection { taskId, baseUrl, wsUrl }` rather than `void`, so that callers can address the provisioned sandbox by container name and open its terminal WebSocket. Providers SHALL be exposed through provider descriptors that include an id, location (`local` or `cloud`), priority, supported capabilities, and the provider implementation. Capability selection SHALL be provider-neutral: callers declare required capabilities, the provider center SHALL consider only providers satisfying all required capabilities, and selection SHALL order candidates by priority with optional preferred-location tie-breaking. The port SHALL continue to expose the execution sandbox mode (one of `read-only`, `workspace-write`, `danger-full-access`) as an explicit capability via `getSandboxMode()`, but that mode SHALL be treated as INFORMATIONAL only and SHALL NOT be the scheduling boundary — under AIO Sandbox the real isolation boundary is the container with `seccomp=unconfined` plus network isolation, not the reported mode. The concrete OS-isolating implementation SHALL remain deferrable and swappable without changing callers. `teardownSandbox` SHALL be unchanged.

Provider-neutral contracts and capability types SHALL live in `@cap-console/sandbox-core`. Provider registry, selection, lifecycle, workspace, readoption, selected-run routing, and shared terminal-session behavior SHALL live in the API-facing `@cap-console/sandbox` provider center. Concrete AIO, BoxLite, and cloud HTTP mechanics SHALL live in their owning provider packages. Internal scheduler, lifecycle, workspace-git, and AIO-local helpers SHALL NOT remain helper-only runtime packages, and conformance code SHALL be dev-only testkit or package test code rather than a production dependency. None of these layers SHALL require `@cap-console/api` internals.

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
- **THEN** the provider center only selects a provider whose descriptor advertises every required capability
- **AND** if multiple providers qualify, priority and optional preferred location determine the winner

#### Scenario: Local and cloud providers share the same port
- **WHEN** local AIO, BoxLite, or cloud HTTP providers are configured
- **THEN** the API consumes them through the same provider-center facade and `SandboxProvider` surface
- **AND** it does not branch on concrete implementation classes to provision a task

#### Scenario: Sandbox package boundaries match real extension points
- **WHEN** sandbox provider logic and package manifests are inspected
- **THEN** provider-neutral contracts live in `@cap-console/sandbox-core`, shared orchestration lives in `@cap-console/sandbox`, and backend mechanics live in concrete provider packages
- **AND** helper-only packages are not production runtime dependencies, conformance is dev-only, and `@cap-console/api` imports only the provider-center surface

### Requirement: Path to restore OS-level isolation is preserved
The `SandboxProvider` port SHALL be defined such that a future implementation can provide OS-level isolation (for example a Claude Code sandbox-runtime) by satisfying the same interface, without requiring changes to the port's consumers.

#### Scenario: A stricter mode is expressible through the same port
- **WHEN** a future implementation is registered that reports a non-`danger-full-access` sandbox mode
- **THEN** existing port consumers use it through the unchanged `SandboxProvider` interface
- **AND** no consumer code requires modification to honor the stricter mode

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

Each capability SHALL have exactly ONE internal spelling. A capability SHALL NOT
be expressed under two names that comparison sites must reconcile; where a
deprecated spelling must remain accepted for compatibility, it SHALL be
normalized to the canonical spelling at a SINGLE boundary and SHALL NOT exist
beyond it.

The distinction between provider-feature and CAP-operation capabilities SHALL be
TOTAL: every capability SHALL be classified, and the classification SHALL be the
source from which the vocabulary lists derive rather than a set of lists
maintained alongside it. Introducing a capability without classifying it SHALL
be a compile error. No hand-maintained copy of the vocabulary SHALL be the only
thing verifying the vocabulary.

#### Scenario: Provider feature capabilities compose into operation requirements
- **WHEN** CAP provisions an interactive task with workspace materialization
- **THEN** the planner resolves that operation into the required provider feature capabilities before selecting a provider

#### Scenario: Provider class checks are not used for selection
- **WHEN** AIO and BoxLite are both registered
- **THEN** selecting a provider for a task depends on declared capabilities, priority, and location preference, not on `instanceof` checks or provider names

#### Scenario: One capability has one internal spelling
- **WHEN** the capability vocabulary is inspected for two names denoting the same capability
- **THEN** none exist
- **AND** no comparison site treats one capability name as satisfying a requirement for another

#### Scenario: A deprecated spelling is accepted at the boundary only
- **WHEN** an operator's configuration declares a capability under a deprecated spelling
- **THEN** the provider's effective capability set is identical to the one produced by the canonical spelling
- **AND** the deprecated spelling does not appear in the resolved set

#### Scenario: An unclassified capability does not compile
- **WHEN** a capability is added to the vocabulary without being classified as a provider feature or a CAP operation
- **THEN** compilation fails
- **AND** the vocabulary lists cannot disagree with the vocabulary, because they derive from the classification

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

### Requirement: Provider command results require complete output settlement

A provider-neutral command executor SHALL return a successful normalized result
only after both process settlement and output settlement are proven. Process
settlement SHALL establish terminal state and exit code. Output settlement SHALL
establish that every stdout/stderr source promised by the result has been fully
drained, including the valid zero-length case. When a provider uses separate
channels for those facts, process success SHALL NOT imply output completeness.

If output settlement cannot be proven within the request's single absolute
deadline, the executor SHALL fail with a typed output-capture, transport, or
protocol outcome while preserving any known process settlement for internal
diagnostics. It SHALL NOT fabricate empty output or rerun the command. Provider
implementations SHALL release observation transports, timers, and cancellation
listeners on every terminal path.

#### Scenario: Process success alone is not complete command success

- **WHEN** a provider proves that a command exited successfully but has not proved its promised output streams are drained
- **THEN** the command executor does not return a successful normalized result
- **AND** it preserves the process fact separately from the incomplete-output outcome

#### Scenario: Proven zero-length stream returns valid empty output

- **WHEN** process settlement succeeds and output settlement proves that the command emitted zero bytes
- **THEN** the executor returns a successful result with valid empty stdout, stderr, and output

#### Scenario: Incomplete output fails without rerunning the command

- **WHEN** the output channel fails before proving completion after the command may have executed
- **THEN** the executor returns a typed output-unavailable outcome
- **AND** it does not rerun the potentially side-effecting command

#### Scenario: Independent settlement channels share one deadline

- **WHEN** a provider observes process and output settlement on independent channels
- **THEN** both channels consume one command-level absolute deadline
- **AND** completion of one channel does not start a second full timeout for the other

### Requirement: Provider conformance covers terminal, executor, workspace, and ownership contracts

Provider conformance SHALL verify every provider family eligible for task
provisioning, including AIO, cloud-http, and BoxLite, not only basic provision/teardown shape, but
also the provider's advertised terminal transport, command executor, workspace
transfer, readoption, retention, transcript, ownership, diagnostic emission, and
cleanup behavior. Command conformance SHALL distinguish process settlement from
output completion and SHALL reject any provider implementation that can
advertise command execution while returning a successful result with unproven
or incomplete output. Conformance SHALL fault-inject provider operation failure,
timeout, cancellation, indeterminate settlement, incomplete output, and cleanup
failure and SHALL verify bounded events, stable correlation, primary/cleanup
preservation, and secret absence. A provider SHALL NOT advertise a capability
that does not pass its conformance scenario.

Terminal conformance SHALL be stateful and SHALL exercise a real detached-session
fixture through at least an owner PTY and two independently opened viewer PTYs. It
SHALL prove distinct provider identities, attach-only current-screen restoration,
absence of historical-prefix replay, continued live delta, input and resize routing,
opaque-byte `onData`/`onBinary` input and correlated response routing, viewer-local
backpressure, independent close/replacement, cancellation fencing,
and task-teardown cleanup. It SHALL compare canonical terminal screen state after a
fresh attach at the same geometry rather than treating the presence of any output
as sufficient. Terminal conformance SHALL fail when an implementation aliases a
shared transport, pauses peers, launches on viewer attach, duplicates live output,
or leaks a provider-side terminal resource.

Command-output conformance SHALL cover a fast command whose process settles
before the output channel attaches, late replay, fragmented stdout/stderr, valid
empty output, early output-channel close/error, a hanging channel, shared
deadline exhaustion, and inconsistent channel settlement. These cases SHALL be
deterministic and SHALL NOT establish correctness through fixed sleeps. When a
real provider integration is available, its gated conformance story SHALL also
repeat fast-output commands against the supported provider protocol.

Task-scoped provisioning conformance SHALL also cover a terminal transition
that races the provider's physical create response. When an owner store is
available, orchestration SHALL persist a unique provider-selected legacy
invocation fence before calling the provider, SHALL revalidate it immediately
after publication against upstream Task authority and again before physical
create, SHALL persist an observed provider sandbox id before the provider may
continue initialization, and SHALL reject a late success transition after
cleanup has won. Absence of an active owner row alone SHALL NOT prove physical
absence; cleanup SHALL invoke the selected provider or the provider registry's
normalized teardown/absence checks and aggregate their actual evidence. A
create observation that loses to terminal cleanup SHALL trigger exact
partial-create cleanup rather than resurrecting a running owner. An unresolved
`entered` invocation SHALL remain pending when its bounded join or
post-invocation absence proof is unavailable. A compatibility provider that
does not invoke create callbacks SHALL still be blocked by the Router-owned
post-fence Task-authority recheck before its provider method is called.

#### Scenario: Terminal capability requires terminal conformance

- **WHEN** a provider declares interactive terminal capability
- **THEN** conformance verifies output, input, terminal-protocol replies, authoritative resize, close/replacement, and attach-only semantics
- **AND** it verifies fresh PTY identity, complete current-frame redraw, no historical prefix, exactly-once live continuation, opaque-byte mouse/input fidelity, independent backpressure, and bounded cleanup

#### Scenario: Fresh terminal identities restore the same canonical frame

- **WHEN** the conformance fixture opens two fresh viewer PTYs sequentially at identical rows and columns against an unchanged full-screen tmux session
- **THEN** both viewer streams reconstruct the same canonical current screen, cursor, and alternate-screen state
- **AND** each open reports a distinct provider PTY identity and neither stream depends on CAP replay data

#### Scenario: Terminal live continuation is not replayed or duplicated

- **WHEN** conformance emits a unique live marker after current-screen attach has settled
- **THEN** every still-open viewer receives that marker once through its own provider transport
- **AND** closing and freshly replacing one viewer restores the current frame without prepending the fixture's historical prefix

#### Scenario: Terminal close and backpressure remain viewer-local

- **WHEN** conformance pauses one viewer for backpressure and then closes it while another viewer and the owner remain open
- **THEN** only the targeted viewer transport pauses and closes
- **AND** the owner and peer viewer continue receiving a subsequent live marker

#### Scenario: Terminal open races are cleanup-conformant

- **WHEN** conformance injects cancellation, disconnect, timeout, or failure before a provider terminal open has fully attached
- **THEN** late provider completion is fenced and any observed terminal identity is closed by exact identity
- **AND** repeated close and cleanup settle without a ghost execution, dangling listener, or leaked authentication material

#### Scenario: Command capability requires complete-output conformance

- **WHEN** a provider declares command execution capability
- **THEN** conformance verifies that successful results require both process settlement and complete output settlement under one deadline
- **AND** fast commands, valid empty output, fragmented output, output transport failure, and inconsistent settlement cannot produce fabricated successful output

#### Scenario: Workspace delivery capability requires executor ownership

- **WHEN** a provider declares workspace delivery capability
- **THEN** conformance verifies delivery commands run in the provider-owned sandbox for the selected task

#### Scenario: Task provisioning requires diagnostic conformance

- **WHEN** a provider is eligible for task provisioning
- **THEN** conformance verifies its create, execution, process settlement, output settlement, cancellation, and cleanup paths emit bounded correlated safe outcomes
- **AND** a secret canary and raw provider diagnostic are absent from every emitted and persisted event

#### Scenario: Cleanup conformance preserves the primary failure

- **WHEN** conformance injects an operation failure followed by a cleanup failure
- **THEN** the provider returns the operation failure as primary and cleanup as secondary
- **AND** no cleanup exception replaces the primary failure

#### Scenario: Cancellation fences a legacy create before provider completion

- **WHEN** a task becomes terminal after the provider crosses its physical create boundary but before legacy `provision()` returns
- **THEN** cleanup obtains provider-backed deletion or absence evidence and the late provider continuation cannot recreate a running owner
- **AND** an observed late resource is removed by its exact provider identity

#### Scenario: Terminal winner prevents a later create boundary

- **WHEN** terminal cleanup changes the unique legacy invocation fence to deleting before the provider reaches physical create
- **THEN** provider-center's boundary revalidation rejects create I/O
- **AND** neither a callback-free success path nor a second replica can borrow the stale fence or recreate running ownership

#### Scenario: Missing ownership is not physical absence proof

- **WHEN** terminal cleanup finds no active owner while a task-scoped provider create may have been in flight
- **THEN** provider-center executes normalized provider teardown or absence checks
- **AND** it never reports confirmed absence solely from the empty owner lookup

#### Scenario: Every eligible provider family passes diagnostic conformance

- **WHEN** AIO, cloud-http, and BoxLite are each eligible for task provisioning
- **THEN** each family passes bounded start/settlement, output-completion, cancellation, cleanup, correlation, and secret-canary conformance
- **AND** Guardrails supplies shared outer-boundary evidence where a provider has no finer native operation

#### Scenario: AIO and BoxLite pass real fresh-attach conformance

- **WHEN** AIO or BoxLite advertises interactive terminal capability in an enabled real-provider gate
- **THEN** that provider passes the same fresh-identity, current-frame, no-history-prefix, live-delta, opaque-byte input, isolation, and resource-cleanup story against its supported native protocol
- **AND** provider-specific implementation details do not weaken the shared terminal contract

### Requirement: Provider identity has a single declaration

The set of provider families SHALL be declared exactly ONCE, and every schema,
validation, and decision that depends on which providers exist SHALL derive from
that declaration. A provider family list SHALL NOT be restated independently.

Where a surface legitimately admits a value outside the shared set — such as a
diagnostic emitted before a provider is selected — it SHALL be expressed as an
explicit extension of the shared declaration, so that the widening is visible
rather than hidden in a separately maintained list. Where a surface legitimately
covers only a SUBSET of providers, it SHALL be expressed as an explicit subset of
the shared declaration together with the reason, rather than as an independent
list that merely happens to be shorter.

A decision that must produce a value for every provider family SHALL be
expressed as a total mapping, so that introducing a provider is a compile error
at each site that must decide something for it.

#### Scenario: Adding a provider family fails the build at every decision point
- **WHEN** a new member is added to the provider-family declaration
- **THEN** compilation fails at every total mapping that must produce a value for it until each supplies one
- **AND** no schema silently continues to describe the previous set

#### Scenario: Provider-family schemas agree by construction
- **WHEN** the provider-family schemas are compared
- **THEN** their members are the shared declaration, plus only those extensions each states explicitly
- **AND** no schema carries a hand-written member list that can drift from the declaration

### Requirement: Conformance participation is derived from declared capabilities

The conformance families a provider is required to run SHALL be derived from the
capabilities that provider DECLARES, not chosen by the author of its test. A
provider that declares a capability whose conformance family is not exercised
SHALL fail.

Where a capability is exercised INDIRECTLY — by a shared implementation the
provider delegates to rather than by a provider-specific scenario — that
arrangement SHALL be stated explicitly as the coverage for that capability.

Where a capability has NO conformance scenario at all, that gap SHALL be
ENUMERATED as data alongside the mapping, naming the capability. Such a
capability SHALL NOT be demanded of a provider, and SHALL NOT be silently
skipped either: the enumeration is what turns it from an absence nobody can see
into a debt that is written down. An absent MAPPING ENTRY SHALL NOT read as
coverage — every capability SHALL resolve to a scenario family, a stated shared
coverage, or a stated gap.

Conformance participation SHALL be enforced by an executable ledger that derives
the required families from the provider's declared capabilities and FAILS the
provider's conformance run when a required family did not run. The obligation
SHALL NOT be restated by the provider's test — the test declares which family
each suite it builds belongs to, and what is REQUIRED is computed from the
declaration alone, so a family cannot be dropped by simply not mentioning it.

#### Scenario: Declaring a capability requires exercising it
- **WHEN** a provider declares a capability
- **THEN** the conformance family covering that capability runs for that provider
- **AND** the provider's conformance run FAILS if that family did not run, naming the capability and the family

#### Scenario: A capability that is not declared is not demanded
- **WHEN** a provider does not declare command execution
- **THEN** command-output conformance is not required of it
- **AND** its conformance result is unaffected by that family's absence

#### Scenario: Indirect coverage is stated, not inferred
- **WHEN** a capability is covered by a shared implementation's conformance rather than a provider-specific scenario
- **THEN** that is recorded as the explicit coverage for the capability

#### Scenario: A capability with no scenario is an enumerated gap, not a silent pass
- **WHEN** a capability has no conformance scenario in any family
- **THEN** it appears in the enumerated gap list naming the capability
- **AND** a provider declaring it is not failed for the missing scenario
- **AND** a capability that appears in NEITHER the family mapping nor the gap list fails, so a new capability cannot enter the vocabulary uncovered and unrecorded

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

### Requirement: Provision context carries resolved resources and deterministic workspace intent

The provider-neutral provision context SHALL carry the immutable resolved
sandbox resources plus a workspace materialization plan containing the
normalized repository URL, resolved branch, independent materialization
deadline, and an OPTIONAL typed exact-host credential descriptor. The plan
SHALL distinguish caller-supplied branch intent from the branch resolved for
checkout. A provider SHALL enforce every resolved resource it advertises and
SHALL fail eligibility before task sandbox creation when it cannot do so.

The credential descriptor SHALL be consumed only by a provider secret-write
primitive that does not place secret content in a guest command, argv,
environment, ordinary execution request field, connection metadata, audit
event, or log. Workspace commands SHALL receive only a temporary secret-file
path, and providers SHALL remove that file after use and before sandbox
retention.

#### Scenario: Provider receives immutable resources and branch

- **WHEN** orchestration provisions a task from a resolved environment and repository
- **THEN** the selected provider receives the snapshotted resources and resolved checkout branch in one provision context
- **AND** provider-specific orchestration does not re-read mutable environment defaults or invent a branch

#### Scenario: Secret content is absent from command execution

- **WHEN** a private workspace is materialized or pushed with an owner-scoped forge credential
- **THEN** command argv, command text, environment values, normal execution fields, logs, and persisted run metadata contain no credential value
- **AND** the provider consumes the secret through the redacted secret-write primitive and commands reference only its temporary path

#### Scenario: Explicit unsupported resource fails closed

- **WHEN** the resolved provision context contains a resource the provider cannot enforce
- **THEN** the provider rejects provisioning before creating a task sandbox
- **AND** orchestration records a safe provider/resource failure rather than silently ignoring the resource

### Requirement: Workspace materialization reports bounded stages and typed failures

Provider workspace materialization SHALL execute under a deadline independent
from control-plane request timeouts and SHALL report stable stages covering
credential setup, remote-ref resolution, repository transfer, checkout,
submodules, and credential cleanup. The repository transfer stage SHALL execute
as a detached supervised job through the shared detached-job primitive, and its
liveness SHALL be governed by dual gates replacing the single wall-clock
deadline for that stage only: a no-progress heartbeat gate that fails the
transfer when the job's progress stream shows no byte-growth or mtime advance
for the configured no-progress window, and an absolute cap bounding total
transfer time. Both gates SHALL be configurable policy knobs validated with
min/max bounds following the existing provisioning-policy snapshot pattern,
with defaults of 90 seconds (no-progress) and 1 hour (absolute cap).
Non-transfer stages SHALL retain the existing deadline semantics.

The repository transfer stage SHALL retry automatically on transient failure:
up to three attempts total within the unchanged materialization deadline, with a
short backoff between attempts, and no attempt SHALL start when the remaining
deadline budget is below a safe floor. Only failures whose typed cause is
TLS/network or the unknown fallback are retried; authentication, missing
branch/ref, capacity-exhaustion, and timeout failures SHALL NOT retry. Each
attempt SHALL be independently observable in diagnostics — a non-final failed
attempt settles as retryable and a subsequent attempt emits its own start — so
retries are never silent; the one-start/one-terminal invariant applies per
attempt. The transfer command SHALL remain idempotent so every attempt starts
from a clean workspace.

Failures SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results, and a transfer failed by
either liveness gate SHALL normalize to the typed timeout result. Stable Git
transport signatures observed on the transfer's captured output SHALL map to
the typed causes — connection reset/refused/timed-out, unresolvable host, RPC
failure, unexpected disconnect, early EOF, and transfer-closed map to
TLS/network; filesystem-full maps to capacity exhaustion; authentication-failed
and 401/403 responses map to authentication — with the raw output inspected
only in memory and never persisted, and unmatched output still normalizing to
the unknown fallback (never a fabricated cause). Each logical
stage attempt SHALL emit
at most one correlated start and one terminal or degraded diagnostic outcome,
and the emitted stage/cause SHALL agree with the provider-neutral result.
Diagnostic events SHALL NOT contain repository URLs, command or argv text,
stdout/stderr, temporary credential paths, request bodies, or raw Git/provider
errors. Cleanup SHALL execute in all success, failure, timeout, cancellation,
and retry paths, a cleanup failure SHALL remain secondary to the materialization
failure, and a retry SHALL be idempotent for the same task/workspace plan.

#### Scenario: Slow repository uses the workspace deadline

- **WHEN** repository transfer exceeds the provider's short control-plane timeout but completes within the configured workspace deadline
- **THEN** materialization continues and succeeds
- **AND** unrelated BoxLite health/create/inspect requests retain their shorter timeout

#### Scenario: Healthy slow clone outlives the legacy wall clock

- **WHEN** a repository transfer keeps advancing its progress stream but takes longer than the legacy 15-minute materialization deadline while staying under the absolute cap
- **THEN** the transfer is not killed and materialization succeeds

#### Scenario: Stalled transfer fails at the heartbeat gate

- **WHEN** a transfer's progress stream shows no byte-growth or mtime advance for the configured no-progress window (default 90 seconds)
- **THEN** the transfer stage settles as a typed materialization timeout well before the absolute cap
- **AND** sandbox-owned temporary state is cleaned up

#### Scenario: Runaway transfer fails at the absolute cap

- **WHEN** a transfer keeps emitting progress but exceeds the configured absolute cap (default 1 hour)
- **THEN** the transfer stage settles as a typed materialization timeout at the cap

#### Scenario: Liveness knobs are validated with bounds

- **WHEN** a deployment configures a no-progress window or absolute cap outside the allowed min/max range
- **THEN** policy snapshotting rejects or clamps the value per the provisioning-policy validation pattern rather than running with an unvalidated gate

#### Scenario: Transient network failure is retried and succeeds

- **WHEN** a repository transfer attempt fails with a TLS/network-class cause (for example a mid-transfer connection reset) and deadline budget remains
- **THEN** the transfer is retried from a clean workspace and materialization succeeds when a subsequent attempt completes
- **AND** the diagnostic stream shows the failed attempt settling as retryable followed by the new attempt's own start and terminal outcome

#### Scenario: Deterministic failures do not retry

- **WHEN** a repository transfer attempt fails with an authentication, missing-ref, or capacity-exhaustion cause
- **THEN** no further transfer attempt is made and the stage settles with that typed cause

#### Scenario: Retry respects the remaining deadline budget

- **WHEN** a transfer attempt fails but the remaining materialization deadline is below the safe attempt floor
- **THEN** no further attempt starts and the stage settles with the attempt's typed cause

#### Scenario: Git transport signatures map to typed network causes

- **WHEN** a transfer attempt's captured output carries a stable Git transport signature such as a connection reset, RPC failure, unexpected disconnect, or early EOF
- **THEN** the failure normalizes to the TLS/network typed cause rather than the unknown fallback
- **AND** no raw output text is persisted in diagnostics

#### Scenario: Unmatched output still falls back to unknown

- **WHEN** a transfer attempt fails with output matching no stable signature
- **THEN** the failure normalizes to the unknown fallback (never a fabricated cause)

#### Scenario: Disk exhaustion is distinguishable from authentication

- **WHEN** repository transfer fails because the guest filesystem is full after refs authentication succeeded
- **THEN** the provider returns the transfer stage with a capacity-exhaustion reason
- **AND** it does not misclassify the failure as an invalid forge credential

#### Scenario: Cancellation cleans temporary authentication

- **WHEN** a task is stopped or a materialization lease is superseded during repository transfer
- **THEN** provider execution is cancelled or fenced
- **AND** temporary credentials are removed before the sandbox is retained or deleted

#### Scenario: Materialization failure survives credential-cleanup failure

- **WHEN** repository transfer fails and removing its temporary credential state also fails
- **THEN** the transfer stage and its safe primary cause remain unchanged
- **AND** credential cleanup is emitted as a separate safe cleanup outcome

### Requirement: Task provisioning context carries a provider-neutral diagnostic emitter

Every task-scoped `SandboxProvisionContext` SHALL carry an attempt-scoped,
provider-neutral diagnostic emitter created by orchestration before the first
provider operation. The emitter SHALL accept only the shared strict diagnostic
event union and SHALL supply task, attempt, event-idempotency, and timestamp
correlation without exposing persistence or logging implementations to provider
packages. Providers SHALL report safe operation facts through CAP-generated
operation correlation identities and
SHALL NOT import Prisma, an audit service, an application logger, or a
provider-specific diagnostic store. Taskless environment validation and health
probes SHALL use an explicitly non-persisting observer rather than fabricate a
task attempt.

#### Scenario: Provider emits without owning persistence

- **WHEN** a provider starts and settles a task-scoped sandbox operation
- **THEN** it emits validated operation facts through the diagnostic emitter in the provision context
- **AND** the provider package performs no database, audit, or application-log write directly

#### Scenario: Taskless validation creates no task evidence

- **WHEN** a provider validates an environment or health probe without an owning task
- **THEN** it uses the explicit non-persisting observer
- **AND** no synthetic task id or diagnostic attempt is created

### Requirement: Provider cleanup reports a secondary outcome without replacing the primary failure

A provider operation that creates or may create a sandbox-owned resource SHALL
attempt required cleanup on success, failure, timeout, cancellation, and
supersession paths. The provider SHALL return or emit a distinct cleanup outcome
and MUST preserve any preceding primary provisioning failure unchanged. Cleanup
outcomes SHALL distinguish confirmed success, definitive failure, and
indeterminate/unconfirmed deletion using safe typed facts. Orchestration SHALL
record each physical result as cleanup-attempt evidence. For a durable owner,
any failed, indeterminate, or unconfirmed physical attempt SHALL leave canonical
cleanup `pending` while authoritative status remains deleting; only confirmed
removal or the configured atomic terminal policy may settle canonical cleanup.
A cleanup result SHALL contain no
raw provider error, resource endpoint, command, output, or credential material.

Physical provider deletion/confirmation failures are secondary to an already
recorded provisioning failure. Failures to authorize or acknowledge cleanup
through the ownership/lease/database fence are orchestration coordination errors
and SHALL retain durable worker recovery semantics rather than being downgraded
to ordinary physical cleanup failures.

#### Scenario: Cleanup failure follows a primary failure

- **WHEN** a provider operation fails and the subsequent cleanup also fails
- **THEN** the provider reports the original operation as the primary failure
- **AND** it reports the physical cleanup attempt as separate secondary evidence without replacing the primary error or prematurely settling durable cleanup authority

#### Scenario: Delete response is not proof of absence

- **WHEN** a provider accepts a delete request but resource absence cannot be confirmed
- **THEN** the provider reports an indeterminate physical result that orchestration projects as cleanup pending with a stable safe cause
- **AND** it does not report cleanup success merely because the delete request returned

### Requirement: Workspace transfer reports parsed clone progress

The detached repository transfer SHALL run `git clone` with `--progress`, with
stderr redirected to the job's progress marker, and SHALL parse that stream
tolerating git's multiple phases (Counting/Compressing/Receiving
objects/Resolving deltas), CR-delimited progress lines, and phases that carry
no percentage. The workspace progress event SHALL gain an additive variant
carrying only numeric transfer-progress facts — percent, receivedObjects,
totalObjects, receivedBytes, and throughput — where phases without a known
percentage SHALL be reported as explicitly unknown rather than 0. Progress
reporting SHALL remain best-effort/fire-and-forget: durable work state stays
authoritative and a lost progress report SHALL NOT fail or settle the stage.
The detached clone SHALL set `GIT_HTTP_LOW_SPEED_LIMIT`/`GIT_HTTP_LOW_SPEED_TIME`
as defense in depth so a stalled transfer self-terminates into a clean nonzero
exit marker.

#### Scenario: Receiving-objects percent is parsed and reported

- **WHEN** the detached clone's progress marker contains a CR-delimited `Receiving objects: 42% (N/M)` line
- **THEN** the emitted progress variant reports percent 42 with the parsed object counts
- **AND** the payload contains only numeric fields — no raw stderr text, URLs, or commands

#### Scenario: Pre-transfer phases report unknown, not zero

- **WHEN** the clone is still in a phase before object-transfer counts exist (e.g. remote counting)
- **THEN** the progress variant models percent as unknown/absent
- **AND** consumers can distinguish this from an actual 0% transfer

#### Scenario: Lost progress report does not affect settlement

- **WHEN** a progress report fails to deliver while the clone continues and eventually writes a success exit marker
- **THEN** the stage still settles as succeeded from the exit marker
- **AND** the missed report causes no stage failure or retry by itself

#### Scenario: Git self-terminates a low-speed stall

- **WHEN** the transfer rate stays below the configured low-speed limit for the configured low-speed time
- **THEN** git aborts the clone itself and the wrapper records a nonzero exit marker
- **AND** the stage settles as a typed failure without waiting for the external heartbeat gate

### Requirement: Provision context carries a typed WorkspaceSource union

The provision context SHALL carry the workspace origin as a typed union `WorkspaceSource` with at least the variants: `volume` (repo-store copy exposed via read-only per-repo mount), `archive` (repo-store copy transferred as an archive stream), and `git` (legacy in-sandbox network clone spec). The union SHALL be defined in `packages/sandbox-core` and replace the bare clone-spec as the provider-facing workspace intent. Providers SHALL declare which variants they support via the existing capability vocabulary.

#### Scenario: Provider receives a typed source
- **WHEN** orchestration provisions a task on a provider supporting `volume`
- **THEN** the provider receives a `volume` WorkspaceSource identifying the task's repo copy, not a raw clone URL

#### Scenario: Capability declaration gates variant selection
- **WHEN** the orchestrator selects an injection variant for a provider
- **THEN** only variants the provider declares are eligible

### Requirement: Repo-copy injection is the primary materialization path and git fallback is explicitly gated

Workspace materialization SHALL default to injecting the Repo's stored content copy (`volume` or `archive` variant per provider capability). The `git` variant (in-sandbox network clone) SHALL be selectable only through an explicit operator-facing configuration gate, defaulting to off, and its use SHALL be observable (diagnostics name the variant used). Orchestration SHALL fail closed with an actionable error when no supported variant is available, not silently fall back to `git`.

#### Scenario: Default provisioning uses injection
- **WHEN** a task provisions with default configuration on aio-local or boxlite
- **THEN** materialization consumes the stored copy and no network git clone runs inside the sandbox

#### Scenario: No silent git fallback
- **WHEN** a provider supports no injection variant and the git fallback gate is off
- **THEN** provisioning fails with an error naming the missing capability and the gate

### Requirement: Injected workspaces converge to the same git shape as cloned ones

Regardless of injection variant, the materialized workspace SHALL be a normal git working tree whose `origin` remote points at the Repo's recorded git source, so delivery (in-sandbox git push) and agent git operations behave identically to a workspace produced by the legacy clone path.

#### Scenario: Origin points at the real source after injection
- **WHEN** a workspace is materialized via `volume` or `archive` injection
- **THEN** `git remote get-url origin` in the workspace returns the Repo's recorded git source
- **AND** configured delivery behaves as before

### Requirement: Archive workspace transfer feeds the provisioning progress snapshot

Archive-variant workspace materialization SHALL report byte-based transfer progress into the existing provisioning progress snapshot (the `workspace_transfer` stage's percent/receivedBytes/throughput projection) so task reads surface live transfer feedback with no wire-schema change. Snapshot writes SHALL be time-throttled to at most one write per second. The total size SHALL be estimated from the stored copy's disk usage, with percent capped below 100 until the transfer completes; when no estimate is available, percent SHALL be null (the existing indeterminate semantics, never rendered as 0%). On deployments without a provisioning work row (legacy admission), progress reporting SHALL be silently skipped without affecting materialization.

#### Scenario: Large archive transfer exposes growing progress
- **WHEN** an archive injection transfers a copy large enough to span multiple throttle windows
- **THEN** successive task reads during the transfer expose the `workspace_transfer` stage with increasing receivedBytes and a percent value derived from the estimated total

#### Scenario: Writes are throttled to one per second
- **WHEN** many parts complete within one second
- **THEN** at most one progress snapshot write occurs for that second

#### Scenario: Legacy admission skips progress silently
- **WHEN** the deployment runs legacy admission with no provisioning work row
- **THEN** the transfer proceeds normally and no progress write is attempted or errored

### Requirement: `@cap-console/sandbox` is the API-facing provider center

The API SHALL consume sandbox behavior through `@cap-console/sandbox` as the provider center and host harness boundary. Provider registry composition, selection, explicit provider-family constraints, owner pinning, readoption routing, selected-run aggregation, workspace helpers, lifecycle planning, command executor resolution, provider readiness, and provider-neutral terminal session behavior SHALL live behind that center rather than in API-local wiring or helper-only packages.

#### Scenario: API imports sandbox behavior through the center
- **WHEN** API sandbox, task, guardrail, terminal, and retention code imports sandbox-layer functionality
- **THEN** it imports the API-facing surface from `@cap-console/sandbox`
- **AND** it does not import scheduler, lifecycle, workspace-git, conformance, AIO-local, or provider-helper packages directly
- **AND** it does not import concrete provider factories, provider env readers, provider terminal transports, or provider command executor implementations

#### Scenario: Provider center owns selected-run routing
- **WHEN** a lifecycle step needs terminal, command, workspace, retention, delivery, transcript, or teardown behavior for a task
- **THEN** the provider center resolves the selected run or durable owner record
- **AND** the step does not independently select a provider for an already-owned task

#### Scenario: Provider center owns configured registry creation
- **WHEN** the API binds the sandbox provider port
- **THEN** API passes a neutral host harness into `@cap-console/sandbox`
- **AND** `@cap-console/sandbox` composes AIO, BoxLite, cloud-http, and future provider descriptors according to configuration
- **AND** API does not branch on provider family or provider capability implementation details

### Requirement: Helper-only sandbox packages are not runtime extension packages

Sandbox helper logic SHALL be located inside the owning package unless it represents a stable external extension boundary. Scheduler, lifecycle, workspace-git, AIO-local configuration, and conformance helpers SHALL NOT remain runtime packages solely to hold internal helper code.

A package whose code has been superseded SHALL be REMOVED from the repository,
not merely excluded from the workspace graph. Excluding it stops the build from
seeing it but leaves it visible to every reader, grep and search — code that
cannot run while still reading as live, which costs review attention and
misdirects work onto files that no build would ever compile.

#### Scenario: Internal helpers move under owning packages
- **WHEN** the sandbox package graph is inspected after the refactor
- **THEN** scheduler, lifecycle, and workspace helper code is under `@cap-console/sandbox`
- **AND** AIO local configuration/spec helper code is under `@cap-console/sandbox-provider-aio`
- **AND** conformance helpers are dev-only testkit or test code rather than runtime dependencies

#### Scenario: A superseded package leaves no directory behind
- **WHEN** a helper package's code has moved to its owning package
- **THEN** the superseded package directory no longer exists
- **AND** no workspace exclusion entry remains for it
- **AND** documentation does not describe it as a package that exists

### Requirement: Provider packages expose backend descriptors through a common center contract

Each provider package SHALL expose descriptor factories and provider instances that the provider center can register without API-specific dependencies.

#### Scenario: A provider registers without Nest dependencies
- **WHEN** `@cap-console/sandbox` registers AIO or BoxLite provider descriptors
- **THEN** the descriptor is created from provider package exports and injected hooks
- **AND** the provider package does not import Nest, Prisma, API controllers, or API-local module wiring

#### Scenario: Explicit provider family remains fail-closed
- **WHEN** an operator explicitly selects a provider family and that provider cannot satisfy the required capabilities
- **THEN** the provider center fails provisioning with an actionable provider-selection error
- **AND** it does not silently fall back to another provider family

### Requirement: Interactive terminal providers expose fresh disposable PTYs

A provider that advertises interactive terminal capability SHALL allow CAP to
open more than one terminal transport for the same live sandbox. Every open for a
browser viewer SHALL create a fresh provider-side PTY identity and independent
transport; it SHALL NOT reuse the task owner PTY, a previous viewer PTY, or a CAP
snapshot/replay stream. The provider identity MAY be represented by a WebSocket
session id, execution id, or another provider-native handle, but it SHALL be unique
for concurrently live opens and remain internal to CAP diagnostics and cleanup.

After CAP resizes the fresh outer PTY and issues an attach-only command for the
existing exact named tmux session, the transport SHALL deliver tmux's complete
current-screen redraw even when the agent is otherwise idle, then continue with
subsequent live terminal bytes. It SHALL not prepend the detached pane's historical
scrollback merely because the viewer is new.

The viewer transport input seam SHALL accept opaque bytes, not only UTF-8 text. Each
provider adapter SHALL preserve browser `onData` bytes, `onBinary` legacy mouse bytes,
and correlated terminal-response bytes exactly through its native protocol to the outer
PTY. A string-only native protocol SHALL NOT be assumed byte-preserving; its adapter
MUST prove an explicit lossless encoding/decoding path or fail interactive-terminal
conformance. Input authorization remains above the provider seam in the Gateway.

#### Scenario: Concurrent opens have distinct provider identities

- **WHEN** CAP opens two viewer terminals for the same live AIO or BoxLite sandbox
- **THEN** the provider creates two distinct PTY identities and independently addressable transports
- **AND** neither open replaces, resumes, or aliases the owner PTY or the other viewer PTY

#### Scenario: Fresh attach reconstructs an idle current screen

- **WHEN** a fresh provider PTY is resized and attached to an existing tmux session whose full-screen TUI is idle
- **THEN** its output contains the complete tmux current-screen redraw, including the terminal control sequences needed to reconstruct cursor, style, and alternate-screen state
- **AND** CAP does not need new agent output, a headless snapshot, or `session.log` tail replay to populate the viewer

#### Scenario: Fresh attach does not replay terminal history

- **WHEN** the detached pane has produced a long historical prefix before the fresh viewer attaches
- **THEN** the fresh attachment restores the current visible frame without streaming that historical prefix as reconnect data
- **AND** history markers that are no longer present in the current frame do not appear in the fresh attach stream

#### Scenario: Attached viewer receives subsequent live delta once

- **WHEN** a marker is emitted after the fresh attachment has completed its current-screen redraw
- **THEN** that viewer receives the live marker without opening another PTY
- **AND** the marker is not duplicated by a snapshot, tail replay, or second provider stream

#### Scenario: Viewer input preserves opaque bytes

- **WHEN** conformance writes a byte-oracle payload and a representative xterm legacy
  mouse report through a viewer transport
- **THEN** the attached PTY observes exactly the original bytes, including `0x00`,
  `0x7f`, and values above `0x7f`, without UTF-8 expansion or replacement
- **AND** neither AIO's JSON framing nor BoxLite's binary framing weakens that contract

### Requirement: Disposable terminal lifecycle and flow control are isolated

Every disposable provider terminal SHALL have an idempotent close path that
releases only that PTY, its transport, timers, and cancellation listeners. Closing,
pausing, replacing, or failing one viewer terminal SHALL NOT close or pause the task
owner, the detached agent session, or another viewer terminal. A close or
cancellation that races asynchronous provider-side terminal creation SHALL fence
late completion: CAP SHALL not attach a late WebSocket or leave a ghost execution
after the caller has closed the terminal.

Normal task teardown SHALL close all remaining owner and viewer transports before
or as part of provider sandbox cleanup. Providers SHALL supply bounded evidence
that viewer resources were closed or became absent; an empty CAP in-memory map
alone SHALL NOT count as provider cleanup proof.

#### Scenario: Closing one viewer leaves the task and peers live

- **WHEN** two viewers are attached and CAP closes one viewer transport
- **THEN** only that provider PTY is released
- **AND** the detached agent session, owner stream, and other viewer continue to receive live output

#### Scenario: Slow-viewer backpressure is local

- **WHEN** one viewer exceeds its unacknowledged-output high-water mark
- **THEN** CAP pauses only that viewer's provider transport
- **AND** the owner, agent, activity/classification path, optional bounded raw writers, and every other viewer continue without being paused by that viewer's backlog

#### Scenario: Close during asynchronous open cannot create a ghost terminal

- **WHEN** CAP closes or cancels a viewer while the provider-side PTY create request is still unresolved
- **THEN** any late create result is fenced from attachment and is closed or removed by exact provider identity
- **AND** repeated close calls do not create another terminal, throw a cleanup error, or notify the closed viewer again

#### Scenario: Task teardown cleans every terminal identity

- **WHEN** normal task teardown runs with an owner and one or more viewer PTYs still open
- **THEN** provider cleanup closes or proves absent every terminal identity associated with the task
- **AND** no viewer execution, WebSocket, timer, pause state, or cancellation listener remains after cleanup settles

