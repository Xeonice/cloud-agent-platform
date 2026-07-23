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

The BoxLite provider SHALL expose command execution and archive/file transfer
through CAP's provider-neutral executor and workspace descriptors. Command
execution SHALL normalize exit code, stdout/stderr, timeout, working directory,
native terminal state, and error shape so runtime setup, preflight, delivery,
trim, transcript capture, and liveness checks do not depend on BoxLite-specific
response formats. A successful result SHALL require affirmative native success,
a successful exit-code settlement, and complete settlement of every output
source promised by the normalized result. Native `failed` or `killed` states
SHALL always normalize as a typed failure; when their exit code is absent, the
native parser SHALL retain null and diagnostics SHALL record the missing-exit
anomaly. Before adapting to the existing provider-neutral command result whose
exit code remains numeric, BoxLite SHALL throw a typed settlement failure rather
than fabricating zero/one or widening every provider's result. Only a response
without terminal proof is indeterminate. Malformed responses, poll timeout, and
transport loss SHALL retain distinct safe normalized outcomes.

For the native protocol, polling SHALL remain authoritative for process terminal
state and exit code, while the attach stream's terminal `exit` frame SHALL be
authoritative for complete stdout/stderr drain. Process settlement SHALL NOT
prove output completeness, including when polling reports completed with exit
code zero. CAP SHALL start polling and attach concurrently and SHALL join both
channels under one absolute command deadline. When polling settles first, CAP
SHALL keep or establish attach long enough to consume BoxLite's bounded replay
through its terminal output marker using only the deadline's remaining budget.
It SHALL NOT close attach merely because polling settled, because one event-loop
turn elapsed, or by starting a second full attach timeout.

An attach operation SHALL use an explicit success/degraded/timed-out result
rather than overloading null as both no output and transport failure. Attach
failure SHALL remain distinct from the process result: it SHALL NOT rewrite a
proven native state or exit code, but it SHALL prevent a successful normalized
executor result whose output completeness cannot be proven. The executor SHALL
raise a typed output-unavailable or protocol outcome rather than returning
fabricated empty output, and it SHALL NOT rerun the command to recover missing
output. A zero-byte stdout/stderr result SHALL be accepted only after the attach
terminal marker proves the streams were drained. Conflicting poll and attach
exit codes SHALL fail closed as a typed protocol inconsistency.

Normalized executor results MAY carry output for their existing in-process
consumer, but diagnostic events, logs, persistence, REST, and MCP MUST NOT carry
that output or the command that produced it.

#### Scenario: Command execution returns normalized results

- **WHEN** CAP runs a setup or preflight command through the BoxLite executor and both process and output settlement complete
- **THEN** the result carries a normalized exit code and complete output text independent of the BoxLite client response shape

#### Scenario: Failed native state without exit code is never success

- **WHEN** BoxLite reports a native execution state of `failed` or `killed` without an exit code
- **THEN** the native parser records a failed result with null exit code and the adapter raises a typed settlement failure
- **AND** it never substitutes exit code zero or reports success

#### Scenario: Fast native execution drains late attach replay

- **WHEN** polling proves a fast native command completed before attach finishes its handshake
- **THEN** CAP consumes the late attach replay through its terminal `exit` frame within the original command deadline
- **AND** it returns the complete stdout/stderr without a fixed post-poll sleep

#### Scenario: Empty output requires completion proof

- **WHEN** a native command produces zero bytes and both poll and attach reach their terminal states
- **THEN** CAP returns a valid empty normalized output
- **AND** it distinguishes that result from an attach that failed before proving output drain

#### Scenario: Attach degradation preserves process truth but fails incomplete output

- **WHEN** attach errors, closes, or reaches the shared deadline before its terminal output marker while polling proves the process terminal state
- **THEN** diagnostics preserve the proven native state and exit code and report attach degradation separately
- **AND** the normalized executor call fails with a typed output-unavailable outcome rather than returning successful empty output
- **AND** CAP does not rerun the command

