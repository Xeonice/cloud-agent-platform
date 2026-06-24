# Tasks

> v0.20.5's approach A (tmux window `alternate-screen off`) FAILED in production (measured task
> 50366a73: window option `off` applied yet live buffer still `alternate`). The alt-screen is the tmux
> ATTACH CLIENT's own — the window option only governs the pane program, not the client. Fall back to B
> (front-end strip), grounded-verified on 87d53fb1 (baseY 8→45 after stripping). Keep the shipped
> viewport sync + codex `--no-alt-screen`; remove the inert tmux off.

## 1. Track: strip the alt-screen on the live stream (B)

- [x] 1.1 `cast-log.ts` adds `stripAltScreenBytes(Uint8Array)` (byte-level, UTF-8-safe via 1:1 `String.fromCharCode` — NOT `TextDecoder("latin1")` which is windows-1252 and would remap 0x80–0x9F; reuses `stripAltScreen`'s regex); `session-terminal.tsx` `onRaw` calls `handle.write(stripAltScreenBytes(bytes), …)` so the tmux client's alt-screen switch is removed and the live stream lands in the normal buffer. DONE.
- [x] 1.2 Removed the inert tmux off: reverted v0.20.5's `; tmux set-window-option … alternate-screen off` in `codex-launch.ts` (`wrapInDetachedSession` + `wrapHeadlessDetachedSession`) and the matching test assertions (codex-launch golden + headless-execution sentinel `$`-anchor restored). Kept codex `--no-alt-screen`. DONE.

## 2. Track: verify (acceptance gate)

- [x] 2.1 `apps/web` typecheck clean + 240 tests green (incl. 4 new `stripAltScreenBytes` tests: strips the switch, returns same array when absent, doesn't corrupt Chinese alongside the switch, preserves raw multi-byte codepoint bytes — no decode split). `apps/api` typecheck clean + 432 tests green (after reverting 1.2's test changes). DONE.
- [ ] 2.2 Live verify (POST-DEPLOY) in Chrome on the wide viewport: open a RUNNING task; the live buffer is `normal` (not `alternate`), baseY accumulates as codex outputs, the live terminal is scrollable to the top of history WITHOUT manual interaction (viewport sync), codex output renders correctly (incl. any Chinese — no mojibake), and new output keeps appending with the scrollbar tracking it.
