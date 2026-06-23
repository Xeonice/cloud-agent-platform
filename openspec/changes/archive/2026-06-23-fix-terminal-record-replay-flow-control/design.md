# Design

## Context

`session-cast-log.tsx` replays a finished task's `session.cast` into a read-only `@cap/ui <Terminal>`.
`cast-log.ts`'s `feedCastLog(events, sink)` concatenates all `o` events into one `pending` string and
calls `sink.output(pending)` once → `handle.write(<giant string>)`. xterm buffers writes (non-blocking)
with a hard 50 MB cap, beyond which it discards (`write data discarded, use flow control`). Measured
casts: 137 MB (alt-screen codex, pre-fix#2) and 448 KB (inline codex, post-fix#2). The single bulk
write loses data on big casts and races xterm's async parse on small ones.

## Goals / Non-goals

- **Goal:** replay any-size cast LOSSLESSLY into xterm — never trip the 50 MB discard — via flow
  control, and show a stable loading→complete state (no "one screen then fills in").
- **Goal:** keep `feedCastLog` pure and unit-testable (it decides WHAT bytes; the component decides the
  PACING).
- **Non-goal:** replacing xterm for replay (asciinema-player / server-side render were evaluated and
  rejected — see proposal); changing the live terminal path; changing the recorder / backend / cast
  format. fix#2 (`--no-alt-screen`, already shipped) is the cast-size cure; this is the replay-safety
  cure.

## Decisions

**D1 — Backpressure is the only correct xterm usage (web-confirmed).** xterm's `write` is a buffered,
non-blocking call with a hard 50 MB cap; the official guide gives exactly two patterns: per-chunk
`write(chunk, cb)` pause/resume, and a high/low **watermark** with the callback as the commit signal.
We adopt the watermark for throughput (serial one-chunk-at-a-time also works but stalls on every
chunk). This is the fix — not a new library.

**D2 — Separate WHAT from PACING.** `feedCastLog` becomes a pure producer of an ordered op list:
`{type:'output', data}` (alt-screen-stripped, **split into bounded chunks**, e.g. ≤ 64 KB) and
`{type:'resize', cols, rows}`, in recorded order. It no longer touches a sink or xterm. The component
drives a watermark loop over that list with `handle.write(chunk, cb)`. Keeps `cast-log.ts`
framework-free + unit-testable (just assert the op list); moves all timing/backpressure into the React
component where the xterm handle lives.

**D3 — Watermark loop.** Maintain `inFlight` bytes; pump ops while `inFlight < HIGH`; each `write`'s
callback decrements `inFlight` and resumes pumping when `inFlight < LOW`. A resize op is applied inline
(`handle.resize`). When the op list is exhausted AND `inFlight === 0`, the replay is complete → drop
the loading state and `scrollToTop()`. (HIGH/LOW chosen well under 50 MB, e.g. 2 MB / 512 KB, to leave
headroom for xterm's own parse buffer.)

**D4 — Loading state until complete.** The tab shows "读取中" (reuse the existing `CenteredFace`
loading affordance) from parse-start until the final flush. Only then reveal the terminal + scroll to
top. This removes the observed "opens on one screen, fills in later, sometimes not" race — the user
either sees loading or the complete, scrollable log.

**D5 — Cap pathological casts.** Above a byte threshold (e.g. 24 MB of post-strip output — comfortably
above a long inline task, far below a 137 MB alt-screen dump), replay only the most-recent slice and
prepend a one-line truncation notice (e.g. "⋯ 较早的输出已省略（记录过大）"). Rationale: even with
backpressure, pushing 137 MB through any VT is slow + memory-heavy; these giant casts are alt-screen
legacy (pre-fix#2) that expire on the retention window. The cap is a guard, not the main fix.

**D6 — Stay on xterm.** Evaluated asciinema-player (already rejected as a timing player in prior
changes; new dep; would split live vs replay across two renderers) and server-side rendering (backend
headless xterm hits the SAME 50 MB limit + 137 MB is heavy server-side too). Neither beats fixing flow
control now that fix#2 keeps casts small. One `<Terminal>` for live + replay stays.

## Risks / Trade-offs

- **Watermark tuning.** HIGH/LOW too low → many tiny writes (slow); too high → approach the cap. Pick
  conservative values (≪ 50 MB) and keep them named constants. The serial fallback (one chunk, wait,
  next) is always safe if tuning is fiddly.
- **Chunk splitting across escape sequences.** Splitting `o` data at a fixed byte size could cut an
  ANSI sequence mid-bytes. Mitigate: xterm's parser is stateful across `write` calls (a split sequence
  resumes correctly on the next chunk) — so naive byte-splitting is safe for xterm; the alt-screen
  strip already happens on the rejoined run BEFORE chunking, so the strip is not affected.
- **Cap hides early history for legacy giant casts.** Acceptable + clearly labeled; fix#2 means new
  casts are small and uncapped; the full bytes remain in `session.cast` if ever needed.

## Migration

None (front-end replay pacing only; cast format, recorder, backend untouched).
