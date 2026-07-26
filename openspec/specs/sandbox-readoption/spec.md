# sandbox-readoption Specification

## Purpose
A running task survives an api restart/redeploy: codex runs in a detached named tmux session that outlives the orchestrator's terminal WebSocket, the api re-adopts still-running sandboxes on boot (re-attach + rebuild guardrail/slot state) instead of reaping and failing them, task termination is detected by codex/tmux liveness rather than WS-close, api shutdown does not tear down sandboxes, and concurrent attach is single-writer. (created by archiving change survive-api-redeploy)
## Requirements
### Requirement: Codex launches in a detached named tmux session that outlives the terminal WebSocket
The system SHALL launch codex inside a DETACHED, NAMED tmux session (`tmux new-session -d -s task<taskId> -c /home/gem/workspace '<codex launch line>'`) sent over the `/v1/shell/ws` terminal channel, so codex becomes a child of the container's tmux daemon rather than a foreground child of the WS-spawned shell, and therefore KEEPS RUNNING when that WebSocket closes. This wraps (does not replace) the existing in-shell launch + prompt-injection contract: the prompt file, positional `"$(cat …)"` argument, hook-disabling guard, and DSR-gated auto-submit all still apply WITHIN the detached session.

#### Scenario: Codex is launched detached and survives a WS close
- **WHEN** a task begins execution
- **THEN** codex is started inside a detached named tmux session `task<taskId>` over the terminal channel
- **AND** when the orchestrator's `/v1/shell/ws` connection to that sandbox subsequently closes, the codex process and its tool children KEEP RUNNING inside the detached session (they are not reaped with the WS-spawned shell)

#### Scenario: The detached session preserves the existing prompt-injection behavior
- **WHEN** codex is launched in the detached named session for a task with a non-empty prompt
- **THEN** the operator prompt is still injected as a shell-safe file and passed positionally, and the DSR-gated single-carriage-return auto-submit still begins the run with zero operator keystrokes

### Requirement: Opening a task session attaches to the live named session with a fresh-session fallback

The system SHALL distinguish the task-level owner/supervisor terminal from
disposable operator viewer terminals when opening a task session. A newly admitted
task owner that still holds explicit launch authority MAY create the detached
`task<taskId>` tmux session only after the named session is definitively absent.
An owner opened for boot readoption and every browser viewer SHALL use attach-only
semantics: they SHALL attach to the existing exact named session and SHALL NOT fall
back to `tmux new-session` when the target is absent, dead, or indeterminate. Every
browser connect or reconnect SHALL obtain a fresh provider PTY identity and attach
that PTY to the existing session rather than sharing the owner's provider transport.

#### Scenario: Reconnect attaches to a still-running session

- **WHEN** a session is opened for a task whose named tmux session `task<taskId>` is still alive
- **THEN** the orchestrator attaches to that existing session and streams its live output, rather than launching a new codex

#### Scenario: Dead session falls back to fresh launch

- **WHEN** a newly admitted task owner still holds launch authority and definitively proves that the named tmux session is absent
- **THEN** the orchestrator creates the task's fresh detached named session, preserving first-launch behavior
- **AND** this fallback is not available to a readoption owner or browser viewer

#### Scenario: Attach-only open never launches a replacement agent

- **WHEN** a readoption owner or browser viewer attempts to attach and the named session is absent, dead, or cannot be proved alive
- **THEN** the attach settles as unavailable or indeterminate
- **AND** CAP does not launch a replacement agent or create a second detached task session

#### Scenario: Each browser open uses a fresh provider PTY

- **WHEN** two browsers connect or the same browser reconnects to one live task
- **THEN** each connection receives a distinct disposable provider PTY attached to the same exact named tmux session
- **AND** neither browser consumes the owner/supervisor PTY as its live display stream

### Requirement: A running task survives an api restart or redeploy