#### Scenario: Independent settlement channels share one deadline

- **WHEN** either polling or attach settles before the other channel
- **THEN** CAP waits for the remaining required terminal fact using only the original command deadline's remaining budget
- **AND** it does not begin a second full timeout after either channel settles

#### Scenario: Conflicting settlement channels fail closed

- **WHEN** polling and attach report different exit codes for the same execution
- **THEN** CAP raises a typed protocol inconsistency and records only bounded safe diagnostic facts
- **AND** it does not choose one code silently or return a successful normalized result

#### Scenario: Poll timeout remains distinguishable

- **WHEN** BoxLite cannot prove native execution settlement before its deadline
- **THEN** the executor returns a timeout or indeterminate normalized failure
- **AND** it does not infer success from an absent exit code or incomplete response

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
environment when the managed environment source is a compatible BoxLite registry
image reference. If task creation omits an environment and no managed default
exists, BoxLite SHALL continue to use the existing deployment-level image/rootfs
configuration and runtime maps. Managed BoxLite environment selection SHALL NOT
accept rootfs paths, loaded-image handles, uploaded artifacts, or local
provider-specific source descriptors.

#### Scenario: Selected BoxLite image environment is used

- **WHEN** a task selects a ready BoxLite image environment
- **THEN** BoxLite creates the sandbox with that resolved registry image source
- **AND** it does not use `BOXLITE_IMAGE` or `BOXLITE_IMAGE_MAP` for that task

#### Scenario: Managed BoxLite rootfs environment is rejected

- **WHEN** a task or environment record attempts to select a BoxLite rootfs-path
  environment as a managed image-library source
- **THEN** BoxLite provisioning is not attempted
- **AND** CAP returns an unsupported environment source error

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

### Requirement: BoxLite environment validation cleans up actual probe sandboxes

When validating a managed BoxLite image environment, the BoxLite provider SHALL
delete the actual provider sandbox id returned by the create/start flow. If the
provider returns a generated box id that differs from the requested probe name,
cleanup SHALL target the returned id. If creation fails before an id is known,
cleanup MAY best-effort delete the requested probe name, but validation SHALL
NOT report success merely because cleanup failed.

#### Scenario: Generated BoxLite box id is cleaned up

- **WHEN** managed image validation requests a probe sandbox name and BoxLite
  returns a different generated box id
- **THEN** validation uses the returned box id for exec and cleanup
- **AND** the returned box is deleted after validation finishes

#### Scenario: Cleanup failure does not mask validation failure

- **WHEN** BoxLite validation fails and cleanup also fails
- **THEN** the validation result remains failed for the original validation
  reason
- **AND** the cleanup failure is not reported as a successful validation

### Requirement: BoxLite image validation reports registry pull failures clearly

The BoxLite provider SHALL surface non-secret, actionable validation failures
when a managed BoxLite image cannot be pulled or started because of registry
transport, registry authorization, registry reachability, missing image,
architecture mismatch, or provider create/start errors. CAP SHALL NOT store
registry credentials or provider API tokens in validation output.

#### Scenario: HTTP-only registry fails with transport guidance

- **WHEN** BoxLite validation fails because the image reference points at a
  registry that the BoxLite host attempts to pull through unsupported HTTPS or
  otherwise cannot reach
- **THEN** validation fails with a non-secret message that identifies registry
  reachability or transport as the likely cause
- **AND** the environment does not become selectable

#### Scenario: Private registry authorization failure is distinct

- **WHEN** BoxLite validation fails because the BoxLite host lacks permission to
  pull a private image
- **THEN** validation fails with a non-secret message that identifies registry
  authorization as the likely cause
- **AND** CAP does not store the registry credential needed to fix it

### Requirement: BoxLite provisions selected image parameters and clears them before retention

