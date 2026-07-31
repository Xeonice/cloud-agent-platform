## Why

The shipped 终端回放 tab plays the recorded `session.cast` frame-by-frame on its
recorded clock (play/pause/seek/speed). Operators don't want to *watch* a session
evolve — they want to **open the tab and immediately read the whole terminal history**,
scrolling through it like a log. A spike against a real production cast proved this is
achievable cheaply: running codex's stream in xterm's **normal** buffer (instead of the
alternate buffer it records in) makes xterm's own scrollback engine reconstruct the
full linear history (52 vs 6 scrollback lines on the real cast) — no timing playback,
no hand-written VT simulation.

## What Changes

- **BREAKING (UI)**: Replace the timing-driven cast player in the 终端回放 tab with a
  **static, all-at-once, scrollable terminal log**. Open → the entire recorded terminal
  history is laid out top-to-bottom in a read-only xterm with a native scrollbar.
- De-animate the cast by **suppressing the alternate-screen switch** (`?1049h/l`,
  `?1047h/l`, `?47h/l`) and writing the whole de-alt'd stream into a read-only
  `@cap/ui <Terminal>` with a large scrollback; resize (`r`) events are still applied so
  geometry/scroll math match the recording.
- **Remove** the timing engine and transport controls: delete `session-cast-player.tsx`
  and the `cast-playback.ts` timing helpers (+ tests); no play/pause/seek/speed.
- **Rename** the tab from 终端回放 (replay) to **终端记录** (record), matching that it is
  no longer a playback. (Pairs with the existing 对话记录 tab.)
- Keep the honest empty state when there is no cast.
- **Unchanged**: cast recording (`session.cast`), the `GET /tasks/:id/cast` endpoint,
  `session.log`, the live WebSocket/PTY/write-lease path, and the 对话记录 (rollout) tab.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `session-terminal-replay`: the terminal presentation requirement changes from
  *timing-driven frame-by-frame playback with transport controls* to *a single static
  all-at-once scrollable log produced by feeding the cast into xterm's normal-buffer
  scrollback with the alternate-screen switch suppressed*. Recording and the read
  endpoint requirements are unchanged.

## Impact

- **Front-end** (`apps/web`):
  - `components/session/session-replay.tsx`: 终端回放→终端记录 tab renders the new static
    log component instead of `SessionCastPlayer`.
  - New `components/session/session-cast-log.tsx` (read-only static xterm + one-shot
    write) + pure helper `components/session/cast-log.ts` (`stripAltScreen` /
    `parseResizeData` / `feedCastLog`) + tests `cast-log.test.ts` and
    `cast-log.headless.test.ts` (the latter adds a `@xterm/headless` devDep to `@cap/web`).
  - **Removed**: `components/session/session-cast-player.tsx`,
    `components/session/cast-playback.ts` + `cast-playback.test.ts` (timing engine now
    dead).
  - Possibly a `@cap/ui <Terminal>` prop to expose/scroll a large scrollback in a
    read-only, no-`onData` mode (if the current component can't do a one-shot bulk write
    with scrollback).
- **No back-end change**: recording + `GET /tasks/:id/cast` are untouched; the front-end
  still fetches via the same `getSessionCast`.
- **Honest ceiling (documented, not a regression)**: codex collapses long tool output in
  its TUI (`… +N lines (ctrl + t)`); those lines were never drawn, so no terminal view
  (old replay or new log) can show them — the 对话记录/rollout tab remains the complete
  record.
