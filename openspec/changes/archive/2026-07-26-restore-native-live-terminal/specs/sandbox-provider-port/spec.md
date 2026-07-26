## ADDED Requirements

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

## MODIFIED Requirements

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
