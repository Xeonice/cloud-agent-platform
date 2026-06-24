## ADDED Requirements

### Requirement: The task response exposes the execution mode

The task response (`TaskResponse`) SHALL include `executionMode` (`interactive-pty` | `headless-exec`),
derived at task creation from the consumer (console → `interactive-pty`; MCP/`/v1` → `headless-exec`)
and already persisted on the task. This lets the console branch the session view by mode (terminal vs
polled conversation) without inferring it. The field is additive and backward-compatible.

#### Scenario: Task response carries executionMode

- **WHEN** a client fetches a task (single or list)
- **THEN** the response includes `executionMode` reflecting how the task was created (`interactive-pty` for console, `headless-exec` for MCP/`/v1`)
