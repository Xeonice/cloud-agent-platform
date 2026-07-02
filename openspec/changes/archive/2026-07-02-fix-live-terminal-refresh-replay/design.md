# Design

## Context

The terminal stack already has the right high-level shape: browser xterm receives raw PTY bytes plus control frames, the API owns reconnect replay through `SnapshotManager`, and the AIO PTY client attaches to a detached tmux session so tasks survive API restarts. The remaining bugs were at the seams:

- SerializeAddon snapshots restore the current frame but not scrollback. A fresh browser load that starts from seq 0 therefore landed with little or no history even though `session.log` had the data.
- xterm writes are asynchronous. Writing a large reconnect tail directly into a visible terminal shows intermediate fill states before the latest frame is reached.
- xterm's DOM viewport can lag or desynchronize from its buffer after paced writes and local viewport-sync resize nudges.
- xterm itself emits terminal response sequences through `onData` during replay; those are not human keystrokes.
- The API-to-sandbox terminal WS is not the authoritative session. The detached tmux session is authoritative; the WS is an attach bridge and can need reopening when the operator types later.

## Goals / Non-Goals

**Goals:**

- A refreshed live task opens directly on the current latest screen while retaining useful scrollback.
- The operator can scroll while output continues, and visible rows actually change during scroll.
- xterm-generated response sequences never become operator keystrokes.
- Typing reaches the running tmux session even if the sandbox terminal attach bridge went stale.

**Non-goals:**

- No new terminal protocol frame or public API contract.
- No change to the write-lock ownership model.
- No removal of the existing snapshot + incremental tail path for non-fresh reconnects.
- No unbounded replay of arbitrarily large historical logs.

## Decisions

### D1 — Fresh reconnect uses bounded `session.log` replay

For `fromSeq <= 0`, `SnapshotManager.buildReconnectFrames()` replays a bounded suffix of `session.log` and skips the SerializeAddon snapshot. This rebuilds xterm scrollback for a hard refresh. Incremental reconnects (`fromSeq > 0`) keep the faster snapshot + tail path.

The byte budget is explicit (`DEFAULT_FRESH_RECONNECT_REPLAY_BYTES = 16 MiB`) so reconnect cost is bounded.

### D2 — Browser queues reconnect writes while hidden

Reconnect `snapshot` / `tail_replay` frames are queued and written one at a time using xterm's flush callback. The terminal is temporarily hidden during replay, then synced, scrolled to bottom, focused, and revealed only after the final tail frame flushes. A watchdog reveals defensively if the final frame is delayed, but the queue continues draining.

### D3 — Shared Terminal owns viewport sync and repaint

`@cap/ui <Terminal>` exposes `syncViewport()` and `refresh()` on `TerminalHandle`. `syncViewport({ preserveScroll: true })` triggers xterm's resize path without changing cols and restores the user's `viewportY` when they are not at the bottom. The wrapper also listens to the DOM `.xterm-viewport` scroll event, maps scrollTop to a public xterm buffer line, calls `scrollToLine()`, and refreshes the visible rows.

This keeps the xterm-specific viewport mechanics in the shared wrapper instead of duplicating private DOM handling in every consumer.

### D4 — Terminal-generated responses are filtered at the live input boundary

The live `onData` path filters DA/secondary-DA/CPR/DSR style terminal replies before sending takeover or keystroke frames. Normal user input, cursor keys, and bracketed paste markers are not filtered.

### D5 — Stale sandbox terminal WS reopens on input

`AioPtyClient.sendInput()` returns whether a JSON frame was actually sent. If not, it queues the input and opens a replacement sandbox terminal WS. Once the replacement reaches `ready`, it attaches to the detached tmux session and drains pending input.

Late events from superseded sockets are fenced so an old close/error cannot corrupt the current bridge state.

## Risks / Trade-offs

- **Fresh replay cost:** bounded log replay is heavier than a snapshot. The 16 MiB cap keeps worst-case bounded while covering long practical scrollback cases such as the 20k-line verification.
- **Viewport scroll mapping:** mapping DOM scrollTop to buffer lines is proportional rather than using xterm internals. It uses only public xterm API, which is preferable to private `_core` access.
- **Hidden replay timeout:** a very large reconnect may exceed the watchdog. The watchdog reveals rather than leaving a black terminal, but queued replay still finishes and does final sync.

## Migration

No migration. The behavior takes effect for new browser connections and stale AIO attach bridges after deploy.

## Open Questions

- Whether the fresh replay byte cap should become configurable by deployment env after observing production session sizes.
