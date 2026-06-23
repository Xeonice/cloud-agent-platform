# Fix: terminal-record replay discards data on large casts (no flow control)

## Why

The 终端记录 (terminal-record) replay **loses data on large casts**. Measured live: task
763763fe's `session.cast` is **137 MB** (codex's alternate-screen TUI redraws the whole screen at
high frequency, so the cast accumulates hundreds of MB of frames). Replaying feeds the entire cast into
xterm at once, blowing past xterm's **hard 50 MB write-buffer limit** → `write data discarded, use flow
control to avoid losing data` → the record errors out / renders incompletely / can't scroll the
history. Even after fix #2 shrank a fresh task's cast to ~448 KB, `feedCastLog` still writes the whole
thing in one call while xterm parses asynchronously → "opens on one screen, fills in after a delay,
sometimes never fully" (observed: same task measured 8.4 screens once, one screen another time).

Root cause — `apps/web/src/components/session/cast-log.ts` + `session-cast-log.tsx`: `feedCastLog`
concatenates every `o` event into one giant `pending` string and `sink.output` does a single
`handle.write(<everything>)` — **zero flow control**. xterm is explicit (official flow-control guide):
`write` is non-blocking and buffers; past a hard 50 MB it discards; the ONLY correct usage is the
`write(chunk, callback)` backpressure pattern (or a high/low watermark). We use neither.

(Confirmed by web research: xterm's only correct path is callback backpressure / watermark. Alternatives
— asciinema-player, server-side rendering — were weighed and rejected: they hit the same "a VT
processing 100 MB is slow" physics, asciinema-player was already evaluated-and-dropped in
`session-terminal-replay`/`static-terminal-log` as a timing player that doesn't fit a static log, and
they don't beat fixing xterm flow control once the cast is small. fix #2's `--no-alt-screen` is the
real cure for cast size; this change makes replay of any-size cast lossless.)

## What Changes

- **`feedCastLog` emits ordered chunks** (kept pure, framework-free, unit-testable) instead of
  concatenating one giant string — so the consumer can pace the writes.
- **`session-cast-log.tsx` consumes with backpressure**: drive `handle.write(chunk, callback)` as a
  watermark/serial chain — write a chunk, wait for its flush callback before the next, never letting
  xterm's write buffer approach the 50 MB cap. No more discarded data.
- **Loading state until the replay is fully fed**: show "读取中" while pacing, and only
  `scrollToTop()` on the final flush callback — kills the "one screen then fills in" misleading state.
- **Cap absurdly large casts**: above a threshold, replay only the most-recent N (with a clear
  truncation notice), so a 137 MB legacy cast doesn't hang/OOM the tab even with backpressure (these
  alt-screen casts predate fix #2 and expire on the retention window anyway).

## Impact

- Affected spec: `session-terminal-replay` (Static all-at-once terminal log — add lossless/flow-control
  guarantees + loading state + cap).
- Affected code: `apps/web/src/components/session/cast-log.ts` (`feedCastLog` → chunks) +
  `session-cast-log.tsx` (backpressured consume + loading state + cap). Existing `cast-log.test.ts`
  updated for the chunked output shape.
- No backend / API / schema change. Keeps the single `@cap/ui <Terminal>` for both live + replay (no
  new dependency, no return to the already-rejected asciinema-player).