The system SHALL preserve an in-flight task across an api process
restart/redeploy: because the agent runs in a detached session that outlives every
API-to-provider terminal transport, the sandbox keeps executing while the api is
down. On boot the new api SHALL re-adopt the task by opening an attach-only
owner/supervisor against the existing named session, rebuilding guardrail and slot
state, and keeping the task in its `running`/`awaiting_input` state rather than
transitioning it to `failed`. An operator WebSocket that reconnects after the api
restart SHALL receive a fresh disposable provider PTY and the tmux current-screen
redraw plus subsequent live output; live recovery SHALL NOT depend on a CAP
headless snapshot, `session.log` tail replay, or retained browser scrollback.

#### Scenario: Redeploy does not fail a running task

- **WHEN** the api is redeployed/restarted while a task is `running` and its detached agent session is alive
- **THEN** the task remains `running` after the new api boots (it is NOT force-failed), the agent continued executing throughout, and the task proceeds to its natural terminal state
- **AND** boot readoption attaches to the existing session without exercising a fresh-launch fallback

#### Scenario: Operator terminal resumes after the api restart

- **WHEN** the api restarts while an operator is viewing a running task's terminal
- **THEN** the operator's WebSocket auto-reconnects and CAP opens a new disposable provider PTY
- **AND** that PTY attaches to the re-adopted named session and delivers its complete current screen followed by new live output without a page reload
- **AND** CAP does not restore the live screen from `session.log` snapshot/tail replay

#### Scenario: API restart releases stale viewer attachments

- **WHEN** the old api process exits with browser viewer attachments open
- **THEN** loss or closure of those provider PTYs does not stop the detached session or agent
- **AND** the new api creates new viewer attachments instead of trying to reuse stale provider terminal identities

#### Scenario: Agent exit while the API is down is not reported as observed completion

- **WHEN** an agent's detached session ends while the API/owner is unavailable and boot
  readoption later proves the exact session absent without durable exit evidence
- **THEN** CAP follows the existing orphan-recovery failure path with an explicit
  unobserved-exit diagnostic instead of reporting a successful natural completion
- **AND** CAP does not relaunch the agent, fabricate missing terminal output, or attach a
  browser to a replacement session

### Requirement: API shutdown does not stop provisioned sandboxes
The system SHALL, on api shutdown (SIGTERM / `onModuleDestroy`), release in-memory sandbox handles WITHOUT stopping or tearing down the provisioned `cap-aio-*` containers, so the next api process can re-adopt the still-running sandboxes. Real task-teardown on a terminal task (stop-only retention, credential zeroing) is unchanged and still occurs on the normal teardown path.

#### Scenario: SIGTERM leaves running sandboxes alive
- **WHEN** the api receives SIGTERM while tasks are running
- **THEN** the api releases its in-memory handles and exits WITHOUT stopping those tasks' `cap-aio-*` containers, leaving the detached codex sessions running for the next process to re-adopt

#### Scenario: Normal terminal teardown is unaffected
- **WHEN** a task reaches a terminal state (not an api shutdown)
- **THEN** the existing stop-only retention teardown (with pre-stop credential zeroing) still runs for that task's sandbox

### Requirement: Concurrent attach to a task session is single-writer

The system SHALL allow multiple operators to attach to the same task's named tmux
session through independent disposable provider PTYs, but SHALL permit only the
CAP write-lease holder to inject human keystrokes or paste into the agent pane.
Non-holders SHALL NOT inject human input. This includes both xterm `onData` keyboard,
paste, mouse/focus input and non-UTF-8 mouse reports emitted through `onBinary`; an
authorized input SHALL preserve opaque bytes through the selected provider rather than
round-tripping through UTF-8 text. Terminal protocol replies generated by a browser
terminal in response to a query in the negotiated response profile SHALL be routed only
to that browser's own provider PTY and SHALL remain distinct from lease-gated human
input. A lease-independent reply SHALL be accepted only when it matches one unconsumed,
unexpired outstanding query observed on that same attachment; syntax or profile
membership alone SHALL NOT grant write authority.

The current write-lease holder SHALL be the sole authority for the tmux window
geometry. CAP SHALL keep the owner and viewer outer PTYs aligned to that authoritative
grid; a non-holder's local viewport change SHALL NOT choose a different outer-PTY size,
resize the shared tmux window, or affect another viewer. On a confirmed lease transfer,
the new holder's current desired geometry SHALL become authoritative exactly once and
SHALL then be distributed to the owner and all viewers.

