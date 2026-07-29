# realtime-terminal Specification

## Purpose
TBD - created by archiving change agent-control-platform. Update Purpose after archive.
## Requirements
### Requirement: Dual-channel WebSocket stream

The orchestrator SHALL stream a task's terminal over a WebSocket carrying two
logically distinct channels: a raw byte stream channel reproducing the active viewer
PTY output and a structured control-frame channel, where every control frame validates
against a contracts schema and a raw frame is never parsed as a control frame. The
front-end-facing protocol SHALL remain provider-neutral and SHALL continue to use
base64 raw frames plus structured control frames, while adding attachment lifecycle
and `terminal_response` variants required by fresh per-browser attachments. Provider
terminal transports SHALL translate AIO JSON, BoxLite TTY, or future native frames
below this browser-facing seam.

#### Scenario: Raw and control frames are distinguishable

- **WHEN** the orchestrator sends viewer terminal output and a control message over
  the same WebSocket
- **THEN** the raw byte stream is delivered on the raw channel and the control message
  is delivered as a structured frame validating against the contracts control-frame
  schema
- **AND** a raw byte frame is never interpreted as a control frame

#### Scenario: Browser protocol remains provider-neutral across the seam

- **WHEN** the front-end xterm receives terminal output and control frames from an
  AIO-backed or BoxLite-backed viewer attachment
- **THEN** it receives the same base64 raw + control-frame protocol for either provider
- **AND** provider-native protocol translation remains below the browser-facing seam

#### Scenario: Attachment lifecycle and terminal responses are contract-validated

- **WHEN** a browser opens or replaces a viewer attachment, or returns an xterm
  terminal response
- **THEN** fresh-attach, attachment-ready/unavailable, and `terminal_response` frames
  validate against the contracts control-frame schema
- **AND** attachment-scoped frames cannot be mistaken for durable replay offsets or
  human keystrokes

### Requirement: Live-frame parity under PTY parity conditions

The terminal rendered in the browser SHALL have byte-faithful input and output and a
canonical visible screen state identical to the native provider viewer PTY's live
frame when the rendering terminal uses `TERM=xterm-256color` semantics and the same
column and row dimensions as the authoritative detached tmux window. The task
owner/classifier SHALL remain an outbound provider-backed agent-terminal client for
launch, liveness, exit, readoption, and bounded failure evidence, while each browser SHALL render a separate
outbound provider PTY attached to the same tmux session. Full-screen TUI ANSI,
including alternate-screen state, SHALL pass byte-for-byte through provider output frames
and reproduce the current frame faithfully, including multibyte UTF-8 text split
across provider frame boundaries. Live current-frame parity is required; historical
scrollback parity is explicitly not required.

#### Scenario: Live frame matches under matching size and TERM

- **WHEN** the browser xterm provides `TERM=xterm-256color` semantics and its viewer
  PTY and the authoritative tmux window use identical cols and rows
- **THEN** the browser's canonical visible terminal state is identical to the native viewer PTY's live
  frame, including alternate-buffer selection, cursor position, style, and text

#### Scenario: AIO task owner and viewer use distinct provider-backed PTYs

- **WHEN** an AIO-backed task has a connected browser viewer
- **THEN** the task owner remains an outbound AIO transport behind the shared
  agent-terminal lifecycle seam
- **AND** the browser is backed by a different, freshly opened AIO PTY and tmux client
- **AND** neither path uses an inbound dial-back `RunnerPtyProxy`

#### Scenario: UTF-8 output survives provider frame boundaries

- **WHEN** provider terminal output splits a multibyte UTF-8 character across two
  transport frames
- **THEN** the browser terminal receives and renders the original character rather
  than replacement characters or underscores

#### Scenario: Scrollback divergence is permitted

- **WHEN** the fresh browser terminal's scrollback is compared to output emitted
  before that viewer attachment was created
- **THEN** historical scrollback is allowed to differ or be absent and is not subject
  to the live current-frame parity requirement

#### Scenario: Native terminal modes participate in parity

- **WHEN** Codex or Claude Code enters or exits its default alternate screen, changes a
  scroll region, requests focus/mouse reporting, or changes cursor style
- **THEN** those terminal state changes are represented in the browser xterm without a
  CAP normal-buffer emulation layer

### Requirement: Server-side backpressure with bounded high-water mark

The orchestrator SHALL apply application-level backpressure independently to each
browser viewer attachment's raw byte stream using a high-water mark not exceeding
500 000 bytes of unacknowledged output. Reaching the mark SHALL pause only that
viewer's provider PTY/transport, and draining below the low-water mark SHALL resume only
that attachment. A slow viewer SHALL NOT pause the detached agent, the task
owner/classifier, another viewer, or another task.

#### Scenario: Viewer PTY is paused at its high-water mark

- **WHEN** unacknowledged raw output buffered for one viewer reaches the 500 000-byte
  high-water mark
- **THEN** the orchestrator calls `pause()` on that viewer attachment's PTY/transport
- **AND** no shared task-level producer is paused on behalf of that viewer

#### Scenario: Viewer PTY resumes after drain

- **WHEN** that viewer acknowledges enough output to bring its unacknowledged total
  below the low-water mark
- **THEN** the orchestrator calls `resume()` on that viewer attachment and resumes its
  stream

#### Scenario: Slow viewer does not block other consumers

- **WHEN** one viewer remains paused while the task owner and a second viewer continue
  receiving output
- **THEN** owner activity/classification, agent progress, and the second viewer continue without
  waiting for the paused viewer

### Requirement: ACK-based pause/resume control frames

Because WebSocket provides no native application-level flow control, CAP SHALL define
explicit pause, resume, and acknowledgement frames on the control-frame channel. ACK
sequence accounting SHALL be scoped to one browser WebSocket and its immutable viewer
attachment and SHALL start from that connection's raw-stream origin rather than from a
durable `session.log` byte offset. An ACK from a closed or different WebSocket SHALL
NOT drain or resume the current attachment.

#### Scenario: Client acknowledgement advances its attachment counter

- **WHEN** the client emits an acknowledgement control frame for bytes received from
  its current viewer attachment
- **THEN** the server reduces that attachment's count of unacknowledged buffered bytes
  by the acknowledged amount

#### Scenario: Pause and resume frames are defined in contracts

- **WHEN** the control-frame schema in the contracts package is inspected
- **THEN** it defines explicit pause, resume, and acknowledgement frame variants with
  connection-scoped sequence semantics

#### Scenario: Stale WebSocket ACK cannot resume a replacement

- **WHEN** an ACK from an old WebSocket arrives after reconnect created a fresh
  WebSocket and attachment
- **THEN** CAP ignores the stale ACK
- **AND** the replacement attachment's backpressure counter is unchanged

### Requirement: requestAnimationFrame write coalescing
The browser client SHALL coalesce incoming raw bytes and flush them to `term.write()` at most once per `requestAnimationFrame` tick rather than once per WebSocket message, to cap `term.write()` invocation frequency.

#### Scenario: Multiple messages within one frame are coalesced
- **WHEN** several raw byte messages arrive within a single animation frame
- **THEN** the client issues at most one `term.write()` call for that animation frame containing the concatenated bytes

### Requirement: Terminal geometry synced to the sandbox PTY on connect

