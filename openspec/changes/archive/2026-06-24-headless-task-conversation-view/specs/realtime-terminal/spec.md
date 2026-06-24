## ADDED Requirements

### Requirement: A headless task opens no live terminal

A headless task (`executionMode = headless-exec`) SHALL NOT open the live-terminal WebSocket or mount
the xterm in the console — its execution output is structured events, not a terminal stream, so the
terminal renderer is not used. Its live view is the polled conversation (session-history-replay), not a
terminal. An interactive (`interactive-pty`) task keeps the live xterm + WebSocket exactly as before.

#### Scenario: Headless task does not mount the live xterm/WS

- **WHEN** the console opens a headless task that is running
- **THEN** it does NOT open the terminal WebSocket nor mount the xterm; it renders the polled conversation instead

#### Scenario: Interactive task keeps the live terminal

- **WHEN** the console opens an `interactive-pty` task
- **THEN** it opens the live-terminal WebSocket and mounts the xterm as before