#### Scenario: Only the lease holder writes to a shared attached session

- **WHEN** two operators are attached to the same task's named tmux session and one holds the write lease
- **THEN** both see the live output, but only the lease holder's human keystrokes are injected into the session and the non-holder's human input is suppressed

#### Scenario: Binary mouse input follows the same single-writer authority

- **WHEN** xterm emits a legacy/default mouse report through `onBinary` for both the
  writer and a read-only viewer
- **THEN** only the writer's opaque bytes reach its provider PTY, without UTF-8 rewriting
- **AND** the reader's bytes are rejected rather than treated as a query response

#### Scenario: A read-only viewer can answer its own terminal query

- **WHEN** tmux sends a supported terminal query to a viewer that does not hold the
  write lease and the matching attachment-local query remains unconsumed and unexpired
- **THEN** the browser terminal's validated protocol reply is returned to that viewer's own provider PTY
- **AND** the reply is not broadcast, recorded as agent output, or treated as authority to send arbitrary human input

#### Scenario: Viewer resize does not reflow the shared session

- **WHEN** a non-writer viewer changes browser size
- **THEN** CAP keeps that viewer on the current authoritative terminal grid
- **AND** it does not resize the tmux window or cause the owner and other viewers to reflow

#### Scenario: Writer takeover transfers geometry authority

- **WHEN** the write lease is transferred to another attached viewer
- **THEN** CAP applies the new holder's current rows and columns as the authoritative tmux window geometry
- **AND** later resize events from the former holder cannot change that geometry

### Requirement: Readoption routes through the owning provider

The system SHALL re-adopt running tasks through the provider that owns their sandbox. When durable provider owner metadata exists, readoption SHALL use that provider first; when it does not exist, the system MAY probe compatible providers but SHALL only adopt a task after a provider proves the sandbox and detached session are alive.

#### Scenario: Stored owner drives readoption
- **WHEN** the API restarts and a running task has provider owner metadata for BoxLite
- **THEN** readoption asks the BoxLite provider to reattach that task's sandbox and detached session
- **AND** it does not attempt to reattach the task through AIO first

#### Scenario: Provider must prove session liveness
- **WHEN** a provider claims a running task during readoption
- **THEN** it verifies the provider sandbox is alive and the detached task session is alive before the task is kept running

### Requirement: Detached session semantics are provider-neutral

Interactive runtimes SHALL continue to run inside a detached named session that outlives the API-to-provider terminal transport. The initial implementation MAY use tmux for both AIO and BoxLite, but callers SHALL depend on a detached-session driver rather than AIO-specific shell commands.

#### Scenario: Transport close does not stop the agent
- **WHEN** the API-to-BoxLite terminal transport closes while the detached task session is alive
- **THEN** the agent process keeps running inside the provider sandbox

#### Scenario: Reconnect attaches to the existing session
- **WHEN** an operator reconnects to a BoxLite-backed task whose detached session is alive
- **THEN** CAP attaches to that existing session rather than launching a new agent process

### Requirement: Concurrent attach remains single-writer for every provider

Multiple operators MAY view the same provider-backed task session, but only the CAP write-lease holder SHALL inject input. Provider-native terminal sharing or attach behavior SHALL NOT bypass CAP's write-lock.

#### Scenario: BoxLite shared session is read-only for non-holders
- **WHEN** two operators are attached to a BoxLite-backed task and only one holds the write lease
- **THEN** both operators see output
- **AND** only the lease holder's input is forwarded to the provider transport

### Requirement: Boot recovery scan ownership is split between marker probe and tmux re-adoption

Boot recovery SHALL assign each recovering task to exactly one scan owner,
written down once: tasks parked or in pre-agent provisioning are owned by the
admission claim/processor path, which probes detached-job markers (alive keeps
the task parked, an exit marker settles the stage from its recorded code, an
unprovable job fails the attempt); tasks at agent-launch or later remain owned
by the existing tmux-session re-adoption scan, unchanged. The split SHALL NOT
depend on NestJS `onApplicationBootstrap` (or any framework hook) ordering
between providers: recovery SHALL be correct regardless of which scan runs
first, and a pre-agent sandbox with no tmux session SHALL never be treated as
a legacy orphan by the re-adoption scan.

