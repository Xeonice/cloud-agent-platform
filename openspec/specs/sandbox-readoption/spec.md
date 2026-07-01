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
The system SHALL, when opening a terminal session for a task, ATTACH to the existing `task<taskId>` tmux session (`tmux attach -t task<taskId>`) when that session is alive, and SHALL fall back to creating a fresh detached session ONLY when the named session is absent or dead. This is the mechanism by which a freshly-booted api re-attaches to a still-running codex and by which an operator reconnect rejoins the live run.

#### Scenario: Reconnect attaches to a still-running session
- **WHEN** a session is opened for a task whose named tmux session `task<taskId>` is still alive
- **THEN** the orchestrator attaches to that existing session and streams its live output, rather than launching a new codex

#### Scenario: Dead session falls back to fresh launch
- **WHEN** a session is opened for a task whose named tmux session is absent or dead
- **THEN** the orchestrator creates a fresh detached named session (it does not error), preserving first-launch behavior

### Requirement: A running task survives an api restart or redeploy
The system SHALL preserve an in-flight task across an api process restart/redeploy: because codex runs in a detached session (outliving the WS), the sandbox keeps executing while the api is down, and on the new api the task is re-adopted (re-attached and re-tracked) and KEPT in its `running`/`awaiting_input` state rather than transitioned to `failed`. The operator's terminal SHALL resume via the existing WebSocket auto-reconnect and snapshot/tail-replay, with no task loss.

#### Scenario: Redeploy does not fail a running task
- **WHEN** the api is redeployed/restarted while a task is `running` and its detached codex session is alive
- **THEN** the task remains `running` after the new api boots (it is NOT force-failed), codex continued executing throughout, and the task proceeds to its natural terminal state

#### Scenario: Operator terminal resumes after the api restart
- **WHEN** the api restarts while an operator is viewing a running task's terminal
- **THEN** the operator's WebSocket auto-reconnects and replays from `session.log`, resuming the live view of the (still-running) re-adopted session without a page reload

### Requirement: API shutdown does not stop provisioned sandboxes
The system SHALL, on api shutdown (SIGTERM / `onModuleDestroy`), release in-memory sandbox handles WITHOUT stopping or tearing down the provisioned `cap-aio-*` containers, so the next api process can re-adopt the still-running sandboxes. Real task-teardown on a terminal task (stop-only retention, credential zeroing) is unchanged and still occurs on the normal teardown path.

#### Scenario: SIGTERM leaves running sandboxes alive
- **WHEN** the api receives SIGTERM while tasks are running
- **THEN** the api releases its in-memory handles and exits WITHOUT stopping those tasks' `cap-aio-*` containers, leaving the detached codex sessions running for the next process to re-adopt

#### Scenario: Normal terminal teardown is unaffected
- **WHEN** a task reaches a terminal state (not an api shutdown)
- **THEN** the existing stop-only retention teardown (with pre-stop credential zeroing) still runs for that task's sandbox

### Requirement: Concurrent attach to a task session is single-writer
The system SHALL allow multiple operators to ATTACH to the same task's named tmux session as viewers, but SHALL permit only the write-lease holder (via the existing write-lock mechanism) to inject input; non-holders attached to the shared pane are read-only and SHALL NOT inject keystrokes.

#### Scenario: Only the lease holder writes to a shared attached session
- **WHEN** two operators are attached to the same task's named tmux session and one holds the write lease
- **THEN** both see the live output, but only the lease holder's keystrokes are injected into the session and the non-holder's input is suppressed

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

### Requirement: Readoption attach does not record bootstrap output as task history

When CAP re-adopts a running task whose detached session is alive, the attach phase SHALL
restore the live viewer without appending attach bootstrap output to durable task
history. Bootstrap output includes shell command echo, duplicate-session messages, tmux
attach setup output, and the initial current-screen repaint emitted solely because CAP
attached a new provider terminal transport. After the attach bootstrap completes, new
agent output SHALL be recordable again.

#### Scenario: Re-adopted alive session does not duplicate launch history

- **WHEN** the API restarts and re-adopts a running task whose detached session is alive
- **THEN** CAP attaches to the existing session rather than launching a second agent
- **AND** the attach bootstrap bytes are not appended to `session.log`
- **AND** the attach bootstrap bytes are not appended to `session.cast`

#### Scenario: Later output remains recordable after readoption

- **WHEN** CAP has completed the attach bootstrap for a re-adopted running task
- **AND** the live agent later emits new terminal output
- **THEN** the new terminal output is appended to the task's durable history normally

#### Scenario: Operator still sees the re-adopted live frame

- **WHEN** an operator reconnects to a re-adopted running task during or after attach
  bootstrap
- **THEN** the operator's live terminal can still be restored to the current visible
  frame
- **AND** suppressing durable recording of bootstrap output does not make the task
  appear disconnected or blank
