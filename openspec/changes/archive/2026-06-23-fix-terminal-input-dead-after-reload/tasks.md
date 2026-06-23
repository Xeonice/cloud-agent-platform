# Tasks

> Two wide-viewport live-terminal defects, both reproduced in Chrome (Browser 2, 1728px):
> (#1) the `xtermFailed` watchdog (4s) mis-fires on slow/wide xterm init and a late `onReady` never
> clears it → stuck on the read-only fallback → input "does nothing"; (#2) codex runs in the alternate
> screen (no scrollback by spec) → the live terminal can't scroll up. (The earlier "onData unwired"
> hypothesis was a `computer type` automation artifact and is retracted.)

## 1. Track: recover + tolerate the xterm fallback (fix #1)

- [x] 1.1 `apps/web/src/components/session/session-terminal.tsx` — on xterm `onReady`, ALSO clear the failed state (`setXtermFailed(false)`), so a late-but-successful xterm replaces the read-only fallback. DONE — but the FIRST attempt was a no-op (the fallback/Terminal sibling-ternary unmounted `<Terminal>` when failed, so `onReady` never fired); fixed for real by the always-mounted-`<Terminal>` + fallback-overlay restructure (see V.1).
- [x] 1.2 Raise `XTERM_READY_TIMEOUT_MS` from `4000` to `15_000` so a large wide-viewport terminal's slow `open`/`fit` is not declared failed; kept the `if (!handleRef.current)` guard. DONE (paired with 1.1 recovery → over-budget-but-eventually-ready terminal self-heals).

## 2. Track: codex inline scrollback (fix #2)

- [x] 2.1 Add `--no-alt-screen` to the SINGLE codex launch argv so the TUI runs INLINE (normal buffer) and the live xterm keeps a scrollable history: `apps/api/src/agent-runtime/codex-runtime.ts` `CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV` (runtime source), `apps/api/src/terminal/aio-pty-client.ts` `DEFAULT_CODEX_LAUNCH_ARGV` (mirrored default), `docker/aio-sandbox.Dockerfile` baked `CODEX_LAUNCH_ARGV` (consistency). DONE.
- [x] 2.2 Update the two tests asserting the codex argv string (`codex-launch.test.mjs` `BASE`, `agent-runtime.test.mjs` argv assertion) to include `--no-alt-screen`; confirmed `argvDisablesHooks` still false. DONE — api typecheck clean + 432 tests green.

## 3. Track: CPR/DA leak — DEFERRED to a separate follow-up

- [ ] 3.1 (DEFERRED — out of scope here) The CPR/DA query response (`;276;0c`-style) echoed as visible text on reconnect is an independent, cosmetic bug whose root sits in the codex/PTY DSR-CPR handshake layer (`aio-pty-client.ts`), NOT this change. Tracked as a separate follow-up.

## 4. Track: verify on the wide viewport (acceptance gate — POST-DEPLOY)

- [ ] 4.1 After deploying api + web, reproduce + verify in Chrome on the wide viewport (Browser 2, ~1728px): (#1) N consecutive reloads each render the real xterm (`hasXtermDom: true`, no 「降级为文本视图」) and accept typing; (#2) once codex produces >1 screen, the live terminal scrolls up through earlier output (`canScroll: true`). Watch for codex issue #18528 (some terminals can't scroll even with `--no-alt-screen`) — confirm OUR xterm does.
- [x] 4.2 Local guards: `apps/web` typecheck + 232 tests green (fix #1); `apps/api` typecheck + 432 tests green (fix #2). DONE.

## Track: verify-reopened (depends: none)

- [x] V.1 FIXED. The recovery was structurally unreachable: `showFallback ? <fallback> : <Terminal>` UNMOUNTED `<Terminal>` when the watchdog flipped `xtermFailed`, so its cleanup set `disposed = true` and the in-flight async xterm init hit `if (disposed) return` — the late `onReady` never fired, making `setXtermFailed(false)` a no-op (exactly as opsx-verify's adversarial trace found). **Restructured `session-terminal.tsx`**: `<Terminal>` is now ALWAYS mounted (when `theme` is ready); the read-only fallback renders as an ABSOLUTE OVERLAY (`absolute inset-0 z-20`) on top while `xtermFailed`. So a slow/wide xterm keeps initializing UNDER the overlay, its late `onReady` DOES fire → `setXtermFailed(false)` → overlay drops → the real xterm self-heals into view (the spec's required recovery). typecheck clean + web 232 tests green. **Regression-test NOTE:** "a late onReady recovers" is a React-DOM render+timing behavior; apps/web's vitest runs in the `node` env with NO DOM / NO `@testing-library/react` (repo convention = pure-logic seam tests, see `api.test.ts`'s own note), so it cannot be unit-tested as a render — it is covered by the post-deploy wide-viewport live verification (4.1).