#### Scenario: Parked task is recovered by the marker probe only

- **WHEN** the API boots while a task is parked behind a live detached transfer
- **THEN** the admission claim/processor path probes the markers and keeps the task parked
- **AND** the tmux re-adoption scan neither adopts nor fails that task

#### Scenario: Agent-phase task is recovered by tmux re-adoption only

- **WHEN** the API boots while a task is at agent-launch or later with a detached tmux session
- **THEN** the existing re-adoption scan recovers it exactly as before this change
- **AND** the marker probe does not settle or fail it

#### Scenario: Recovery is correct in either scan order

- **WHEN** the marker-probe recovery and the tmux re-adoption scan execute in either relative order at boot
- **THEN** every recovering task is handled by exactly one owner with the same outcome in both orders
- **AND** no pre-agent sandbox is reaped as a legacy orphan for lacking a tmux session

#### Scenario: Exited-while-down job settles from its marker

- **WHEN** the API boots after the detached clone finished (success or failure) during the downtime
- **THEN** the marker probe settles the transfer stage from the exit marker's recorded code and admission proceeds or fails accordingly
- **AND** success is never inferred from progress-file contents or silence

### Requirement: Provider center owns readoption routing

Readoption SHALL be coordinated by the provider center. It SHALL prefer durable provider owner metadata when present, and only use provider probing for older tasks without owner records or migration compatibility.

#### Scenario: Stored provider owner selects readoption provider
- **WHEN** a running task has durable owner metadata for a provider
- **THEN** the provider center asks that provider to reattach the task first
- **AND** it does not probe unrelated providers before the stored owner

#### Scenario: Probing fallback requires ownership proof
- **WHEN** a task lacks durable provider owner metadata
- **THEN** the provider center may probe compatible providers
- **AND** it only readopts through a provider that proves the provider sandbox and detached session are alive for that task

### Requirement: Provider e2e validates readoption without API restart

Provider-package e2e SHALL validate readoption by recreating provider and provider-center instances in-process rather than by restarting the CAP API backend.

#### Scenario: Provider instance restart readopts task sandbox
- **WHEN** provider e2e provisions a real sandbox and discards the provider instance
- **THEN** a new provider instance can reattach or prove ownership according to that provider's readoption contract
- **AND** selected-run operations continue through the readopted provider owner

### Requirement: Task ownership is separate from disposable viewer attachments

The system SHALL keep exactly one task-level terminal owner/supervisor for the
detached agent session and SHALL create a separate disposable viewer attachment
for each connected browser. The owner SHALL remain responsible for launch
authority, startup protocol handling, liveness and exit detection, activity,
runtime classification, bounded failure evidence, and the single canonical owner
output-eligibility stream. Optional bounded `session.log`/`session.cast` writers MAY
consume that stream only under their independent explicit opt-ins. A viewer attachment
SHALL only present and interact with the already-live session; it SHALL NOT launch an
agent, decide task liveness, classify output, or write durable terminal history.

#### Scenario: A task keeps running with no viewers

- **WHEN** every browser disconnects from a running task
- **THEN** each browser's disposable provider PTY is closed
- **AND** the task owner, detached session, agent process, liveness tracking, activity, and classification continue running

#### Scenario: Disconnecting one viewer is isolated

- **WHEN** one of several browsers viewing the same task disconnects
- **THEN** CAP closes only that browser's viewer attachment and clears only that viewer's flow-control state
- **AND** it does not close the task owner, stop the agent, transition the task, or interrupt any other viewer

#### Scenario: Terminal teardown closes owner and viewer resources

- **WHEN** the task reaches a terminal state and normal sandbox teardown begins
- **THEN** CAP closes the owner and every remaining disposable viewer attachment
- **AND** provider cleanup proves that no viewer terminal resource remains after the task sandbox is stopped or removed

### Requirement: Task owner transport is actively supervised without viewer input

