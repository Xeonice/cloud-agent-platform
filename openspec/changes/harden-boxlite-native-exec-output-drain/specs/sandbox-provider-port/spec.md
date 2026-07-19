## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Provider conformance covers terminal, executor, workspace, and ownership contracts

Provider conformance SHALL verify every provider family eligible for task
provisioning, including AIO, cloud-http, and BoxLite, not only basic
provision/teardown shape, but also the provider's advertised terminal transport,
command executor, workspace transfer, readoption, retention, transcript,
ownership, diagnostic emission, and cleanup behavior. Command conformance SHALL
distinguish process settlement from output completion and SHALL reject any
provider implementation that can advertise command execution while returning a
successful result with unproven or incomplete output. Conformance SHALL
fault-inject provider operation failure, timeout, cancellation, indeterminate
settlement, incomplete output, and cleanup failure and SHALL verify bounded
events, stable correlation, primary/cleanup preservation, and secret absence. A
provider SHALL NOT advertise a capability that does not pass its conformance
scenario.

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
create, SHALL persist an observed provider sandbox id before
the provider may continue initialization, and SHALL reject a late success
transition after cleanup has won. Absence of an active owner row alone SHALL
NOT prove physical absence; cleanup SHALL invoke the selected provider or the
provider registry's normalized teardown/absence checks and aggregate their
actual evidence. A create observation that loses to terminal cleanup SHALL
trigger exact partial-create cleanup rather than resurrecting a running owner.
An unresolved `entered` invocation SHALL remain pending when its bounded join
or post-invocation absence proof is unavailable. A compatibility provider that
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
