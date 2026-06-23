# Design

## Context

`session-cast-log.tsx`'s `complete()` (v0.20.3) fires after the watermark backpressure loop finishes
feeding the cast: it `scrollToTop()` + `setFeedingDone(true)`. Live measurement shows xterm's buffer is
correctly filled (baseY 199, 226 lines) but `.xterm-viewport`'s `scrollHeight` is stuck at one screen
(581 == clientHeight) — the viewport scroll-area was never synced to the buffer, so the log is not
scrollable. A resize nudge synces it (581 → 4859, canScroll true).

## Goals / Non-goals

- **Goal:** after the paced fill, the static log is actually scrollable — xterm's viewport reflects the
  buffered scrollback, with no manual interaction needed.
- **Non-goal:** changing the backpressure loop / chunking / cap (those are correct); changing the cast
  geometry or column wrapping; fixing codex's own clear-redraw casts that genuinely hold no scrollback.

## Decisions

**D1 — Root cause is a missing viewport sync, live-measured.** `scrollToTop()` and `refresh()` do NOT
update `.xterm-viewport` scrollHeight (still 581); a `resize` DOES (4859, canScroll true). The old code
ended with an empty `handle.write("", cb)` that incidentally triggered the sync; the v0.20.3 watermark
rewrite dropped it.

**D2 — Fix: a resize nudge in `complete()` before `scrollToTop`.** Read the current geometry
(`handle.geometry()`), then `handle.resize(cols, rows + 1)` followed by `handle.resize(cols, rows)`.
This forces xterm's `syncScrollArea` while keeping `cols` unchanged — so there is NO wrap reflow and the
cast's cursor-addressed redraws remain correct. The transient extra row is immediately reverted.

**D3 — Why a nudge, not `fit()`.** `handle.fit()` resizes to the CONTAINER's cols/rows, which differ
from the cast's recorded geometry (cols 176/282) → wrap reflow that can scramble cursor-addressed
content. The nudge keeps the cast's column geometry; it only pokes the scroll-area.

**D4 — 763763fe caveat (out of scope).** A 137MB alt-screen cast that codex rendered by clear-redraw
(not scroll-up) may hold no scrollback in the buffer at all — then there is nothing to scroll even with
a synced viewport. That is a codex-render limitation, separate from this viewport-sync bug. This fix
unblocks every cast whose buffer DOES accumulate scrollback (all inline `--no-alt-screen` casts).

## Risks / Trade-offs

- **Resize nudge is a poke, not a first-class API.** Acceptable: it's the minimal trigger for
  `syncScrollArea` that preserves geometry; measured to work. If a future xterm exposes a direct
  viewport-sync, switch to it.
- **A transient rows+1.** One extra row for a microtask before reverting — no visible flicker (it
  happens under the loading overlay, right before it's dropped) and the cast content is unaffected
  (cols unchanged).

## Migration

None (front-end replay-completion poke only).
