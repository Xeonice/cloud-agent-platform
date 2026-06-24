# Design

## Context

The running live terminal can't scroll: codex runs `--no-alt-screen` inside a detached tmux session,
and the tmux `attach` CLIENT enters the alternate screen to render its UI → the PTY stream is
alt-screen → the live xterm enters its non-scrollable alternate buffer. v0.20.5's approach A (tmux
window `alternate-screen off`) was measured ineffective (the option governs the pane program, not the
client's attach alt-screen). The 终端记录 replay scrolls because it `stripAltScreen`s the cast; the
live path must do the same to its `onRaw` bytes.

## Goals / Non-goals

- **Goal:** the RUNNING live terminal accumulates scrollback and is scrollable, by stripping the
  alt-screen switch from the live stream so it lands in the normal buffer (+ the shipped viewport sync).
- **Non-goal:** the tmux survival architecture; codex `--no-alt-screen` (keep); the 终端记录 replay.
  Not trying to suppress the tmux client's alt-screen at the tmux layer (proven untouchable via options).

## Decisions

**D1 — A failed; the alt-screen is the tmux client's, measured.** task 50366a73 (v0.20.5): window
`alternate-screen off` applied yet live buffer `alternate`. The `alternate-screen` window option only
governs the pane program; the attach client's own alt-screen is not controllable by it. So strip at
the consumer (front-end), where the 终端记录 path already proves stripping works.

**D2 — Strip in `onRaw` before write.** `session-terminal.tsx` `onRaw(bytes)` removes the alt-screen
switch before `handle.write`, mirroring `cast-log.ts`'s `stripAltScreen`. Output then accrues in the
normal buffer; combined with the shipped `syncViewportSoon`, the live terminal scrolls.

**D3 — UTF-8 safety: strip at the BYTE level (preferred).** Live bytes are `Uint8Array`; a naïve
per-chunk `TextDecoder().decode()` splits multi-byte (Chinese) codepoints at chunk boundaries into
mojibake (my 87d53fb1 hook only escaped this by being pure-ASCII). Strip the fixed ASCII switch
sequences (`\x1b[?1049h`, `?1049l`, `?1047h/l`, `?47h/l`) at the byte level and pass the (still
`Uint8Array`) result to `handle.write`, letting xterm do its own stateful UTF-8 decode. This avoids any
double-decode hazard and keeps the write path byte-native. (Alternative: a per-socket stateful
`TextDecoder({stream:true})` → string → `stripAltScreen` → write — also UTF-8-safe but adds a decode on
the hot path and changes write to string. Prefer byte-level.)

**D4 — Keep the shipped viewport sync.** `syncViewportSoon` (v0.20.5) is still required — xterm doesn't
auto-sync the viewport as the buffer accrues. No change there.

**D5 — Remove the ineffective tmux off.** Revert v0.20.5's `set-window-option alternate-screen off`
appendage in `codex-launch.ts` (and its test assertions) — it does nothing and misleads. Keep codex
`--no-alt-screen` (that part is correct/independent).

## Risks / Trade-offs

- **Switch split across chunk boundary.** A switch sequence split between two `onRaw` chunks would not
  be stripped (it's matched within one chunk). Benign + rare (the tmux client's `?1049h` arrives intact
  at attach; same limitation `cast-log` accepts). If observed, buffer a few trailing bytes across calls.
- **Stripping the tmux client's alt-screen → its UI renders in the normal buffer.** With a single codex
  pane and tmux status off, this is just codex's output scrolling (verified on 87d53fb1). Re-verify on
  deploy that nothing (status bar / borders) renders oddly.
- **Hot-path cost.** Byte-level scan per chunk is cheap (a short fixed-needle search); far less than a
  full decode.

## Migration

None (front-end live strip + removing an inert backend tmux option).