While the API is running, each active task owner SHALL have one generation-fenced
supervisor that detects an unexpected established provider-PTY/transport close and
attempts recovery without waiting for browser presence or human input. Recovery SHALL
probe the exact detached task session and use bounded exponential backoff with jitter.
An alive result SHALL open one attach-only replacement owner; an indeterminate result
SHALL remain visibly degraded and retry only within the existing bounded liveness budget;
an absent result or exhausted liveness budget SHALL enter explicit unobserved-exit/orphan
failure reconciliation. No recovery branch SHALL launch an agent or create a detached
session. Owner outage and reattach settle duration SHALL be observable as bounded
failure-evidence/classification coverage gaps; raw artifacts may already be disabled.

#### Scenario: Owner transport redials without operator input

- **WHEN** an established owner transport closes unexpectedly while the exact detached
  tmux session is provably alive and no browser viewer is connected
- **THEN** the supervisor opens exactly one attach-only replacement owner after bounded
  backoff without waiting for a keystroke
- **AND** stale callbacks from the old generation cannot output, classify, append optional artifacts, close,
  or replace the new owner

#### Scenario: Owner redial never becomes a replacement launch

- **WHEN** the exact session probe is absent or indeterminate during owner recovery
- **THEN** CAP does not execute `tmux new-session` or any agent launch fallback
- **AND** indeterminate recovery remains degraded/retrying within the liveness budget,
  while absent or exhausted recovery follows the explicit failure reconciliation path

#### Scenario: Owner transport outage is an evidence coverage gap

- **WHEN** agent output occurs after the owner transport closes and before attach-only
  recovery completes
- **THEN** that output may be absent from bounded failure evidence, runtime classification,
  and any opted-in terminal artifact
- **AND** CAP records the outage/settle duration metric without claiming a missing-byte
  count unless a deterministic fixture provides an independent sequence oracle

### Requirement: Readoption bootstrap is excluded from bounded owner evidence

CAP SHALL, when it re-adopts a running task whose detached session is alive, use a
bounded owner-attach settle window to restore canonical observation. During that window
all owner bytes SHALL be producer-ineligible: they enter neither bounded failure
evidence/runtime classification nor an explicitly enabled raw artifact. Potential
bootstrap output includes shell command echo, duplicate-session messages, tmux attach
setup output, and the initial current-screen repaint emitted because CAP attached a new
provider terminal transport.

Every disposable browser attachment's output SHALL remain presentation-only for its
lifetime. After the owner settle window, later eligible owner output SHALL again update
activity, bounded evidence, and runtime classification regardless of raw recording
policy; an enabled artifact MAY consume it subject to its own limits. CAP SHALL NOT
conceal an owner outage/settle gap by using a viewer redraw or tmux current screen.

#### Scenario: Re-adopted alive session excludes bootstrap evidence

- **WHEN** the API restarts and re-adopts a running task whose detached session is alive
- **THEN** CAP attaches to the existing session rather than launching a second agent
- **AND** owner bytes inside the settle window enter neither failure evidence nor
  optional raw artifacts

#### Scenario: Later owner output remains classifiable with raw recording off

- **WHEN** CAP has completed owner attach settling and the live agent emits new output
- **THEN** activity and bounded failure evidence resume and the selected runtime can
  classify that output
- **AND** this behavior does not require `session.log` or `session.cast`

#### Scenario: API downtime and owner settling are an explicit evidence gap

- **WHEN** the agent emits output while the API owner is absent or while output is
  inseparable from owner attach bootstrap
- **THEN** that output may be absent from bounded evidence and classification
- **AND** CAP does not replay viewer or current-screen bytes as missing task output

#### Scenario: Operator still sees the re-adopted live frame

- **WHEN** an operator reconnects during or after owner attach bootstrap
- **THEN** its fresh viewer receives current-screen repaint and subsequent live bytes
- **AND** evidence suppression and default raw-off do not make the live frame blank

#### Scenario: Viewer redraw never contaminates owner evidence

- **WHEN** any number of browsers connect, reconnect, resize, or disconnect
- **THEN** their attach commands, redraws, resize repaints, and duplicate live bytes are
  excluded from bounded owner evidence and both opt-in artifacts
- **AND** default-off cast resize bookkeeping remains empty
