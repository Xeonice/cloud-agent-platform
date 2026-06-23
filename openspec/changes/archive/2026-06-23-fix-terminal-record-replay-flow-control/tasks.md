# Tasks

> Root cause (web-confirmed + measured live): 终端记录 replay feeds the WHOLE cast to xterm in one
> `handle.write()` with NO flow control. xterm buffers non-blocking with a hard 50 MB discard cap →
> large casts (763763fe = 137 MB alt-screen) error "write data discarded"; even small ones (448 KB
> post-fix#2) race xterm's async parse → "one screen then fills in". Fix = the official `write(chunk,
> cb)` watermark backpressure, keeping the single `@cap/ui <Terminal>` (asciinema-player / SSR rejected,
> see design D6).

## 1. Track: chunked pure producer (cast-log.ts)

- [x] 1.1 `cast-log.ts` — `feedCastLog` replaced by PURE `buildCastOps(events, opts)` producing an ordered op list (`{type:'output', data}` alt-screen-stripped + split into bounded chunks ≤ `chunkSize` (64 KB default), `{type:'resize', cols, rows}`). Rejoin-then-strip preserved (strip on the concatenated run BEFORE chunking). Framework-free. DONE.
- [x] 1.2 `cast-log.test.ts` + `cast-log.headless.test.ts` updated for the op-list shape: assert chunk ordering, bounded chunk split, alt-screen stripped, resize ops at position, ignore `i`/`m`, plus cap behavior; headless test feeds the op list into real `@xterm/headless`. DONE — 236 web tests green.

## 2. Track: backpressured consume + loading state (session-cast-log.tsx)

- [x] 2.1 `session-cast-log.tsx` — consume `buildCastOps(...)` with a high/low WATERMARK loop over `handle.write(chunk, callback)`: track in-flight chars, pump while `< WRITE_HIGH_WATERMARK` (2 MB), the flush callback decrements and resumes `< WRITE_LOW_WATERMARK` (512 KB), resize ops applied inline; complete when ops exhausted AND in-flight 0. Named constants well under xterm's 50 MB cap. DONE.
- [x] 2.2 Loading overlay (`absolute inset-0` `CenteredFace` "读取终端记录…") over the always-mounted `<Terminal>` until the FINAL flush; only then `scrollToTop()` + drop the overlay (`feedingDone`). No partial-frame intermediate. `alive` guard on the deferred reveal; `feedingDone` reset on taskId change. DONE.

## 3. Track: oversized-cast cap

- [x] 3.1 `buildCastOps` caps total output above `maxOutputBytes` (24 MB default): drop EARLIEST output chunks beyond the budget (keep resize ops + the tail), prepend `CAST_TRUNCATION_NOTICE` ("⋯ 较早的输出已省略（记录过大）"). Guarded by a unit test. DONE.

## 4. Track: verify (acceptance gate)

- [x] 4.1 Unit + static: `cast-log.ts` op-list producer green (chunk bounds + alt-screen strip + ordering + cap asserted); headless xterm still proves alt-strip→scrollback; `apps/web` typecheck clean + 236 tests green. DONE.
- [ ] 4.2 Live verify (POST-DEPLOY) in Chrome on the wide viewport (Browser 2): a fresh inline task's 终端记录 opens to a loading state then the COMPLETE scrollable log every time (canScroll true, stable across repeated opens — no "one screen" race); a large/legacy cast (763763fe-class) no longer errors "write data discarded" (renders, scrollable, no crash; capped-with-notice if over cap).
