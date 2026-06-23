# Fix: terminal-record viewport not scrollable after the paced fill (v0.20.3 regression)

## Why

v0.20.3 (`fix-terminal-record-replay-flow-control`) replaced the single bulk write with a watermark
backpressure loop. The fill itself is now correct — measured live on task 664799a4:
`term.buffer.active.baseY = 199`, 226 buffered lines, so the scrollback IS present in xterm's buffer.
BUT the `.xterm-viewport` DOM `scrollHeight` stays at one screen (581px == `clientHeight`) → `canScroll`
false → the operator cannot scroll the history. A single resize nudge fixes it instantly
(`scrollHeight` 581 → 4859, `canScroll` true), proving the buffer is fine and only xterm's viewport
**scroll-area was never synced** after the paced fill.

Root cause: the OLD replay ended with `handle.write("", () => handle.scrollToTop())` — that empty write
incidentally drove xterm's viewport `syncScrollArea`. The v0.20.3 watermark rewrite replaced the empty
write with the flush-callback completion path, **dropping that sync trigger**. So backpressure / no-
discard all work, but the viewport height never catches up to the buffer — verified live:
`scrollToTop()` alone and `refresh()` alone do NOT sync (still 581); a `resize` nudge does (4859).

## What Changes

- On replay completion (`complete()` in `session-cast-log.tsx`), force xterm's viewport scroll-area to
  sync to the filled buffer BEFORE `scrollToTop()` — a `resize` nudge (rows+1 then rows back) that
  keeps the cast's COLUMN geometry intact (so cursor-addressed redraws stay correct, no wrap reflow)
  but triggers `syncScrollArea`. Verified live: `scrollHeight` 581 → 4859, `canScroll` true, scrolls to
  the top of the history.

## Impact

- Affected spec: `session-terminal-replay` (the filled static log MUST be scrollable — the viewport
  synced to the buffer, not stuck at one screen).
- Affected code: `apps/web/src/components/session/session-cast-log.tsx` (`complete()` viewport sync).
- No backend / contract / cast-format change. A focused patch to the v0.20.3 regression. (Separately:
  a 137MB alt-screen cast that codex rendered via clear-redraw may still hold no scrollback to scroll —
  that's a codex-render limit, not this bug; this fix unblocks every cast that DOES have scrollback,
  i.e. all inline `--no-alt-screen` casts post-fix#2.)
