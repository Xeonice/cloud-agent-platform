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
- **THEN** conformance verifies output, input, resize, close/replacement, and attach semantics

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
Non-transfer stages SHALL retain the existing deadline semantics. Failures
SHALL normalize at least capacity
exhaustion, timeout, authentication, TLS/network, missing branch/ref, and an
unknown fallback into secret-free typed results, and a transfer failed by
either liveness gate SHALL normalize to the typed timeout result. Each logical
stage SHALL emit
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
