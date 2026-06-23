# Verification Report — fix-terminal-record-replay-flow-control

## Outcome

All requirements of the single MODIFIED spec (`session-terminal-replay` →
"Static all-at-once terminal log") re-trace end-to-end as MET against the actual
code. No UNMET code tasks re-opened; no spec-defects routed. The raw-unmet list
handed to this routing pass was empty, and an independent re-trace of every
scenario confirms each is satisfied.

Static + unit coverage is green: `cast-log.test.ts` (15 tests) and
`cast-log.headless.test.ts` (1 test, real `@xterm/headless`) both pass
(16 passed). The only remaining item is `tasks.md` 4.2 — a POST-DEPLOY live
Chrome verification — which is an explicitly deferred manual gate, not a code
gap.

## Met requirements (re-traced)

All six scenarios from the spec have traceable implementations:

1. **Full history shown at once** — `session-cast-log.tsx` fetches/parses cast,
   processes events in order, strips alt-screen via `buildCastOps` /
   `stripAltScreen`, writes into a read-only `<Terminal>` with large scrollback
   (`LOG_SCROLLBACK = 100_000`), no per-event timing.

2. **Large cast replays losslessly via flow control** — `cast-log.ts`
   `buildCastOps` splits into 64KB chunks (`DEFAULT_CAST_CHUNK_SIZE`);
   `session-cast-log.tsx` drives `pump()` with high (`2MB`) / low (`512KB`)
   watermarks using xterm's write callback, keeping the in-flight count below
   xterm's 50MB discard cap.

3. **Loading state until replay is complete** — `feedingDone` state starts
   false; overlay `div.absolute.inset-0.z-10` covers the always-mounted terminal
   until `complete()` fires; `scrollToTop()` called first, then the overlay
   drops. `alive` guard prevents after-unmount reveal; `feedingDone` resets on
   `taskId` change.

4. **Oversized cast capped with notice** — `capCastOps` in `cast-log.ts` keeps
   the most-recent `DEFAULT_CAST_MAX_OUTPUT = 24MB` of output chars (dropping the
   earliest output chunks, preserving resize ops and the tail) and prepends
   `CAST_TRUNCATION_NOTICE` ("⋯ 较早的输出已省略（记录过大）").

5. **All-at-once recovers more than final frame** — `stripAltScreen` removes
   `?1049h/l`, `?1047h/l`, `?47h/l`; validated by the headless xterm regression
   test in `cast-log.headless.test.ts` ("alt stripped recovers far more lines
   than alt kept"), which runs against the real `@xterm/headless` emulator.

6. **Read-only, no playback or live affordances** — `<Terminal>` mounted without
   an `onData` prop; no WebSocket; no play/pause/seek/speed controls. Contrasts
   with `session-terminal.tsx`, which wires `onData` for the live path.

7. **Theme parity with live terminal** — `session-cast-log.tsx` resolves the
   same `--terminal-bg`, `--terminal-fg`, `--terminal-muted`, `--font-mono` CSS
   vars (with the same `#050505` / `#e8e8e8` / `#8a8a8a` fallbacks) that
   `session-terminal.tsx` resolves.

## Scope finding

All four modified files (`cast-log.ts`, `session-cast-log.tsx`,
`cast-log.test.ts`, `cast-log.headless.test.ts`) are within the scope declared by
the proposal, design, and tasks. The implemented behaviors map cleanly onto spec
requirements with no orphan behavior:

- `feedCastLog` → `buildCastOps` (chunked pure producer) — reqs 1, 2, 3, 6
- Watermark loop in `session-cast-log.tsx` — reqs 1, 3
- `feedingDone` loading overlay (+ `setFeedingDone(false)` on taskId change,
  `alive` guard on `complete()`) — req 4
- `capCastOps` + `CAST_TRUNCATION_NOTICE` — req 5
- Test updates in `cast-log.test.ts` + `cast-log.headless.test.ts` — coverage
- Exported named constants (`DEFAULT_CAST_CHUNK_SIZE`, `DEFAULT_CAST_MAX_OUTPUT`,
  `CAST_TRUNCATION_NOTICE`), `BuildCastOpsOptions`, and the
  `CastOutputOp`/`CastResizeOp`/`CastOp` types — implementation details enabling
  the chunked producer + unit tests (reqs 1, 2, 3, 5)
- `completed` guard inside `complete()` — implementation detail of the watermark
  loop; no standalone spec, prevents double-completion

There are no extra behaviors lacking a corresponding requirement, and no spec
requirement lacking an implementation.

## Re-trace tally

- Re-opened code tasks: 0
- Spec defects routed to design.md Open Questions: 0
- Reclassified MET (all spec scenarios): 7

## Remaining (non-blocking)

`tasks.md` 4.2 — live Chrome verification on the wide viewport after deploy
(loading→complete every open, no "one screen" race; 763763fe-class large cast no
longer errors "write data discarded"). This is a deliberately deferred
POST-DEPLOY manual step, consistent with prior changes in this codebase that gate
live verification behind deployment.
