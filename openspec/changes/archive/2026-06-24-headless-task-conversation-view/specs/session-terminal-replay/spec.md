## ADDED Requirements

### Requirement: Headless tasks have no terminal record

A headless task (`executionMode = headless-exec`) SHALL NOT have an asciicast terminal record anywhere:
the recorder SHALL NOT capture a cast for it, the cast read endpoint SHALL return the honest
absent/empty state for it (never a JSON-stream cast), and the console SHALL NOT show the 终端记录 tab
for it. A headless task's only review surface is the structured conversation (session-history-replay).
Interactive (`interactive-pty`) tasks keep their asciicast terminal record unchanged.

#### Scenario: No cast captured or served for a headless task

- **WHEN** a headless task runs and finishes
- **THEN** no asciicast is captured for it, and the cast read endpoint returns the honest absent/empty state (not a recorded JSON stream)

#### Scenario: Console hides the terminal-record tab for headless

- **WHEN** the console views a headless task
- **THEN** the 终端记录 tab is not shown (the conversation is the only review surface); an interactive task still shows 终端记录