The orchestrator SHALL maintain one authoritative terminal geometry per task. Only the
current write-lease holder's viewer attachment SHALL set that geometry on connect,
reconnect, takeover, or resize. CAP SHALL resize the writer's provider PTY and the
authoritative detached tmux window to the writer's cols and rows; the task
owner/recorder and every browser tmux client, including the writer, SHALL use
ignore-size semantics so they do not compete in tmux's window-size calculation; CAP
SHALL change the pane geometry only through the explicit authoritative resize path. A
read-only viewer SHALL render the
authoritative geometry and SHALL NOT resize the task merely because its own browser
viewport differs.

The browser SHALL send its current geometry once its fresh-attach control path is open,
not only from an xterm resize callback that may have fired before the WebSocket was
ready. On explicit write-lease takeover, the new writer's current geometry SHALL become
authoritative, the former writer SHALL become logically read-only at the CAP gateway,
and its later resize events SHALL be ignored. A lease transfer SHALL NOT require either
browser PTY to be recreated. Resizing the detached tmux window remains best-effort when
the session is concurrently starting or exiting.

#### Scenario: Browser sends its geometry once the socket is open

- **WHEN** an operator's terminal WebSocket and fresh-attach control path become ready
- **THEN** the client sends its current terminal cols and rows even if the initial
  xterm resize event fired before the socket opened
- **AND** CAP applies them only if that viewer is the write-lease holder

#### Scenario: Writer reconnect geometry resizes the viewer PTY and detached tmux session

- **WHEN** the write-lease holder reconnects with a fresh attachment and reports its
  cols and rows
- **THEN** the orchestrator resizes that writer PTY and the detached tmux window to the
  reported geometry
- **AND** no snapshot headless terminal participates in live reconnect

#### Scenario: Codex renders at the writer size, not a sandbox or viewer default

- **WHEN** an operator becomes writer for a task whose tmux session was created at the
  sandbox default 80x24
- **THEN** CAP makes the writer's current cols and rows authoritative so Codex or Claude
  Code re-renders at that size
- **AND** read-only viewers and the task owner do not shrink or enlarge the tmux window

#### Scenario: Attached clients cannot override explicit geometry

- **WHEN** the owner, writer, and one or more readers are attached with different
  outer viewport histories
- **THEN** every tmux client uses ignore-size semantics
- **AND** only CAP's explicit writer-authoritative resize path changes the tmux window

#### Scenario: Detached tmux resize is best-effort

- **WHEN** an authoritative writer resize arrives before the detached tmux session
  exists or after it has exited
- **THEN** the orchestrator does not fail the task solely because the tmux resize could
  not be applied
- **AND** a later writer connect, reconnect, takeover, or resize may apply the geometry
  when the session is alive

#### Scenario: Read-only viewer resize is local only

- **WHEN** a browser without the write lease changes viewport size
- **THEN** CAP does not resize the detached tmux window or task owner
- **AND** the viewer remains logically read-only at the CAP lease boundary, keeps the
  current authoritative grid, and uses tmux ignore-size semantics

#### Scenario: Takeover transfers authoritative geometry

- **WHEN** an authenticated viewer explicitly takes over the write lease
- **THEN** CAP treats its existing attachment as the sole human-input writer and its
  current geometry becomes authoritative
- **AND** the previous writer's existing attachment remains a viewer without being
  recreated
- **AND** later human input and resize frames from the previous writer are rejected by
  the lease gate

### Requirement: A ready xterm always replaces the read-only fallback

The live session terminal SHALL render the real xterm whenever xterm successfully initializes —
including on WIDE viewports where initialization is slower. The readiness watchdog SHALL NOT
permanently strand the terminal on the read-only fallback when xterm is merely slow: a late `onReady`
(arriving AFTER the watchdog fired) SHALL recover the live terminal (clear the failed state) so the
ready xterm replaces the fallback. The fallback SHALL be shown ONLY for a GENUINE xterm failure (e.g.
the dynamic import threw / the canvas never mounts within a tolerant budget), not for slow
initialization.

#### Scenario: Slow (wide-viewport) xterm init still renders the real terminal

- **WHEN** the terminal page loads on a wide viewport and xterm takes longer than the readiness budget to initialize, then finishes
- **THEN** the real xterm replaces the fallback (the terminal is NOT permanently stuck on the read-only text view) and typing works

#### Scenario: A late onReady recovers from a fired watchdog

- **WHEN** the readiness watchdog has already flipped the failed state and xterm then becomes ready (a late `onReady`)
- **THEN** the failed state is cleared and the real xterm replaces the fallback

#### Scenario: Fallback only for a genuine failure

- **WHEN** xterm genuinely fails to initialize (the dynamic import throws / the canvas never mounts within the tolerant budget)
- **THEN** the read-only fallback is shown (the honest degraded state)

#### Scenario: Wide viewport renders the real terminal across reloads

- **WHEN** the operator reloads the terminal page repeatedly on a wide (≈1728px) viewport
- **THEN** each reload renders the real xterm (not 「降级为文本视图」) and accepts keyboard input

### Requirement: A headless task opens no live terminal

A headless task (`executionMode = headless-exec`) SHALL NOT open the live-terminal
WebSocket or mount xterm in the console; its execution output is structured events and
its live view remains the polled conversation. An interactive (`interactive-pty`) task
SHALL mount the live xterm and connect to CAP's terminal WebSocket, then obtain its
current frame through the fresh provider viewer-attachment handshake defined by this
change. The native interactive-terminal change SHALL NOT cause a headless task to open
an owner PTY, viewer PTY, or terminal WebSocket.

#### Scenario: Headless task does not mount the live xterm or WebSocket

- **WHEN** the console opens a running headless task
- **THEN** it does not open the terminal WebSocket or mount xterm
- **AND** it renders the polled conversation instead

#### Scenario: Interactive task opens a fresh live viewer

- **WHEN** the console opens a running `interactive-pty` task
- **THEN** it opens CAP's live-terminal WebSocket and mounts xterm
- **AND** the browser obtains a disposable provider viewer PTY rather than consuming
  headless structured output or the task owner stream

### Requirement: TerminalGateway is provider-neutral and remains browser-facing

The live terminal browser protocol SHALL remain owned by CAP's `TerminalGateway`
regardless of the selected sandbox provider. Provider terminal endpoints and
credentials SHALL be consumed only by API-side task-owner and viewer-attachment
transports; browsers SHALL NOT connect directly to AIO, BoxLite, or any future provider
terminal endpoint. `TerminalGateway` SHALL create and fence per-browser attachments,
enforce write leases and authoritative geometry, route attachment-local terminal
responses, and expose the same browser protocol for every conforming provider.

#### Scenario: Browser protocol is unchanged across providers

- **WHEN** an operator opens an AIO-backed or BoxLite-backed interactive task
- **THEN** the browser receives the same CAP terminal WebSocket protocol for either
  provider
- **AND** the frontend does not branch on the selected sandbox provider

#### Scenario: Provider terminal URL is not exposed

- **WHEN** the provider returns an internal terminal endpoint descriptor or credential
- **THEN** CAP uses it only server-side to create task-owner or viewer transports
- **AND** the browser receives no provider-native URL or credential

#### Scenario: Browser viewer lifecycle remains gateway-owned

- **WHEN** a browser attaches, reconnects, takes over, or disconnects
- **THEN** `TerminalGateway` coordinates the corresponding provider-backed viewer
  attachment through the provider-neutral seam
