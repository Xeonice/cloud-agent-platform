## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: BoxLite command and archive operations normalize to CAP contracts

The BoxLite provider SHALL expose command execution and archive/file transfer
through CAP's provider-neutral executor and workspace descriptors. Command
execution SHALL normalize exit code, stdout/stderr, timeout, working directory,
native terminal state, and error shape so runtime setup, preflight, delivery,
trim, transcript capture, and liveness checks do not depend on BoxLite-specific
response formats. A successful result SHALL require affirmative native success
and a successful exit-code settlement. Native `failed` or `killed` states SHALL
always normalize as a typed failure; when their exit code is absent, the native
parser SHALL retain null and diagnostics SHALL record the missing-exit anomaly.
Before adapting to the existing provider-neutral command result whose exit code
remains numeric, BoxLite SHALL throw a typed settlement failure rather than
fabricating zero/one or widening every provider's result. Only a response
without terminal proof is indeterminate. Malformed responses, poll timeout, and
transport loss SHALL retain distinct safe normalized outcomes.

An attach operation SHALL use an explicit success/degraded/timed-out result
rather than overloading null as both no output and transport failure. An attach
failure SHALL be reported as a degraded operation independently from poll
settlement. When polling subsequently proves a terminal result, that
settlement SHALL determine the command result and the attach failure SHALL NOT
replace it. Normalized executor results MAY carry output for their existing
in-process consumer, but diagnostic events, logs, persistence, REST, and MCP
MUST NOT carry that output or the command that produced it.

#### Scenario: Command execution returns normalized results

- **WHEN** CAP runs a setup or preflight command through the BoxLite executor
- **THEN** the result carries a normalized exit code and output text independent of the BoxLite client response shape

#### Scenario: Failed native state without exit code is never success

- **WHEN** BoxLite reports a native execution state of `failed` or `killed` without an exit code
- **THEN** the native parser records a failed result with null exit code and the adapter raises a typed settlement failure
- **AND** it never substitutes exit code zero or reports success

#### Scenario: Attach degradation does not mask proven settlement

- **WHEN** streaming attach fails but polling later proves the native execution's terminal state and exit code
- **THEN** the command result follows the proven polling settlement
- **AND** the attach failure is emitted separately as degraded rather than replacing that result

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