The BoxLite provider SHALL run the provider-neutral image parameter setup step after the sandbox is created, started, and workspace materialization has completed, and before the selected agent runtime is launched. If a BoxLite sandbox is retained, readoptable, or stopped without immediate deletion, teardown SHALL attempt to remove `/home/gem/.cap/image-env` through the BoxLite command executor. Cleanup failures SHALL NOT block task settlement.

#### Scenario: BoxLite task receives image parameters before agent launch

- **WHEN** a BoxLite-backed task uses a sandbox environment with image parameters
- **THEN** BoxLite provisioning writes `/home/gem/.cap/image-env` inside the task sandbox before the agent runtime launch command runs
- **AND** the selected BoxLite image source is unchanged by parameter materialization

#### Scenario: BoxLite gcode wrapper can use image parameter token

- **WHEN** a BoxLite task uses an image containing `gcode` and a wrapper that sources `/home/gem/.cap/image-env`
- **AND** the selected image has `GCODE_TOKEN` configured as a secret parameter
- **THEN** the wrapper can run `gcode` commands without a token baked into the image or manually exported by the task operator

#### Scenario: BoxLite teardown clears materialized image parameters

- **WHEN** a BoxLite-backed task is stopped, retained, or otherwise made available for readoption without deletion
- **THEN** teardown attempts to remove `/home/gem/.cap/image-env`
- **AND** provider logs do not include plaintext parameter values

### Requirement: BoxLite enforces resolved disk capacity and a separate Git deadline

For native BoxLite provisioning, the provider SHALL send the resolved sandbox
disk size as `disk_size_gb` on sandbox creation and SHALL use that same resolved
value for environment-validation probes and task sandboxes. The value SHALL
come from the immutable managed-environment resource snapshot or the validated
BoxLite deployment fallback, and invalid or unsupported values SHALL make
BoxLite ineligible before task admission consumes a long-running slot.

BoxLite repository materialization SHALL execute the workspace transfer stage
as a detached supervised job polled through short control-plane execs rather
than one blocking exec held open for the whole transfer. Each poll SHALL use
the native REST control-plane timeout; transfer liveness SHALL be governed by
the dual-gate policy (no-progress heartbeat plus absolute cap) rather than a
single Git wall-clock deadline. A dropped or timed-out poll response SHALL NOT
force whole-sandbox fencing: the job's pid and exit markers provide settlement
proof, and a subsequent probe SHALL settle the stage from them. A transfer
failing either liveness gate SHALL return a typed materialization timeout and
clean up its sandbox-owned temporary state. AIO stage execution SHALL inherit
the identical detached path through the shared workspace-materialization hook.

#### Scenario: Native create receives the resolved disk size

- **WHEN** BoxLite provisions a validation probe or task whose resolved resource snapshot contains a disk size
- **THEN** the native create body contains the same `disk_size_gb` value
- **AND** the created sandbox reports a root filesystem consistent with the requested capacity before workspace materialization starts

#### Scenario: Deployment fallback supports legacy environments

- **WHEN** a legacy BoxLite environment has no explicit disk resource
- **THEN** provisioning uses the validated BoxLite deployment fallback and snapshots it on the run
- **AND** it does not fall back to an unobserved BoxLite SDK default

#### Scenario: Transfer outlives every individual poll exec

- **WHEN** a repository transfer takes longer than the BoxLite control-plane timeout while its progress stream keeps advancing
- **THEN** the transfer completes via repeated short polling execs
- **AND** no single exec request is held open for the transfer's full duration

#### Scenario: Dropped poll does not fence the sandbox

- **WHEN** one polling exec's HTTP response is dropped mid-transfer
- **THEN** the provider does not force-remove the sandbox
- **AND** the next marker probe settles the stage from the pid/exit markers (continue polling if alive, settle from the exit code if exited)

#### Scenario: Liveness-gate timeout stays typed

