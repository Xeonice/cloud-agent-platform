## Why

The live task terminal had four related defects under long output and refresh/reconnect:

- A hard refresh replayed output visibly, producing a fast flash instead of opening directly at the latest screen.
- xterm-generated device/cursor replies such as `0;276;0c` could be forwarded as operator input and then appear in the terminal.
- With large output, the xterm scrollbar could move while the rendered rows did not update, and live viewport sync could snap the operator back to the bottom while they were scrolling history.
- After API/sandbox terminal bridge churn, the browser accepted typing but the sandbox terminal WebSocket could already be closed, so input was silently dropped.

Operators need the live task terminal to behave like a durable terminal: refresh opens at the current tail without visual replay noise, scrollback remains usable during continuous output, and typing reaches the running tmux session.

## What Changes

- Reconnect replay is hidden and queued until xterm flushes the snapshot/tail data; the terminal is revealed after the viewport is synced and scrolled to the bottom.
- Fresh browser loads (`fromSeq=0`) replay a bounded suffix of `session.log` instead of a SerializeAddon snapshot alone, so xterm rebuilds useful scrollback after refresh.
- The shared `@cap/ui <Terminal>` handle can sync xterm's viewport, preserve a user-scrolled position during local resize nudges, repaint visible rows, and map DOM viewport scrolling back to xterm buffer lines.
- Terminal-generated DA/CPR/DSR replies are filtered before the live input path sends takeover/keystroke frames.
- The AIO PTY client queues operator input when the sandbox terminal WS is stale, reopens the bridge, re-attaches to the detached tmux session, and drains queued input.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `realtime-terminal`: refresh/reconnect behavior, live scrollback behavior, terminal-generated response filtering, and stale sandbox input delivery are strengthened.

## Impact

- Frontend:
  - `apps/web/src/components/session/session-terminal.tsx`
  - `apps/web/src/components/session/terminal-input-filter.ts`
  - `packages/ui/src/terminal/terminal.tsx`
  - `apps/web/src/components/session/session-cast-log.tsx`
- Backend:
  - `apps/api/src/terminal/snapshot.ts`
  - `apps/api/src/terminal/aio-pty-client.ts`
- Tests:
  - `apps/web/src/components/session/terminal-input-filter.test.ts`
  - `apps/api/src/terminal/snapshot.spec.ts`
- No database migration and no public contract change.
