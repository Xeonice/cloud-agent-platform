# Tasks

## 1. Track: reconnect-replay (depends: none)

- [x] 1.1 `apps/api/src/terminal/snapshot.ts` — fresh reconnect (`fromSeq <= 0`) replays a bounded suffix of `session.log`; incremental reconnect keeps snapshot + tail.
- [x] 1.2 `apps/api/src/terminal/snapshot.spec.ts` — cover fresh log replay, byte-budget truncation, and incremental snapshot + tail behavior.
- [x] 1.3 `apps/web/src/components/session/session-terminal.tsx` — queue reconnect writes, hide while replaying, reveal after final flush scrolled to bottom.

## 2. Track: viewport-scroll (depends: reconnect-replay)

- [x] 2.1 `packages/ui/src/terminal/terminal.tsx` — expose `scrollToBottom`, `syncViewport`, and `refresh`; add DOM viewport scroll bridge using public xterm APIs.
- [x] 2.2 `apps/web/src/components/session/session-terminal.tsx` — use `syncViewport({ preserveScroll: true })` for live output sync so scrolling history is not snapped to bottom.
- [x] 2.3 `apps/web/src/components/session/session-cast-log.tsx` — use the shared `syncViewport()` helper for static cast log viewport sync.

## 3. Track: input-cleanliness (depends: none)

- [x] 3.1 `apps/web/src/components/session/terminal-input-filter.ts` — detect terminal-generated DA/secondary-DA/CPR/DSR replies.
- [x] 3.2 `apps/web/src/components/session/session-terminal.tsx` — filter generated replies before takeover/keystroke send.
- [x] 3.3 `apps/web/src/components/session/terminal-input-filter.test.ts` — prove generated replies are filtered while normal input, cursor keys, and bracketed paste survive.

## 4. Track: stale-bridge-input (depends: none)

- [x] 4.1 `apps/api/src/terminal/aio-pty-client.ts` — reopen stale sandbox terminal WS on input, attach to the detached tmux session, and drain queued input.
- [x] 4.2 Fence message/close/error handlers from superseded sockets.

## 5. Track: verification (depends: reconnect-replay, viewport-scroll, input-cleanliness, stale-bridge-input)

- [x] 5.1 Run `pnpm --filter @cap/ui build` and `pnpm --filter @cap/ui lint`.
- [x] 5.2 Run `pnpm --filter @cap/web typecheck`, `pnpm --filter @cap/web lint`, and `pnpm --filter @cap/web test -- terminal-input-filter cast-log`.
- [x] 5.3 Run `pnpm --filter @cap/api typecheck`, `pnpm --filter @cap/api lint`, and `pnpm --filter @cap/api test -- snapshot`.
- [x] 5.4 Live Playwright verify on a 20k-line task: refresh lands at tail, no `0;276;0c`, scroll visible rows change, input reaches tmux.
- [x] 5.5 Live Playwright verify on an infinite-output task: output changes while running, scrolling remains usable, visible rows change during scroll.