- **AND** provider-specific code does not bypass gateway authentication, lease, frame,
  or cleanup policy

### Requirement: Terminal transport abstracts provider protocol details

The terminal layer SHALL separate shared task-owner lifecycle behavior, shared viewer
attachment behavior, and provider-specific transport translation. Task-owner behavior
SHALL own detached session launch, startup DSR/CR compatibility, liveness polling, exit
resolution, runtime failure classification, and strict attach-only readoption. Viewer
behavior SHALL own fresh provider PTY creation, attach-only tmux client startup,
attachment bootstrap/ready state, role-specific read/write policy, attachment-local
pause/resume, resize, terminal responses, generation fencing, and close. Provider
transport SHALL own only connect/write/read/resize/close protocol translation for the
selected provider.

#### Scenario: AIO uses independent AIO transports behind the shared seams

- **WHEN** an AIO-backed task owner is running and a browser opens a viewer
- **THEN** shared owner and viewer behaviors use separate AIO transports
- **AND** the AIO transport handles `/v1/shell/ws` frames without owning browser lease,
  recording, or reconnect policy

#### Scenario: BoxLite uses independent BoxLite transports behind the shared seams

- **WHEN** a BoxLite-backed task owner is running and a browser opens a viewer
- **THEN** shared owner and viewer behaviors are reused
- **AND** each BoxLite viewer gets a distinct provider TTY execution/attachment whose
  protocol details remain inside the BoxLite transport

#### Scenario: BoxLite lossy outer chunks cannot rewrite child PTY bytes

- **WHEN** a BoxLite server decodes each outer terminal chunk as UTF-8 and an original
  child PTY code point would have crossed that provider chunk boundary
- **THEN** the image-owned bridge carries only bounded ASCII frames across the outer TTY
- **AND** canonical base64 `O` frames reconstruct the exact ordered child bytes without
  host-side replacement guessing or repair
- **AND** browser readiness is emitted only after a matching generation-fenced bridge
  `R` frame, not merely after the native WebSocket opens
- **AND** a missing bridge, timeout, early exit, malformed/oversized/non-ASCII frame,
  stale generation, or discontinuous output sequence fails explicitly and cleans only
  the exact BoxLite execution with deletion-plus-absence proof

#### Scenario: Unsupported transport fails before terminal open

- **WHEN** the selected provider cannot supply independent interactive PTYs with
  input, output, resize, close, and attach-only semantics
- **THEN** the task or provider-backed story does not open a live viewer
- **AND** setup fails with a provider capability or preflight error rather than falling
  back to another provider or launching through a nonconforming path

#### Scenario: Multiple viewer opens produce distinct PTY identities

- **WHEN** two browsers attach to the same running task
- **THEN** the provider-neutral viewer factory opens two distinct provider PTYs
- **AND** closing, pausing, resizing, or replacing one attachment does not close,
  pause, or replace the other

### Requirement: Gateway-owned recording and replay are provider-independent

Gateway-owned activity and failure handling SHALL remain provider-independent.
Bounded failure evidence, runtime classification, and exit mapping SHALL be sourced only from the single task
owner stream. Full raw `session.log` and `session.cast` SHALL be independent explicit
opt-ins and disabled by default for every provider. Structured transcripts SHALL remain
independent. Browser viewer output, attach command echo, current-screen redraw, resize
repaint, and duplicated live bytes SHALL enter none of those owner evidence/artifact
paths. Live browser connect/reconnect SHALL never consume a raw artifact.

#### Scenario: BoxLite owner output is classified with raw artifacts off

- **WHEN** eligible output arrives from a BoxLite-backed task owner under the default
  raw-off policy
- **THEN** the gateway updates activity and bounded failure evidence using the same
  provider-independent path as AIO
- **AND** it creates neither a log nor a cast writer

#### Scenario: Write-lock gates BoxLite human input

- **WHEN** multiple operators view a BoxLite-backed task
- **THEN** only the write-lease holder's human keystrokes and paste are forwarded to
  the task pane
- **AND** each viewer may still return terminal protocol responses to its own outer PTY
  only while a matching connection-local outstanding query remains live and unconsumed

#### Scenario: Live reconnect is independent of gateway replay artifacts

- **WHEN** an operator reconnects to an AIO-backed or BoxLite-backed running task
- **THEN** the gateway creates a fresh provider viewer attachment and tmux redraws the
  current screen
- **AND** the gateway sends no headless snapshot or `session.log` tail to the live xterm

#### Scenario: Viewer redraw is not owner evidence

- **WHEN** one or more viewers attach and each receives a complete tmux current-screen
  redraw
- **THEN** those viewer bytes are streamed only to their originating browsers
- **AND** they enter neither bounded owner evidence nor either opt-in raw artifact

#### Scenario: Finished raw terminal history is honestly unavailable by default

- **WHEN** an interactive task finishes after running in native alternate-screen mode
- **THEN** its structured transcript remains available under its own contract
- **AND** the raw terminal surface reports disabled/too-large/unavailable explicitly
  rather than fabricating an empty recording or redefining live reconnect semantics

### Requirement: Local xterm story verifies terminal rendering behavior

The realtime terminal SHALL provide a local-only xterm story or harness that mounts the
same shared terminal wrapper used by the console and verifies native full-screen
rendering behavior that is not covered by masked page screenshots. The story SHALL NOT
be exposed as a production console route and SHALL be runnable by local verification
tooling. It SHALL exercise unmodified alternate-screen bytes and shall not claim that
running-terminal history survives a reset or reconnect.

#### Scenario: Story mounts the shared terminal wrapper

- **WHEN** the xterm story is opened in local verification
- **THEN** it mounts the same shared `@cap-console/ui` terminal wrapper used by the live session
  terminal
- **AND** it imports the same app terminal styles needed for production-equivalent
  rendering

#### Scenario: Story reproduces the session height chain

- **WHEN** the session-shell terminal story is rendered at desktop and mobile viewport
  sizes
- **THEN** the terminal article fills the remaining viewport-height slot below the
  story header
- **AND** the xterm surface fills the terminal article body rather than rendering as a
  smaller partial region

#### Scenario: Story verifies native alternate-screen state

- **WHEN** the story writes alternate-screen enter, clear, cursor-addressed styled
  content, and alternate-screen exit bytes
- **THEN** xterm enters, renders, and exits the native alternate buffer without CAP
  stripping the sequences
- **AND** the story does not synthesize running-terminal scrollback from the raw bytes

#### Scenario: Story verifies UTF-8 rendering

- **WHEN** the story writes Chinese text and multibyte UTF-8 characters, including
  writes split across chunk boundaries
- **THEN** the rendered terminal output contains the original characters
- **AND** the output does not replace them with underscores or replacement characters

#### Scenario: Story verifies writer resize reporting

- **WHEN** the story's write-lease holder container is resized
- **THEN** xterm is refit to the new container
- **AND** the story records the latest writer terminal cols and rows reported through
  the shared terminal resize callback
- **AND** an equivalent read-only viewer resize does not become task-authoritative

#### Scenario: Terminal story checks run outside the masked visual baseline

- **WHEN** the terminal story verification command runs
- **THEN** it uses terminal-specific Playwright checks for geometry, alternate-screen
  state, current-frame content, UTF-8 text, cursor state, and resize events
- **AND** it captures and compares the unmasked terminal surface rather than relying on
  the existing design-baseline suite, which masks the live terminal region

