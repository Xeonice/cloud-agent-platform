## ADDED Requirements

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

## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Readoption attach does not record bootstrap output as task history

**Reason**: The old requirement treats one durable raw terminal history as the source
of reconnect truth. Native live reconnect now uses a fresh attach-only viewer PTY,
while bounded owner evidence and each optional raw artifact have separate eligibility
and retention rules.

**Migration**: Exclude owner attach bootstrap from bounded evidence, runtime
classification, and every explicitly enabled raw artifact during the bounded settle
window. Keep all browser viewer bytes presentation-only, then resume classification and
bounded evidence from later eligible owner output without replaying viewer redraws or
the tmux current screen.
