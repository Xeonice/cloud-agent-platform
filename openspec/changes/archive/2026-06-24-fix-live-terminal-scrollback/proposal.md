# Fix: live terminal can't scroll back — tmux renders the pane in the alternate screen

## Why

The running live terminal can't scroll up to see earlier output. The WebSocket already carries the full
codex output (the operator is right: "it's all there in the websocket"), but the live xterm sits in the
ALTERNATE buffer (which has no scrollback), so it can't scroll.

Root-cause chain, established by live measurement:

- codex launches with `--no-alt-screen` (fix #2 took effect — codex itself is inline). Verified on
  c8928769: its argv is `codex --no-alt-screen -C …`.
- **But codex runs inside a detached tmux session** (survive-api-redeploy), and **tmux's attached
  client renders the whole pane in the alternate screen** → the PTY stream is alt-screen → the live
  xterm enters the alternate buffer → no scrollback → can't scroll.
- This is tmux, NOT codex, and it affects ALL tasks (both interactive-pty console tasks and
  headless-exec MCP/`/v1` tasks go through tmux). fix #2 fixed codex but tmux's alt-screen overrides it.

Grounded verification (running task 87d53fb1): stripping the alt-screen switch from the live stream
made the buffer accumulate scrollback (baseY 8 → 45 as codex kept outputting), and a viewport sync
(resize nudge) made `canScroll` true and scrolling to the top revealed the earlier history ("npm error
Invalid: lock file's…"). So the data is all present and two steps fix it.

Contrast with the 终端记录 replay (which already scrolls): it `stripAltScreen`s the cast to rebuild
scrollback. The LIVE stream never strips — the only difference.

## What Changes

- **Make the PTY stream land in the NORMAL buffer (no alternate screen)** so the live xterm accumulates
  scrollback:
  - Preferred (root cause): tmux `alternate-screen off` for the session — the attached client stops
    using the alternate screen, so the pane scrolls (scroll-up) into the client's scrollback instead of
    redrawing an alt screen. One backend change, covers every task.
  - Fallback (already grounded-verified): front-end `onRaw` decodes the bytes (they are `Uint8Array`,
    unlike the cast's string) and `stripAltScreen`s before `write`.
- **Sync the viewport on the live stream** so `.xterm-viewport` reflects the accumulated scrollback
  (measured: the buffer accumulates but the viewport scrollHeight lags — needs a `syncScrollArea`
  trigger; debounced to avoid per-chunk flicker).
- **Keep codex `--no-alt-screen` (fix #2)** — codex being inline is still needed alongside the tmux fix.

## Impact

- Affected spec: `realtime-terminal` (the live terminal accumulates scrollback and is scrollable up
  through history while running).
- Affected code: backend tmux launch (`codex-launch.ts` / `aio-pty-client.ts` — `alternate-screen off`),
  OR front-end `session-terminal.tsx` `onRaw` (decode + strip); plus front-end viewport sync.
- Affects every task's live terminal (interactive + headless). No DB / contract change.