### Requirement: Provider-backed terminal story uses CAP gateway

The realtime terminal SHALL provide an opt-in local provider-backed story that
validates the browser-to-CAP-terminal-gateway-to-provider fresh-attachment path. The
browser SHALL connect only to CAP's terminal WebSocket protocol and SHALL NOT receive
or use AIO, BoxLite, or other provider-native terminal URLs. The story SHALL create a
task owner/recorder plus disposable viewer attachments through the same seams used by
real tasks and SHALL validate current-screen redraw rather than gateway history replay.

#### Scenario: Provider-backed story is disabled by default

- **WHEN** the provider-backed terminal story creation endpoint or script is invoked
  without the explicit local enable flag
- **THEN** the system refuses to create a story session with a clear not-enabled result
- **AND** no sandbox provider resource is created

#### Scenario: Browser connects only to CAP terminal gateway

- **WHEN** the provider-backed story opens a live terminal
- **THEN** the browser connects to CAP's `/terminal` WebSocket using the same browser
  frame protocol as task terminals
- **AND** the browser receives no provider-native terminal URL or provider credential

#### Scenario: Story creates a deterministic provider-backed PTY fixture

- **WHEN** the provider-backed story setup runs with a valid selected provider
- **THEN** the API creates a temporary owner-backed tmux session through that provider
- **AND** the fixture emits a deterministic alternate-screen current frame containing
  styled UTF-8 and resize-sensitive geometry markers, preceded by enough uniquely
  marked historical output to detect accidental history replay
- **AND** the fixture provides deterministic live-delta and input-echo behavior

#### Scenario: Story verifies provider-backed terminal behavior

- **WHEN** provider-backed story verification runs against the temporary fixture
- **THEN** it verifies native alternate-screen output reaches xterm through CAP's
  gateway without filtering
- **AND** write-lease-holder input reaches the task pane
- **AND** writer resize changes are observed by the fixture while read-only viewer
  resize is not authoritative
- **AND** UTF-8 text renders without replacement characters

#### Scenario: Story verifies reconnect through fresh provider attachment

- **WHEN** the provider-backed story disconnects every viewer, waits while the current
  frame remains static, and reconnects
- **THEN** CAP creates a provider PTY with a different attachment identity
- **AND** tmux redraw restores the complete non-empty current frame before new fixture
  output is required
- **AND** uniquely marked historical output is not replayed into the fresh xterm
- **AND** the new viewer continues receiving exactly one copy of later live output

#### Scenario: Story verifies API readoption alignment

- **WHEN** the provider-backed story restarts the API control plane while the detached
  fixture session remains alive
- **THEN** readoption restores the task owner in attach-only mode without relaunching
  the fixture
- **AND** a later browser connection uses a new viewer PTY and restores the current
  frame without snapshot or tail replay

#### Scenario: Story session is cleaned up

- **WHEN** provider-backed story verification completes or fails
- **THEN** all disposable viewer PTYs, the task owner, the temporary tmux session, and
  the provider sandbox resource are released by their respective owners
- **AND** cleanup is verified rather than inferred solely from browser disconnect

### Requirement: Provider-backed story honors explicit provider selection

The provider-backed terminal story SHALL honor the operator-selected provider or topology for local verification. When a provider is explicitly requested, missing readiness or capability SHALL fail the story setup rather than silently selecting another provider.

#### Scenario: Explicit provider selection fails closed

- **WHEN** the story is configured to use a specific provider and that provider is not ready
- **THEN** story setup fails with the selected provider's readiness error
- **AND** the system does not fall back to another provider

#### Scenario: Default provider selection is reported

- **WHEN** no provider is explicitly requested and the local default provider is used
- **THEN** the story reports the provider id backing the temporary terminal session
- **AND** the verification output identifies which provider path was exercised

### Requirement: Provider-neutral terminal session logic lives under the sandbox center

Shared browser-facing live-terminal behavior SHALL live under the sandbox center rather
than API-local provider implementations. This includes selected-run terminal owner and
viewer-factory creation, provider transport selection, fresh attach-only viewer opening,
attachment outcome normalization, connection-local ACK/backpressure, authoritative
geometry propagation, byte-preserving input writes, and stale transport replacement. The sandbox center SHALL NOT
build live snapshot/tail replay frames or use durable terminal artifacts as a browser
reconnect source. Provider packages SHALL expose provider-specific terminal
session/transport factories behind the sandbox terminal harness.

#### Scenario: Provider packages do not own browser reconnect policy

- **WHEN** AIO or BoxLite provider package code is inspected
- **THEN** it exposes terminal descriptors, factories, or transport primitives for its
  backend
- **AND** it does not implement browser reconnect history, `session.log` tail selection,
  headless snapshot serialization, write-lease policy, or web reveal timing

#### Scenario: Sandbox terminal session consumes provider descriptors

- **WHEN** a browser attaches to a provider-backed interactive task
- **THEN** the sandbox terminal session layer resolves the selected run's terminal
  descriptor and opens a new attach-only viewer transport
- **AND** the resulting normalized attachment restores its current frame without
  snapshot or tail replay

#### Scenario: API gateway does not instantiate provider terminal clients

- **WHEN** `TerminalGateway.openSession()` or viewer attach handling is inspected
- **THEN** it delegates task-owner and viewer-factory creation to the sandbox terminal
  harness
- **AND** it does not instantiate AIO or BoxLite terminal clients, register provider
  protocol strings, or parse provider-specific terminal descriptor metadata

#### Scenario: Provider-specific terminal mechanics stay with the provider seam

- **WHEN** AIO or BoxLite needs provider-specific initial ready handling, PTY opening,
  attach command transport, resize, close, or exit-status resolution
- **THEN** the behavior is implemented by the owning provider package or sandbox
  terminal harness
- **AND** API terminal code receives only normalized owner/viewer events and outcomes

### Requirement: Web provider terminal fixtures verify initial render and reconnect

The web terminal SHALL have fixture-driven Playwright coverage for provider-backed
terminal rendering without starting CAP API or live provider resources. The fixture
SHALL model the final raw/control WebSocket contract and a fresh attachment's complete
tmux bootstrap/current-frame redraw; it SHALL NOT emit removed snapshot, tail replay, or
durable offset frames.

#### Scenario: Fixture hides until the fresh current frame has settled

- **WHEN** the web provider terminal fixture emits attaching state, a fragmented native
  alternate-screen bootstrap/current-frame redraw, and ready state
- **THEN** the terminal remains hidden or guarded while the frame is being consumed
- **AND** it reveals only after ready and the final xterm write flush with a non-empty
  expected current screen

#### Scenario: Fixture reconnect creates a clean attachment without history replay

- **WHEN** the fixture closes one connection and opens a new connection with a new raw
  sequence origin and fresh current-frame redraw followed by live bytes
- **THEN** the old xterm state is reset, the current frame is restored exactly once,
  and later live bytes continue exactly once
- **AND** no snapshot, tail, `fromSeq`, or prior scrollback data is consumed

#### Scenario: AIO and BoxLite descriptors render through the same web path

- **WHEN** fixture selected-runs use AIO and BoxLite terminal descriptors
- **THEN** the frontend renders through the same `SessionTerminal` attachment path
- **AND** it does not branch on provider family for browser protocol behavior

