# Verification Report — fix-live-terminal-refresh-replay

## Static Verification

- `pnpm --filter @cap/ui build` — passed.
- `pnpm --filter @cap/ui lint` — passed.
- `pnpm --filter @cap/web typecheck` — passed.
- `pnpm --filter @cap/web lint` — passed.
- `pnpm --filter @cap/web test -- terminal-input-filter cast-log` — passed, 248 tests.
- `pnpm --filter @cap/api typecheck` — passed.
- `pnpm --filter @cap/api lint` — passed.
- `pnpm --filter @cap/api test -- snapshot` — passed.

## Live Browser Verification

### 20k-line task

Task: `8af9ee29-5f49-4ba4-832c-3c6799215ca3`

Playwright verified:

- Refresh lands at the latest tail (`XTERM-SLOW-VERIFY-20000-DONE` visible).
- Body has no `0;276;0c` pollution.
- Wheel scroll moves up, remains away from bottom, and visible rows change.
- Keyboard input marker is visible in the page and captured in tmux.
- Browser console errors: none.

Screenshot: `/tmp/xterm-verify-8af9ee29-full.png`

### Infinite-output task

Task: `ad5b01bd-999f-4540-9417-9081c8f2fb07`

Playwright verified:

- `XTERM-INFINITE-REFRESH-LINE` output is visible.
- Output changes while the page remains open.
- Wheel scroll is possible during continuous output.
- Visible rows change after scrolling.
- Browser console errors: none.

## Requirement Mapping

- Fresh reconnect rebuilds scrollback: covered by `snapshot.spec.ts` and 20k-line refresh verification.
- Reconnect reveal skips intermediate flashes: covered by queued hidden replay implementation and 20k-line refresh verification landing at tail.
- Live scrollback remains usable while running: covered by 20k-line scroll verification and infinite-output scroll verification.
- Terminal-generated responses are not forwarded: covered by `terminal-input-filter.test.ts` and live absence of `0;276;0c`.
- Stale bridge input recovery: covered by live marker reaching tmux after re-adoption/reconnect.