- **WHEN** a BoxLite transfer fails the no-progress heartbeat gate or the absolute cap
- **THEN** materialization returns the typed timeout result for the transfer stage
- **AND** sandbox-owned temporary state (including credential files) is cleaned up

### Requirement: BoxLite Git credentials are ephemeral and exact-host scoped

The BoxLite provider SHALL materialize an owner-scoped forge header through the
provider secret-write primitive into a mode-0600 temporary Git configuration
whose URL subsection matches only the normalized repository scheme and host.
Git clone, submodule, and push command strings SHALL contain only the temporary
config path. A submodule on a different host SHALL NOT receive the parent
repository header. The provider SHALL remove the temporary config in a `finally`
path and SHALL verify its absence before retaining a sandbox.

#### Scenario: Clone command contains no header value

- **WHEN** BoxLite clones a private repository
- **THEN** the BoxLite execution command/request contains only a temporary config path and no authorization header or token
- **AND** ordinary provider logs and errors do not include secret content

#### Scenario: Cross-host submodule does not inherit the parent token

- **WHEN** a private parent repository contains a submodule on a different host
- **THEN** the exact-host Git configuration sends the parent credential only to the parent host
- **AND** the different-host submodule succeeds with its own resolved credential or fails without receiving the parent token

#### Scenario: Retention proves secret cleanup

- **WHEN** clone, checkout, push, timeout, cancellation, or failure finishes and the BoxLite sandbox is retained
- **THEN** the temporary Git credential file is absent
- **AND** a repeated cleanup remains safe

### Requirement: BoxLite native operations emit bounded correlated diagnostics

For task provisioning, the BoxLite client and provider SHALL observe the bounded
lifecycle of sandbox create, start, inspect, native execution start, poll,
attach, settlement, workspace and runtime setup, delete, and absence
confirmation through the provider-neutral diagnostic emitter. Each logical
operation SHALL emit at most one start and one terminal or degraded outcome.
Polling loops and streaming frames SHALL NOT emit per-tick or per-frame events.
An event SHALL use only allowlisted safe facts such as operation kind, duration,
HTTP status class, normalized native state, nullable exit code, timeout,
retryability, stable cause, and CAP-generated attempt/operation identities. It
SHALL NOT contain a BoxLite request or response body, endpoint, raw native
resource/execution id, command, output, prompt, credential path, token, or native
error prose.

#### Scenario: Long native execution emits a bounded lifecycle

- **WHEN** BoxLite polls a native execution many times before it completes
- **THEN** the diagnostic ledger receives one logical operation start and one final settlement outcome
- **AND** no polling response or output frame is persisted as a separate diagnostic event

#### Scenario: Invalid native response emits a safe outcome

- **WHEN** BoxLite receives a malformed or incomplete poll or settlement response
- **THEN** it emits a typed failed or indeterminate terminal outcome with bounded safe facts
- **AND** it emits no raw response body or native error prose

#### Scenario: Failed terminal state without exit code is still failed

- **WHEN** BoxLite reports terminal state `failed` or `killed` without an exit code
- **THEN** diagnostics record a proven failed outcome with nullable exit code and the missing-exit anomaly
- **AND** only absence of terminal proof is classified as indeterminate

### Requirement: BoxLite cleanup preserves and follows the primary provisioning outcome

The BoxLite provider SHALL preserve the primary failure, execute bounded
cleanup, and report cleanup as an independent outcome when provisioning fails
after a box may have been created. A cleanup exception MUST NOT replace or rethrow in
place of the primary failure. Delete success SHALL require confirmed sandbox
absence. An unconfirmed physical result SHALL project to canonical cleanup
`pending` with a stable cause. A definitive physical delete failure SHALL update
the last cleanup-attempt evidence but SHALL NOT directly change a durable run
from deleting/pending to failed; only the authoritative reconciliation terminal
policy may do that atomically while relinquishing ownership. Replay of the same
physical cleanup attempt SHALL reuse its cleanup-attempt identity, while a later
physical retry SHALL receive the next bounded identity. Repeated cleanup SHALL
remain idempotent and SHALL emit no duplicate terminal outcome for one identity. BoxLite
internal partial-create cleanup and provider-center/router fallback teardown
SHALL share one cleanup lineage; fallback is a later bounded cleanup attempt,
not a replacement primary failure or silently swallowed exception.
Ownership/lease/database authorization or acknowledgement failures SHALL remain
orchestration coordination outcomes rather than ordinary BoxLite delete failures.

