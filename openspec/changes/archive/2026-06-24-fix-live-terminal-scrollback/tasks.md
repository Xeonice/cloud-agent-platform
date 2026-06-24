# Tasks

> Live-measured root cause: codex runs `--no-alt-screen` (fix #2, verified on c8928769) but inside a
> detached tmux session whose attached client renders the pane in the ALTERNATE screen → PTY stream is
> alt-screen → live xterm enters the alternate buffer (no scrollback) → can't scroll. Affects ALL tasks
> (interactive + headless go through tmux). Strategy (user-chosen): try A (tmux off, root cause) with a
> deploy verify; fall back to B (front-end strip, already grounded-verified on 87d53fb1) if A regresses.

## 1. Track: make the live PTY stream normal-buffer (root cause = A)

- [x] 1.1 `apps/api/src/terminal/codex-launch.ts` — `wrapInDetachedSession` + `wrapHeadlessDetachedSession` append `; tmux set-window-option -t <session> alternate-screen off` after `new-session`, session-scoped (NOT `-g`, so the AIO sandbox's own tmux sessions are untouched). Keeps codex `--no-alt-screen`. Tests updated (codex-launch golden + headless-execution sentinel assertion); api typecheck clean + 432 tests green. DONE.
- [ ] 1.2 Deploy + verify A on a RUNNING task in Chrome (POST-DEPLOY): live buffer becomes `normal` (not `alternate`), baseY accumulates, and with 2.1's viewport sync the live terminal is scrollable (canScroll true) WITHOUT manual interaction; codex output still renders correctly. If A regresses codex rendering, fall back to 1.3 (B).
- [ ] 1.3 Fallback (only if 1.2 shows A regresses codex rendering) — front-end strip in `session-terminal.tsx` `onRaw`: decode the `Uint8Array` bytes and `stripAltScreen` before `write` (grounded-verified on 87d53fb1).

## 2. Track: live viewport sync (REQUIRED — opsx-verify VR.1: spec SHALL, unconditional)

- [x] 2.1 `session-terminal.tsx` — live viewport scroll-area sync implemented (opsx-verify VR.1 corrected the conditional gating; the spec scenario is unconditional, and the B experiment already showed the live stream does NOT auto-sync). `syncViewportSoon` runs on the `onRaw` flush callback, DEBOUNCED (`VIEWPORT_SYNC_DEBOUNCE_MS` = 120ms) so the bursty stream isn't per-chunk; it triggers `syncScrollArea` via a LOCAL-ONLY resize nudge (`cols` unchanged → no wrap reflow; `rows` +1 then back) with `suppressResizeRef` making `onResize` skip `sendResize` so the codex PTY is NOT perturbed. Timer cleaned up on socket teardown. web typecheck clean + 236 tests green. DONE.

## Track: verify-reopened (depends: none)

- [x] VR.1 RESOLVED — live viewport sync implemented (see 2.1). `syncViewportSoon` (debounced, local-only resize nudge with `sendResize` suppressed) runs on the `onRaw` flush callback, so `.xterm-viewport.scrollHeight` reflects the accumulating buffer and updates as live output arrives. No longer gated behind post-deploy observation; ships unconditionally per the spec SHALL + design D4. web 236 tests green.

## 3. Track: verify (acceptance gate)

- [x] 3.1 `apps/api` typecheck + 432 tests green (1.1); `apps/web` typecheck + 236 tests green (2.1). DONE.
- [ ] 3.2 Live verify (POST-DEPLOY) in Chrome on the wide viewport: open a RUNNING task; while codex outputs multiple screens, the live terminal accumulates scrollback and the operator can scroll up to the top of history WITHOUT manual interaction (`.xterm-viewport` canScroll true, buffer type `normal`); codex output renders correctly; new output keeps appending and the scrollbar tracks it.