### Requirement: Each browser connection uses a fresh attach-only viewer PTY

Every authenticated browser connection to a running interactive task SHALL receive a
new provider-backed PTY and a new tmux client attached to the task's existing detached
named session. This disposable viewer attachment SHALL be distinct from the task
owner/recorder PTY. A viewer attachment SHALL operate in attach-only mode: it SHALL
never create the named tmux session, launch an agent, or fall back from attach to
launch. Each browser reconnect SHALL discard its previous attachment and create a new
one, reset the browser xterm, and restore the current screen from tmux's fresh-client
redraw rather than from CAP terminal history.

One browser WebSocket SHALL own at most one immutable viewer attachment. Reattaching
SHALL close that WebSocket and use the existing reconnect mechanism to create a new
WebSocket and provider PTY, so raw sequence and ACK state are connection-scoped rather
than durable or shared. The gateway and provider transport SHALL still fence
asynchronous open/close callbacks with an internal generation or cancellation signal;
output and cleanup from a superseded connection SHALL be ignored. Closing a browser or
its viewer attachment SHALL close only that outer provider PTY and SHALL NOT kill the
detached tmux session, the agent process, the task owner/recorder, or the sandbox.

`terminal_attach` SHALL carry both the CAP terminal protocol version and a terminal
response-profile id derived from the exact resolved xterm version, term name,
response-affecting options, and loaded parser-affecting addons. The Gateway SHALL reject
an unknown or incompatible protocol/profile with an explicit reload-required result
before opening a provider PTY. A dependency, option, or addon change SHALL use a new
profile and SHALL NOT silently retain the old response grammar.

At the synchronous acceptance point of the first valid `terminal_attach`, before any
task-owner decision, provider probe/open, or other awaited work, the Gateway SHALL
atomically transition the connection from unattached to attaching, reserve its
generation, and freeze a stable non-secret identity derived from the authenticated
principal together with `boundTaskId` and generation. It SHALL NOT retain a raw
credential as that identity. Concurrent or late authentication resolution SHALL be
fenced by an auth-attempt epoch or cancellation signal and SHALL NOT mutate the frozen
tuple. A later `connect_auth` MAY revalidate the same principal/task binding but SHALL
NOT retarget either an attaching or attached WebSocket to another principal or task.

Every client-to-server task-scoped action, including keystroke, resize, heartbeat,
takeover, decision, ACK, terminal-response, and future frame types, SHALL resolve only
against the frozen binding and current generation. Any task/session id carried by a
frame SHALL equal `boundTaskId`, and a decision SHALL also match the task of its pending
approval. A principal/task mismatch, second attach, late auth result, or stale generation
SHALL atomically close the generation, cancel pending work, and fail closed before
affecting any task or PTY. A late provider-open result SHALL be closed exactly and SHALL
NOT be adopted. An accepted attach consumes the socket's sole attach attempt even if
provider establishment later returns unavailable or failed; retry requires a new
WebSocket.

#### Scenario: First browser connection creates an independent viewer

- **WHEN** an authenticated operator opens a running interactive task whose detached
  tmux session exists
- **THEN** CAP opens a new provider PTY for that browser and attaches a new tmux client
  to the existing session
- **AND** the task owner/recorder PTY remains a separate connection

#### Scenario: An incompatible terminal profile never opens a viewer

- **WHEN** a browser requests attach with a protocol version or response-profile id the
  Gateway does not support
- **THEN** CAP returns an explicit reload-required/protocol-mismatch result and closes or
  rejects that attach
- **AND** it does not open a provider PTY, create query state, or present a blank terminal

#### Scenario: Reconnect restores a quiet full-screen TUI without waiting for new output

- **WHEN** a browser disconnects and reconnects while the agent's full-screen TUI is
  static
- **THEN** CAP creates a different provider PTY and tmux client for the new browser
  connection
- **AND** tmux's initial redraw alone restores a non-empty current screen
- **AND** the operator does not need to type or wait for a later agent update before
  the screen appears

#### Scenario: Missing detached session never triggers viewer-side launch

- **WHEN** a browser requests a viewer attachment but the exact detached tmux session
  is absent
- **THEN** CAP returns an attachment-unavailable control result
- **AND** it does not create a tmux session or launch a second agent

#### Scenario: Viewer disconnect is non-destructive

- **WHEN** the last browser viewer disconnects from a running task
- **THEN** CAP closes that viewer's provider PTY
- **AND** the detached tmux session, task owner/recorder, agent process, and sandbox
  continue running

#### Scenario: Superseded connection events are fenced

- **WHEN** output, input, resize, ACK, or close events arrive from an old WebSocket or
  an asynchronously cancelled provider open after the browser has reconnected
- **THEN** CAP ignores the stale events
- **AND** they cannot affect the new WebSocket attachment or the task's authoritative terminal
  state

#### Scenario: An attached WebSocket cannot be retargeted to another task

- **WHEN** a WebSocket attached to task A sends a later `connect_auth`, second attach, or
  any task-scoped frame claiming task B, including input, resize, heartbeat, takeover,
  decision, ACK, or terminal-response
- **THEN** CAP atomically closes the attachment generation and WebSocket and disposes
  task A's viewer
  attachment
- **AND** the frame affects neither task A's pane nor task B's session, lease, geometry,
  query queue, or recording

#### Scenario: A pending attachment cannot be retargeted during provider open

- **WHEN** the Gateway has synchronously accepted an attach for task A and its owner
  decision, provider probe, or provider open is still pending
- **AND** the same WebSocket sends `connect_auth` or another attach claiming task B, or
  an older authentication attempt resolves after the attach was accepted
- **THEN** CAP atomically closes the already frozen task A generation and WebSocket
- **AND** no provider PTY, query state, lease, geometry, activity heartbeat, approval
  decision, or recording is created or changed for task B
- **AND** any late provider result for the cancelled task A generation is closed exactly

### Requirement: The live path preserves native terminal protocol bytes

Interactive Codex and Claude Code SHALL run in their default terminal mode. CAP SHALL
pass the provider viewer PTY's live byte stream to the browser xterm without removing,
rewriting, or synthesizing alternate-screen, cursor, erase, scroll-region, style,
mouse, focus, bracketed-paste, or terminal-query sequences. In particular, the live
path SHALL NOT strip `?1049`, `?1047`, or `?47` enter/exit sequences and SHALL NOT
force the agent into an inline or normal-buffer mode for the purpose of browser
scrollback.

Every tmux attach byte that arrives, including alternate-screen enter, clear, cursor
state, and current-screen redraw bytes, SHALL be fed in order to the new xterm. CAP MAY
keep the xterm visually concealed until attach establishment, the first output burst, a
bounded quiet/deadline settle heuristic, and an xterm write flush have completed. The
resulting attachment-ready control frame is a presentation threshold, not proof that a
continuously repainting TUI has reached a protocol-level frame boundary; tmux exposes no
such boundary. Later raw bytes SHALL continue updating the revealed xterm. CAP SHALL NOT
discard bootstrap bytes. Running-terminal scrollback across refresh, reconnect, devices,
or API restart is explicitly not guaranteed.

#### Scenario: Native alternate-screen bytes reach xterm unchanged

- **WHEN** a live viewer PTY emits alternate-screen enter/exit and cursor-addressed
  full-screen redraw bytes
- **THEN** the browser xterm receives those bytes in their original order and value
- **AND** neither the gateway nor the live front-end strips or rewrites them