For task-scoped legacy provisioning, CAP SHALL persist the selected BoxLite
provider and unique invocation fence before calling its provision path, SHALL
revalidate that fence immediately before crossing `POST /boxes`, and SHALL
persist the definitive box id from the create response before runtime setup or
workspace materialization may continue. If cancellation or cleanup wins that
race, boundary validation or the observation callback SHALL fail closed so the
partial-create handler removes the exact returned box. Cleanup invoked without
an observed id SHALL still probe/delete BoxLite's deterministic task-scoped id
and confirm physical absence after the invocation settles; a missing CAP owner
record or an expired local join is not cleanup proof.

#### Scenario: Runtime setup failure survives BoxLite delete failure

- **WHEN** BoxLite runtime setup fails and deleting the created box also fails
- **THEN** the runtime setup failure remains the primary provisioning outcome
- **AND** the BoxLite delete-attempt failure is recorded separately while durable canonical cleanup remains pending under its deleting owner state

#### Scenario: Repeated BoxLite cleanup is idempotent

- **WHEN** Guardrails retries cleanup for the same attempt after an unconfirmed delete
- **THEN** BoxLite safely confirms absence or repeats deletion without creating another resource
- **AND** replay reuses the current cleanup identity, while a distinct later physical retry uses the next bounded cleanup identity

#### Scenario: Router fallback cleanup remains visible

- **WHEN** BoxLite internal cleanup is unconfirmed and provider-center invokes fallback teardown
- **THEN** the fallback is recorded as the next cleanup attempt in the same lineage
- **AND** its result neither duplicates the prior terminal event nor replaces the provisioning failure

#### Scenario: Cancellation after physical create removes the exact box

- **WHEN** BoxLite creates a box and task cancellation wins before provider provisioning returns
- **THEN** CAP records or consumes the definitive box id and confirms that exact box is removed
- **AND** runtime setup, workspace materialization, and agent launch do not continue as an authoritative task path

#### Scenario: Cancellation before create acknowledgement remains fail closed

- **WHEN** cancellation occurs after the create boundary while the BoxLite response is unresolved
- **THEN** the provider request is cancelled and provider-center performs a real deterministic-id teardown/absence check after settlement
- **AND** a late successful response is handled as a partial create and removed rather than exposed as running

### Requirement: BoxLite workspace materialization injects the repo copy via archive upload

The BoxLite provider SHALL materialize the task workspace from the Repo's stored copy by streaming the bare mirror as a tar archive through the existing archive-upload contract (`uploadArchive`) into the box, then performing a local `git clone` from the unpacked mirror into the workspace directory. The archive path SHALL be used because the BoxLite REST create API exposes no volume-mount field (verified against the create schema); if a future BoxLite API version exposes mounts, adoption SHALL go through a new declared capability rather than changing this default. Archive transfer SHALL be streamed (not buffered wholesale in memory) and its failure SHALL surface as a typed materialization failure.

#### Scenario: Copy reaches the box via uploadArchive
- **WHEN** a BoxLite task provisions with a ready copy
- **THEN** the bare mirror is delivered into the box through the archive-upload contract and the workspace is produced by a local clone inside the box
- **AND** no network git clone runs inside the box on this path

#### Scenario: Transfer failure is typed and actionable
- **WHEN** the archive upload fails mid-transfer
- **THEN** provisioning reports a typed workspace-materialization failure identifying the transfer stage

