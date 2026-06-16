## MODIFIED Requirements

### Requirement: Exit detection mapped to guardrails
The `AioPtyClient` SHALL detect task termination by LIVENESS of the detached codex session — NOT by the terminal WebSocket closing — because once codex runs in a detached named tmux session a WS close no longer means the task ended (the operator merely disconnected, or the api restarted). The system SHALL poll the named tmux session existence (`tmux has-session -t task<taskId>`) and/or the codex process liveness; only when the session/process is GONE SHALL it treat the task as terminated, and SHALL then determine the exit status using `POST /v1/shell/exec` (e.g. a recorded `$?` / a sentinel the session writes on exit) and/or `/v1/shell/wait`, mapping a zero exit status to guardrails `recordSuccess` and a non-zero or abnormal termination to guardrails `recordFailure`. A WS close while the session is still alive SHALL NOT call `recordSuccess`/`recordFailure`. The orchestrator bridge (`AioPtyClient`/gateway) SHALL ALSO persist the raw PTY output stream by appending it to `workspaces/<taskId>/session.log` as it is received, keeping the byte-offset fed to `snapshots.feed` in lockstep with the bytes written to `session.log`, so that reconnect tail-replay has a durable source of prior output.

#### Scenario: Session-gone (not WS close) triggers exit-status resolution
- **WHEN** the detached codex session for a task is observed to no longer exist (tmux session gone / codex process exited)
- **THEN** `AioPtyClient` resolves the task exit status via `/v1/shell/exec` and/or `/v1/shell/wait` and reports the terminal outcome to guardrails

#### Scenario: A WS close with a live session does not terminate the task
- **WHEN** the orchestrator's terminal WebSocket closes (operator disconnect or api restart) while the named tmux session is still alive
- **THEN** the system does NOT call guardrails `recordSuccess` or `recordFailure`, and the task remains running for re-adoption

#### Scenario: Exit status maps to guardrails outcome
- **WHEN** the resolved exit status is zero
- **THEN** the system calls guardrails `recordSuccess`
- **AND** when the resolved exit status is non-zero or the termination is abnormal, the system calls guardrails `recordFailure`

#### Scenario: Raw PTY output is persisted to session.log in the orchestrator bridge
- **WHEN** the sandbox emits raw `output` for a task with id `<taskId>`
- **THEN** the orchestrator bridge appends those raw bytes to `workspaces/<taskId>/session.log`
- **AND** the byte-offset advanced in `snapshots.feed` stays in lockstep with the bytes written to `session.log`
