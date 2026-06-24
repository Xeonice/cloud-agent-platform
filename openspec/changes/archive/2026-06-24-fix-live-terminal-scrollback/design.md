# Design

## Context

codex runs inside a detached named tmux session (survive-api-redeploy); the pty client attaches to it.
codex launches with `--no-alt-screen` (fix #2), so codex itself is inline — but the attached tmux
client renders the pane in the ALTERNATE screen, so the PTY byte stream the browser receives is
alt-screen. The live xterm (`session-terminal.tsx` `onRaw` → `handle.write(bytes)`) therefore enters
its alternate buffer (no scrollback) and can't scroll. The 终端记录 replay scrolls because it
`stripAltScreen`s the cast; the live path doesn't. Measured: stripping the live stream → buffer
accumulates scrollback (baseY 8→45); a resize nudge → viewport syncs (canScroll true, history visible).

## Goals / Non-goals

- **Goal:** the RUNNING live terminal accumulates scrollback and the operator can scroll up to earlier
  output, for every task that goes through tmux.
- **Non-goal:** changing the detached-tmux survival architecture; changing codex `--no-alt-screen`
  (keep it); the 终端记录 replay (already fixed). Not reworking the snapshot/reconnect protocol.

## Decisions

**D1 — Root cause is tmux's alternate screen, not codex (measured).** c8928769's codex argv has
`--no-alt-screen` yet the live buffer is `alternate`; the alt-screen comes from the tmux attached
client. So the fix targets tmux's rendering / the live stream, not codex.

**D2 — Preferred: tmux `alternate-screen off` (root cause, backend, one place).** Set
`alternate-screen off` on the session (e.g. `tmux set-option`/`set-window-option` after `new-session`,
or via a tmux config the launch references) so the attached client renders the pane in the normal
buffer with scroll-up — the PTY stream becomes normal-buffer + scroll-up, and the live xterm
accumulates scrollback with no per-byte front-end work. Covers interactive + headless uniformly.
MUST be verified on apply (tmux off can change how a full-screen pane renders; codex is already
`--no-alt-screen` inline so the pane content is line-oriented, which is the favorable case).

**D3 — Fallback: front-end strip (already grounded-verified).** If tmux `alternate-screen off` proves
problematic, strip in `session-terminal.tsx` `onRaw`: the live bytes are `Uint8Array` (the cast is a
string), so decode → `stripAltScreen` → `write`. Verified live (87d53fb1): baseY accumulated, scroll
worked after a viewport sync. Downside: per-chunk decode + a TextDecoder on the hot path, and it only
masks the tmux alt-screen rather than removing it.

**D4 — Viewport sync is required either way.** Measured: even once the buffer accumulates scrollback,
`.xterm-viewport.scrollHeight` lags `clientHeight` until a `syncScrollArea` is triggered (same class of
issue as the 终端记录 viewport-sync fix). On the LIVE stream this must fire as output arrives —
DEBOUNCED (e.g. on a short timer after writes settle, or on the flush callback) to avoid per-chunk
resize nudges that would flicker/cost. The trigger keeps `cols` unchanged (no wrap reflow).

**D5 — Apply order: try D2 first, fall back to D3.** D2 is the clean root-cause fix; prove it on a
running task in Chrome (live buffer becomes `normal`, baseY accumulates, canScroll true, codex output
still renders correctly). If it regresses codex rendering, switch to D3. D4 ships regardless.

## Risks / Trade-offs

- **tmux `alternate-screen off` rendering (D2).** A full-screen TUI in the pane would render poorly
  without the alt screen — but codex is `--no-alt-screen` (inline/line-oriented), so the pane is the
  favorable case. Verify on apply; D3 is the safety net.
- **Debounce tuning for viewport sync (D4).** Too eager → flicker/cost; too lazy → the scrollbar lags
  live output. A short settle timer after writes is the target; keep it a named constant.
- **Front-end strip hot path (D3, if used).** Decoding every `Uint8Array` chunk to strip adds work on
  the live stream; acceptable but another reason to prefer D2.

## Migration

None. Backend tmux option (D2) applies to newly launched/attached sessions; existing running sessions
pick it up on next launch. No DB/contract change.