#### Scenario: A quiet attach bootstrap settles before the terminal is revealed

- **WHEN** a fresh tmux client emits shell bootstrap bytes followed by alternate-screen
  enter, clear, and the current full-screen frame
- **THEN** the browser feeds every received byte in the sequence to its reset xterm
- **AND** if visual concealment is used, the xterm is revealed after the bounded settle
  heuristic and xterm flush; the quiet-frame conformance gate verifies that the canonical
  current screen is complete at that point
- **AND** no bootstrap suppression may remove the only current-screen redraw

#### Scenario: Continuously repainting attach reaches bounded ready without dropping bytes

- **WHEN** a fresh attachment keeps emitting native redraw bytes without a quiet period
- **THEN** CAP emits ready no later than the configured maximum settle deadline rather
  than hiding the terminal forever
- **AND** ready does not claim an atomic frame boundary; bytes arriving before and after
  reveal remain ordered and continue converging the xterm to the live TUI

#### Scenario: Live reconnect does not synthesize historical scrollback

- **WHEN** a task produced more terminal output than fits in its current tmux screen
  before a browser reconnects
- **THEN** the fresh viewer restores the current screen and future live output only
- **AND** CAP does not replay `session.log`, `session.cast`, or a headless snapshot into
  the live xterm to reconstruct prior scrollback

### Requirement: Terminal protocol responses return to the originating viewer attachment

CAP SHALL define a versioned terminal-response profile for the production shared
Terminal wrapper. The profile SHALL bind the exact resolved `@xterm/xterm` version,
termName, `disableStdin`, `windowOptions`, and response-affecting addons to the complete
set of automatic `onData` query/response grammars. Read-only viewers SHALL keep
`disableStdin=false`; Gateway authorization, not suppression of xterm input processing,
SHALL enforce read-only behavior. For the pinned xterm.js 5.5.0 browser profile, the
correlated path SHALL cover primary/secondary DA, DSR status, normal/private CPR,
ANSI/private DECRQM, DECRQSS, and OSC 4/10/11/12 color reports. CSI 14/16/18 window
reports SHALL be included if and only if the corresponding `windowOptions` are enabled.
A change to the exact version, response-affecting options, or addons SHALL require a new
profile and passing source-conformance matrix before release.

The browser SHALL distinguish profile-generated terminal responses from human
keystrokes and paste. The Gateway SHALL use a side-effect-free incremental parser to
observe each attachment's outbound PTY stream for every active-profile query, including
arbitrary byte fragmentation, 7-bit ESC and transport-reachable C1/UTF-8 forms, and
CSI/OSC/DCS sequences with BEL or ST termination as applicable, while forwarding every
provider byte unchanged and in order whether or not the parser recognizes it. The parser
SHALL have hard maximum sequence, carry, and string-payload lengths; malformed,
unterminated, nested, or overlong prefixes SHALL reset parser state without altering the
raw stream, allocating unbounded memory, or recognizing query-looking bytes inside an
unrelated OSC/DCS payload. Attachment close/replacement SHALL atomically mark its
generation closed before clearing parser carry and query state.

The Gateway SHALL maintain a bounded attachment-local FIFO queue of outstanding query
class/parameters. Query TTL SHALL have a secure default and hard maximum; a non-finite,
non-positive, or over-maximum configuration SHALL fail native-terminal activation rather
than enlarge the authorization window. TTL SHALL begin at successful enqueue using a
monotonic clock; a token is live only while `now < expiresAt`, and `now >= expiresAt`
SHALL be expired. CAP SHALL prune expired tokens before response matching and before a
capacity check. Only if the post-prune queue remains full SHALL CAP keep all existing
live tokens, create no authorization for the new query, forward its raw bytes unchanged,
and emit an observable diagnostic. A query that the active profile does not answer SHALL
create no authorization. Each control frame SHALL contain exactly one atomic
active-profile response and SHALL route only to the provider PTY attachment whose output
caused the matching query.

The Gateway SHALL accept a `terminal_response` without write-lease ownership only when
its class matches one live outstanding query for that same attachment and generation and
its parameters are valid for the query. The finite mapping SHALL preserve every dynamic
query parameter required by the active profile: DA grammar and parameters SHALL match
the exact profile; DSR status (`CSI 5 n`) SHALL map only to exact ready status
(`CSI 0 n`); normal/private CPR SHALL NOT be interchanged and coordinates SHALL be
1-based with `1 <= row <= rows` and `1 <= column <= columns`; ANSI/private DECRQM SHALL
retain its prefix and requested mode and restrict the returned status domain; DECRQSS
SHALL match its requested subtype and positive/negative response grammar; OSC color
reports SHALL match their OSC command plus color index/slot, with each response from a
stacked query correlated independently. Enabled window reports SHALL match their
requested report kind: CSI 18 character-size reports SHALL equal the authoritative
rows/columns, while CSI 14/16 text-area/cell pixel reports are attachment-local renderer
measurements and SHALL contain only positive integers within profile hard bounds; CAP
SHALL NOT pretend it has server-authoritative CSS pixel values. When multiple queries of
one class are live, the oldest matching query SHALL be selected even when other classes
precede it. The matching query or tokens for a stacked query SHALL be enqueued before the
final raw byte that can trigger xterm's response is eligible for WebSocket delivery.
After all validation succeeds, CAP SHALL atomically consume it before the provider write;
concurrent duplicate frames can consume it only once, and a downstream write failure
SHALL NOT restore the authorization token. Validate, consume, and write SHALL remain
bound to the same live attachment generation; attachment close, replacement, auth
failure, or task unregister SHALL prevent any later write to the old PTY. The attachment
SHALL surface or close on write failure and wait for a new provider query rather than
replaying the response.

The browser MAY use the lease-independent response path only when an entire xterm
`onData` burst can be unambiguously and losslessly tokenized as one or more complete
active-profile responses with no prefix, suffix, or interstitial remainder; it SHALL emit
one atomic `terminal_response` frame per token in order. If any human input, unknown
byte, incomplete sequence, or other ambiguity is present, the browser SHALL NOT extract
an allowlisted substring. It SHALL preserve the complete original burst on the
lease-gated keystroke path, or drop it when the viewer lacks the lease. For an authorized
writer's mixed burst, the Gateway SHALL use any unambiguously embedded matching response
only for same-generation query accounting, atomically consuming it before the one
byte-for-byte keystroke write; this accounting SHALL NOT authorize a frame without the
write lease.

Grammar, base64, length, and rate validation alone SHALL NOT authorize a response. An
unmatched, replayed, expired, cross-attachment/task/generation, malformed, oversized, or
over-rate frame SHALL fail closed. Human keys, paste, mouse, and focus data SHALL continue
to require the task's write lease.

#### Scenario: The production Terminal wrapper matches its response profile

- **WHEN** source conformance injects every finite grammar/subtype in the active profile,
  plus boundary and equivalence-class representatives for parameterized and unknown
  values, through the same shared Terminal wrapper, xterm options, and addons used by the
  live page
- **THEN** DA, DSR/CPR, ANSI/private DECRQM, DECRQSS, and OSC color behavior exactly
  matches the profile, including supported negative responses, stacked responses,
  terminators, dynamic parameters, and 7-bit/C1 forms
- **AND** disabled window reports produce no response, while an isolated enabled-options
  profile covers every newly enabled response

