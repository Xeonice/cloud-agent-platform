# Tasks

> Live-measured regression from v0.20.3: the watermark fill correctly accumulates scrollback in xterm's
> buffer (664799a4: baseY 199, 226 lines) but `.xterm-viewport` scrollHeight stays at one screen (581 ==
> clientHeight) → not scrollable. `scrollToTop()`/`refresh()` don't sync; a `resize` nudge does
> (581→4859, canScroll true). The old code's trailing empty `write("", cb)` incidentally triggered the
> sync; the watermark rewrite dropped it.

## 1. Track: sync the viewport on completion

- [x] 1.1 `apps/web/src/components/session/session-cast-log.tsx` — in `complete()`, BEFORE `scrollToTop()`, force xterm's viewport scroll-area to sync to the filled buffer: read `handle.geometry()` and do a `resize` nudge that keeps `cols` unchanged (no wrap reflow, cast cursor-addressing preserved) — `handle.resize(cols, rows + 1)` then `handle.resize(cols, rows)`. Null-geometry guarded. DONE.

## 2. Track: verify (acceptance gate)

- [x] 2.1 `apps/web` typecheck clean + 236 tests green (no test asserted the old completion shape). DONE.
- [ ] 2.2 Live verify (POST-DEPLOY) in Chrome on the wide viewport (Browser 2): open a fresh inline task's 终端记录 — once loaded, the log is scrollable to the top of the history WITHOUT any manual resize/interaction (`.xterm-viewport` scrollHeight > clientHeight, canScroll true). Confirm the cast content (cols/wrap) is unchanged by the nudge.
