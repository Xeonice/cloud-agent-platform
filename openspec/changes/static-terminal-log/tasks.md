<!-- Track-annotated tasks. Each numbered group is a parallel Track. Tasks within a
     track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: ui-terminal-static (depends: none)

- [x] 1.1 Audit `@cap/ui` `<Terminal>` / `TerminalHandle` (`packages/ui/src/terminal/terminal.tsx`): confirm it can mount **read-only** (no `onData`) with a **configurable scrollback** and accept an imperative bulk `write` via its handle. The live terminal usage must stay unaffected. — read-only via omitted `onData` ✓; `write`/`resize`/`clear`/`fit` already on the handle ✓; gaps: scrollback was hardcoded 10k, and no scroll-to-top on the handle.
- [x] 1.2 If any of those are missing, add them minimally (e.g. a `scrollback` option; ensure `write`/`resize` are on the handle) rather than instantiating a second raw xterm. Keep the change additive/back-compatible. — added optional `scrollback?` prop (default 10k, back-compat) + `scrollToTop()` on `TerminalHandle`.

## 2. Track: cast-log (depends: ui-terminal-static)

- [x] 2.1 Add a pure helper module `apps/web/src/components/session/cast-log.ts` with `stripAltScreen(data: string)` that removes the alternate-screen switch (`?1049h/l`, `?1047h/l`, `?47h/l`) while preserving all other control sequences (scroll regions, cursor addressing, clears, scroll-up). — also added `parseResizeData` + `feedCastLog` (one-shot, rejoins output runs before stripping).
- [x] 2.2 Unit test `cast-log.test.ts`: `stripAltScreen` removes the alt-screen sequences and leaves DECSTBM/cursor/erase/`SU` sequences byte-intact. — 11 tests green (strip variants + region survival + feed ordering + split-sequence rejoin + i/m ignored).
- [x] 2.3 Create `apps/web/src/components/session/session-cast-log.tsx`: fetch via `getSessionCast`, `parseCast` the header, process events in recorded order (`r` → `term.resize`; `o` → `stripAltScreen` + `write`) into a read-only `@cap/ui <Terminal>` with a large scrollback and no timing delay; on completion position the view at the top; render the honest empty face when the cast is absent/empty; resolve the same `--terminal-*` theme as the live terminal. — render-once guard + `scrollToTop()` after the bulk write flushes; `scrollback={100_000}`.
- [x] 2.4 Regression test using `@xterm/headless` + a small committed fixture cast: assert the alt-stripped feed yields materially more non-empty content lines than the alt-kept feed (guards the load-bearing normal-buffer scrollback behavior). — added `@xterm/headless` devDep to `@cap/web`; `cast-log.headless.test.ts` synthetic fixture (alt + top-anchored scroll): kept ≤ ROWS, stripped ≥ TOTAL-1 (green).

## 3. Track: replay-wiring (depends: cast-log)

- [x] 3.1 `apps/web/src/components/session/session-replay.tsx`: render `<SessionCastLog taskId={taskId} />` in the terminal tab instead of `<SessionCastPlayer />`; rename the tab label 终端回放 → 终端记录 and update any "回放" wording in this file (the meta-line text stays accurate). — swapped import + render, tab label, two doc comments.
- [x] 3.2 Verify the meta-line and the empty/expired honest faces still read correctly with the renamed 终端记录 tab. — grep confirms no leftover 回放/CastPlayer in the file; meta "终端为中断画面" still accurate; EmptyReplay never named the tab.

## 4. Track: remove-player (depends: replay-wiring)

- [x] 4.1 Delete `apps/web/src/components/session/session-cast-player.tsx`.
- [x] 4.2 Delete `apps/web/src/components/session/cast-playback.ts` and `cast-playback.test.ts` (the rAF timing engine + helpers are now dead).
- [x] 4.3 Grep the repo for `SessionCastPlayer`, `cast-playback`, and `终端回放` and remove/repoint any remaining references; ensure nothing imports the deleted modules. — grep clean across `apps`/`packages` (source + barrels).

## 5. Track: verify (depends: remove-player)

- [x] 5.1 `typecheck` + `lint` + unit tests green for `@cap/ui` and `apps/web` (the new helper/component tests included). — @cap/ui + @cap/web typecheck ✓ (rebuilt @cap/ui dist so the new `scrollToTop`/`scrollback` types resolve); eslint ✓ on all changed/new files; vitest: cast-log (11) + cast-log.headless (1) + 105 others green. NOTE: 1 unrelated red — `update-status-query.test.ts` — is caused by FOREIGN uncommitted WIP in `apps/web/src/lib/api/queries.ts` that reverts the shipped responsive-update-check `refetchInterval`; not touched by this change.
- [ ] 5.2 Real-service check: open a finished task's 终端记录 tab → the full terminal history is shown at once, scrollable, ANSI colors intact, with no play/seek/speed controls and no input; an empty task → honest empty face.