#### Scenario: Response-affecting dependency drift invalidates the old profile

- **WHEN** the exact resolved xterm version, termName, `disableStdin`, `windowOptions`, or
  a response-affecting addon changes
- **THEN** build/release conformance requires a new matching response profile
- **AND** the browser and Gateway cannot negotiate the stale profile merely because its
  package declaration or wire protocol version stayed unchanged

#### Scenario: Read-only viewer answers its own terminal query

- **WHEN** tmux sends a supported terminal query through a read-only viewer attachment,
  the Gateway records it as outstanding, and that viewer's xterm produces the matching
  response before its TTL expires
- **THEN** the browser sends a `terminal_response` frame scoped to that attachment
- **AND** CAP writes it to that viewer PTY even though the viewer does not hold the
  task write lease

#### Scenario: Human input remains lease-gated

- **WHEN** a viewer without the write lease produces keyboard or paste input that is
  not a terminal protocol response
- **THEN** CAP does not forward that input to the tmux pane
- **AND** only the current write-lease holder may inject human input

#### Scenario: A response-only multi-token burst is split without reordering

- **WHEN** one xterm `onData` burst consists entirely of two or more complete supported
  responses and the same attachment has a live matching query for each response
- **THEN** the browser emits one atomic `terminal_response` frame per response in source
  order
- **AND** CAP correlates and consumes each query independently without combining multiple
  responses into one control frame

#### Scenario: Mixed or ambiguous onData cannot bypass the write lease

- **WHEN** one xterm `onData` burst contains an allowlisted response together with a key,
  paste, mouse/focus byte, unknown byte, incomplete sequence, or trailing remainder
- **THEN** the browser does not extract or send the allowlisted substring as a
  `terminal_response`
- **AND** the complete original burst follows the human-input path and is rejected for a
  read-only viewer
- **AND** if the sender owns the write lease, CAP forwards the burst byte-for-byte and
  consumes any unambiguously matched response token only for same-generation accounting

#### Scenario: A syntactically valid response without an outstanding query is rejected

- **WHEN** a browser sends a syntactically valid allowlisted `terminal_response` but the
  same attachment has no matching unconsumed, unexpired outstanding query
- **THEN** CAP rejects or drops that payload without writing it to any PTY
- **AND** the sender cannot use the lease-independent response path to inject human
  input

#### Scenario: A terminal response cannot be replayed or crossed between viewers

- **WHEN** a response has consumed its matching query, or a viewer submits a response
  matching only another attachment's outstanding query
- **THEN** CAP rejects the replayed or cross-attachment frame
- **AND** closing or replacing a viewer clears every outstanding query for the old PTY

#### Scenario: Malformed or resource-exhausting terminal responses fail closed

- **WHEN** a browser sends a `terminal_response` payload that is too large, too
  frequent, malformed, or outside the allowlisted terminal-query response grammar
- **THEN** CAP rejects or drops that payload without writing it to any PTY
- **AND** the outstanding-query queue remains bounded and cannot be used for unbounded
  memory growth

#### Scenario: A full query queue does not evict an existing authorization

- **WHEN** an attachment's outstanding-query queue is at its hard capacity and another
  supported query arrives
- **THEN** CAP forwards the provider query bytes unchanged but creates no authorization
  for the new query and emits a diagnostic
- **AND** it neither grows the queue nor evicts an older live token to admit the new one

#### Scenario: Expired query tokens release queue capacity

- **WHEN** a token was enqueued with `expiresAt`, the monotonic clock reaches
  `now >= expiresAt`, and a response match or new-query capacity check occurs
- **THEN** CAP prunes that expired token before matching or deciding the queue is full
- **AND** the expired token cannot authorize a response and its slot may admit a new query

#### Scenario: Fragmented or endless query prefixes have bounded parser state

- **WHEN** a provider query is split at every byte boundary, or emits an unterminated or
  overlong ESC/CSI prefix
- **THEN** a valid bounded query is recognized exactly once after completion
- **AND** malformed/overlong carry is discarded and reset within the hard bound without
  allocating unbounded memory or creating an outstanding authorization

#### Scenario: Concurrent duplicate responses and provider write failure remain single-use

- **WHEN** two identical response frames race for one outstanding query, or the provider
  write fails after the response has been authorized
- **THEN** at most one frame atomically consumes the query before any provider write
- **AND** the query is not restored after failure; a retry requires a new observed query

#### Scenario: Attachment close fences an in-flight response write

- **WHEN** close, replacement, authentication failure, or task unregister races a
  terminal response before or after validation or query consumption
- **THEN** CAP first marks the attachment generation closed and clears its parser/query
  state
- **AND** no continuation from that response writes to the closed or superseded PTY

#### Scenario: Task-owner synthetic responses never leak into a viewer

- **WHEN** the task owner uses a startup-only synthetic CPR or other compatibility
  response
- **THEN** that response remains confined to the task-owner startup bridge
- **AND** CAP does not inject it into any browser viewer attachment or duplicate the
  response generated by the browser xterm

### Requirement: Browser terminal input is byte-preserving and lease-gated

The production shared Terminal wrapper SHALL subscribe to both xterm `onData` and
`onBinary`. It SHALL UTF-8 encode an `onData` JS string, convert each `onBinary` binary
string code unit to its original low 8 bits, and base64-encode the resulting explicit
bytes without applying UTF-8 to the binary event. The Gateway SHALL
decode that payload as bytes, not via UTF-8 replacement text, and the provider-neutral
viewer attachment plus each provider transport SHALL write those same bytes to the outer
PTY. Input bytes SHALL NOT enter bounded owner evidence or an opt-in raw artifact.

`onBinary` mouse reports, `onData` mouse/focus reports, keyboard, and paste are human
interaction and SHALL require the current write lease plus the frozen attachment
binding; they SHALL never use `terminal_response`. A provider SHALL NOT advertise or
default-enable native interactive terminal capability unless real conformance proves its
native protocol preserves the full byte range required by xterm mouse reporting.

#### Scenario: Legacy mouse bytes reach the provider PTY unchanged

- **WHEN** xterm emits a non-UTF-8 legacy/default mouse report through `onBinary` for the
  current write-lease holder
- **THEN** the browser, Gateway, viewer attachment, and provider transport preserve every
  byte exactly, including values above `0x7f`
- **AND** the target viewer PTY receives one report with no UTF-8 expansion, replacement,
  or duplicate write

#### Scenario: Read-only binary mouse input remains blocked

- **WHEN** a viewer without the write lease emits an `onBinary` mouse report
- **THEN** CAP rejects or drops it without writing any byte to that viewer PTY
- **AND** the binary path cannot be relabeled as a terminal response to bypass the lease

#### Scenario: A provider without opaque-byte input cannot claim native fidelity

- **WHEN** a real AIO or BoxLite byte-oracle fixture shows that its terminal protocol
  rewrites, replaces, or cannot carry a required xterm input byte
- **THEN** that provider fails terminal conformance and native-default release
- **AND** CAP does not hide the failure by converting the payload through a UTF-8 string

### Requirement: Fresh viewer attachment remains aligned after API readoption

