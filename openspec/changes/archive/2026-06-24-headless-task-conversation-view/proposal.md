# Render headless (MCP/`/v1`) tasks as a live conversation, not a JSON terminal

## Why

Headless tasks (MCP and `/v1`, `executionMode = headless-exec`) run `codex exec --json`, which emits
STRUCTURED JSON events. The web console shows them in the live xterm, which renders the raw JSON
(escaped `\n\t`) — unreadable (measured on task 33e55883). xterm is a terminal renderer for an
interactive PTY stream (codex's full-screen TUI); headless output is structured data — a category
mismatch (using a terminal to display events).

Crucially, headless tasks already have a readable conversation AFTER they finish: codex writes a
rollout, which `rollout-parser` → `session-replay` already renders as the 对话记录. The gap is only the
LIVE view (raw JSON in xterm) and the 终端记录 (also JSON). And headless's console presence is
read-only viewing — the real entry point is programmatic (MCP/`/v1`), so it does NOT need a terminal or
a WebSocket at all. It should render the structured conversation, live, by polling.

## What Changes

- **Expose `executionMode` to the front-end** (consumer-derived, already persisted on the task) so the
  console can branch the view by mode.
- **Headless live view = the live conversation (`session-replay`), POLLED — no WS, no xterm**: while
  running, the front-end polls the session-history endpoint; the backend reads the sandbox rollout
  INCREMENTALLY (by byte offset) → `rollout-parser` → `SessionTurn`s; `session-replay` renders the
  accumulating turns. (User decision: headless's web entry is read-only, so no WS is needed; parsing is
  incremental.)
- **The session-history endpoint serves a RUNNING headless task** (live read of the sandbox rollout),
  not only the durable archive of a finished task.
- **Headless provides NO 终端记录 (cast), anywhere**: the front-end hides the 终端记录 tab for headless;
  the backend does not capture/expose a cast for headless tasks.
- **Interactive (`interactive-pty`, console) is UNCHANGED**: xterm live + 对话记录 + 终端记录.

## Impact

- Affected specs:
  - `session-history-replay` — the endpoint + console branch also serve a RUNNING headless task via
    poll + incremental rollout parsing (today it is stopped-container only).
  - `session-terminal-replay` — no cast for headless.
  - `realtime-terminal` — a headless task does not open the live WS / xterm.
  - task DTO (`repo-and-task-management`) — `executionMode` exposed on the task response.
- Affected code: backend (task DTO `executionMode`; session-history live read for running headless +
  incremental `rollout-parser`; headless cast suppression); front-end (executionMode branch: headless
  polls session-history → `session-replay` live, hides 终端记录, opens no WS).
- Reuses `rollout-parser` (+ incremental) and `session-replay` (+ live mode). No DB migration
  (`executionMode` already persisted).
