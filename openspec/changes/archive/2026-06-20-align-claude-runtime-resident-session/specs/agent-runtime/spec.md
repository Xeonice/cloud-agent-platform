## MODIFIED Requirements

### Requirement: ClaudeCodeRuntime turn-completion exit detection
`ClaudeCodeRuntime` SHALL be a RESIDENT continuous-conversation session, behaviorally identical to codex: a finished turn does NOT terminate the task. After answering, Claude idles at its interactive TUI for the next input, which the operator supplies by typing into the live xterm (the same write-lease-gated keystroke path codex uses), driving multi-turn conversation in the SAME session.

`ClaudeCodeRuntime.detectExit()` SHALL resolve completion from session liveness — `tmux has-session` over the exec handle (present → `running`, GONE → `done`) — exactly like `CodexRuntime.detectExit()`. It SHALL NOT tail the transcript for `end_turn`, SHALL NOT proactively `tmux kill-session` on a finished turn, and SHALL NOT trigger the codex-style exit-status resolution (`/v1/shell/wait` / `echo $?`) on a still-alive session. A task is `done` ONLY when the session is gone — via an explicit operator stop, or (when configured) idle/deadline reclamation. The liveness watchdog SHALL still classify a session that disappears WITHOUT a stop/idle in flight as an abnormal death (`failed`), so a genuinely crashed agent is not left hanging; a clean, idling turn is NEVER probed for an exit code.

#### Scenario: A finished turn keeps the session resident
- **WHEN** a Claude turn finishes (the latest `assistant` event is `end_turn`) and the process idles for the next input
- **THEN** the task remains `running`, the tmux session is NOT killed, and no exit-status resolution runs

#### Scenario: Follow-up input continues the same conversation
- **WHEN** the operator types a follow-up into the live xterm while the task is resident
- **THEN** Claude processes it as the next turn in the same `--session-id` session, with no new task created

#### Scenario: Completion is resolved by session-gone, like codex
- **WHEN** the session is stopped (operator stop, or a configured idle/deadline reclamation) and `tmux has-session` reports GONE
- **THEN** `detectExit` returns `done` and the task transitions to a terminal state via the shared session-gone path — the SAME mechanism codex uses

#### Scenario: An unexpectedly dead session is failed, not silently completed
- **WHEN** the tmux session disappears with no operator stop and no idle/deadline reclamation in flight (the agent or tmux daemon crashed)
- **THEN** the abnormal-death watchdog resolves the task as `failed`