API startup readoption SHALL restore and attest the task owner/classifier in strict
attach-only mode before the task is committed as re-adopted. It SHALL NOT pre-create or
retain browser viewer attachments. After successful readoption, each browser SHALL
open its own fresh attach-only provider PTY to the same surviving detached tmux
session. Viewer attach redraw bytes SHALL remain presentation-only and SHALL never enter
bounded owner evidence, classification, or an optional raw artifact. Owner readoption
bytes received during the bounded settle window SHALL be producer-ineligible. Because
the owner is API-resident and tmux has no reliable attach-bootstrap end marker, real
agent output during API/owner outage or the settle window MAY be missing from evidence
and classification. CAP SHALL NOT synthesize continuity from a viewer/current redraw.

#### Scenario: Readoption restores the owner without creating viewers

- **WHEN** CAP restarts and provider liveness proves that a task's detached tmux
  session still exists
- **THEN** readoption restores the task owner/classifier in attach-only mode
- **AND** no browser viewer PTY is created until an authenticated browser requests one

#### Scenario: Browser reconnect after readoption receives the current screen

- **WHEN** an operator reconnects after the task owner has been re-adopted
- **THEN** CAP opens a new provider PTY and attaches a new tmux client to the surviving
  session
- **AND** the current screen is restored by the new tmux client's complete redraw
- **AND** no pre-restart `session.log` or snapshot tail is replayed into the live xterm

#### Scenario: Indeterminate or absent readoption never launches

- **WHEN** readoption cannot prove the exact detached session exists, or proves it is
  absent
- **THEN** the attach-only decision remains indeterminate or absent according to the
  existing readoption contract
- **AND** neither the owner recovery path nor a later viewer attach launches an agent
  as a fallback

#### Scenario: Readoption uses a bounded suppression window while viewers never record

- **WHEN** owner readoption and one or more viewer fresh attaches emit command echo,
  tmux bootstrap, or current-screen repaint bytes
- **THEN** every viewer byte remains presentation-only and never enters bounded owner
  evidence or either opt-in artifact, and owner bytes inside the settle window are
  suppressed
- **AND** eligible owner bytes after the deadline again drive activity/classification
  even when both raw artifacts remain disabled

### Requirement: Native agent terminals pass the real-provider release gate

The native live-terminal path SHALL NOT become the default until real interactive
Codex and Claude Code sessions pass the supported AIO and BoxLite provider gates in
their default terminal modes. The gate SHALL exercise actual CLI full-screen redraws,
not only a deterministic fixture, and SHALL cover long-running/high-frequency output,
a quiet current frame, keyboard, paste, mouse/focus modes actually negotiated by the
CLI, writer resize, network reconnect, full browser disconnect and reconnect, API
restart/readoption, explicit owner-evidence gaps, default raw-off capacity safety, and
cleanup. At
matching geometry, Playwright SHALL compare an
uninterrupted xterm with a fresh-attach xterm using both canonical screen state and an
unmasked non-empty screenshot. The gate SHALL inventory the terminal queries actually
observed from each pinned Codex/Claude/tmux/provider/browser combination and classify
every query against the pinned xterm behavior. Each observed class SHALL either be
inside the finite implemented mapping and receive a correlated response from a read-only
viewer, or have captured evidence that xterm produces no data response and that omission
does not affect screen state or CLI control flow. If xterm produces a response outside
the implemented mapping, or the effect of omission is indeterminate, CAP SHALL block
native-default enablement until the contract, mapping, and tests cover it. Runtime
fail-closed rejection with an observable diagnostic is the safety fallback and SHALL NOT
by itself count as a passing release gate.

Before those real-runtime stories, a browser source-conformance gate SHALL exercise the
production shared Terminal wrapper against every finite query grammar/subtype in the
negotiated profile plus boundary/equivalence-class representatives, and fail on any
exact-version/options/addons fingerprint drift. Real-provider gates SHALL
capture the query inventory, browser-generated response inventory, and provider-PTY
write inventory for the same attachment. They SHALL also exercise both UTF-8-safe modern
mouse reports from `onData` and non-UTF-8 legacy/default mouse reports from `onBinary`
through a byte oracle. A missing, duplicated, rewritten, cross-attachment, or unsupported
response-producing class or binary input byte SHALL block default enablement.

#### Scenario: Real Codex and Claude Code restore a quiet native frame

- **WHEN** a real Codex or Claude Code task is idle on a non-empty native full-screen
  frame and every browser viewer is disconnected
- **THEN** a fresh browser/provider PTY restores the complete current frame without
  requiring keyboard input or later agent output
- **AND** alternate-buffer selection, cursor, style, wide UTF-8 cells, and visible rows
  match the uninterrupted terminal at the same geometry

#### Scenario: Long native output does not turn reconnect into history replay

- **WHEN** a real native TUI has produced sustained output and redraw volume far beyond
  one visible screen before reconnect
- **THEN** fresh attach remains bounded to current-screen initialization plus protocol
  overhead and does not prepend the historical output stream
- **AND** subsequent live output continues once per viewer without pausing the owner or
  another viewer

#### Scenario: Real-provider Playwright evidence is non-empty and equivalent

- **WHEN** the enabled AIO and BoxLite gates compare uninterrupted and freshly attached
  browser xterms for each supported interactive runtime at identical geometry
- **THEN** both screenshots are non-blank and their normalized visible terminal state
  is equivalent
- **AND** the gate fails on a blank, partial, stale, historically prefixed, or
  provider-reused terminal

#### Scenario: API restart preserves the real agent and resumes one owner authority

- **WHEN** the API restarts during a real Codex or Claude Code interactive run
- **THEN** the detached agent session remains the same process/session, readoption
  restores exactly one owner/classifier, and a later viewer uses a fresh PTY
- **AND** exactly one owner resumes activity/classification after its bounded
  producer-ineligible settle window without viewer-redraw contamination
- **AND** the gate reports owner-absent and settle durations, labels missing real-CLI
  byte count unknown without an independent oracle, uses sequence-marked fixtures for
  exact missing-event/byte counts, and proves all temporary viewer/provider resources
  cleaned

#### Scenario: An unobserved agent exit during API downtime fails honestly

- **WHEN** a real or deterministic run ends its detached session while the API owner is
  unavailable and no durable exit evidence exists at boot
- **THEN** readoption reports the explicit unobserved-exit/orphan failure outcome and
  never launches a replacement agent
- **AND** bounded evidence and any opted-in raw artifact may end before the process did
  and are not presented as proof of natural successful completion

#### Scenario: Real terminal-query negotiation works for a read-only viewer

- **WHEN** a real pinned Codex or Claude Code session and tmux send DA, DSR/CPR, or other
  observed terminal queries through a viewer that does not hold the write lease
- **THEN** every supported query is recorded in the query inventory and completed by one
  correlated xterm response on that viewer PTY
- **AND** unsolicited, replayed, expired, cross-viewer, and unsupported responses are
  rejected without granting human-input authority
- **AND** any observed query that makes pinned xterm generate an unmapped data response,
  or whose missing-response effect is unknown, blocks native-default release rather than
  passing only because runtime rejection was fail closed

#### Scenario: Real mouse protocols preserve both xterm input channels

- **WHEN** the real provider gate negotiates an SGR mouse mode and separately exercises a
  legacy/default mode that xterm emits through `onBinary`
- **THEN** the current writer's `onData` and `onBinary` reports each reach the same viewer
  PTY once with exact bytes
- **AND** the read-only viewer's equivalent reports are rejected and no provider passes
  by silently converting high bytes through UTF-8
