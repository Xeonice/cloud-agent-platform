# Fix: live terminal scrollback via stripping the alt-screen from the live stream (A/tmux-off failed)

## Why

v0.20.5 shipped approach A (tmux window `alternate-screen off` + a front-end viewport sync), but **A
failed in production**. Measured on task 50366a73 (running v0.20.5): the task session's window
`alternate-screen off` IS applied (`tmux show-window-options` confirms `off`), yet the live xterm is
still the `alternate` buffer (baseY 0) → can't scroll.

Root cause (corrected): the alt-screen comes from **tmux's `attach` client itself** — the attached
client enters the alternate screen to render its full-screen UI. The `alternate-screen` WINDOW option
only governs the PANE PROGRAM's (codex's) alt-screen forwarding; it cannot disable the tmux client's
own attach alt-screen. A targeted the wrong layer.

```
tmux attach  → the CLIENT enters alt-screen to own the terminal   ← real source; window option can't touch it
   └─ window `alternate-screen off`  → only the pane program's alt-screen   ← what A changed; no effect
```

Approach B (front-end strip) is the fix, grounded-verified on task 87d53fb1: stripping the alt-screen
switch (the tmux client's `?1049h/l`) from the live `onRaw` stream makes the live xterm render into the
NORMAL buffer with scroll-up, accumulating scrollback (measured baseY 8 → 45). Paired with the
already-shipped viewport sync (v0.20.5), the RUNNING live terminal scrolls.

## What Changes

- **Strip the alt-screen on the live stream**: in `session-terminal.tsx` `onRaw`, remove the
  alt-screen switch from the incoming bytes (reuse `stripAltScreen` from `cast-log.ts`) before
  `handle.write`, so the tmux client's alt-screen switch is gone and output accrues in the normal
  buffer. ⚠️ Live bytes are `Uint8Array` (the cast was a string) — strip MUST be UTF-8-safe across
  chunk boundaries (stateful decode, or byte-level strip), or multi-byte (Chinese) output splits into
  mojibake. (My 87d53fb1 hook used a naïve per-chunk decode that happened to be pure-ASCII output.)
- **Keep** the v0.20.5 viewport sync (`syncViewportSoon`) — B needs it too. Keep codex `--no-alt-screen`.
- **Remove the ineffective tmux `alternate-screen off`** added in v0.20.5 (`codex-launch.ts`) — it is
  harmless but does nothing (treats the wrong layer); remove to avoid future confusion.

## Impact

- Affected spec: `realtime-terminal` — MODIFY the scrollable-history requirement: the live stream lands
  in the normal buffer by STRIPPING the alt-screen FROM THE STREAM (front-end), correcting the A-era
  "tmux renders the pane in normal buffer" scenario which proved unachievable (the alt-screen is the
  tmux client's, not the pane's).
- Affected code: `apps/web/src/components/session/session-terminal.tsx` (`onRaw` strip);
  `apps/api/src/terminal/codex-launch.ts` (remove the ineffective tmux off + revert its test changes).
- No DB/contract change.
