## Context

`session-terminal-replay` (v0.4.0) records each task's terminal to a per-task
asciicast v2 `session.cast` and, in the 终端回放 tab, plays it back frame-by-frame on
its recorded clock (`session-cast-player.tsx` + the `cast-playback.ts` rAF engine, with
play/pause/seek/speed). Timing playback was made mandatory because codex's terminal is
a full-screen **alternate-screen-buffer** TUI (codex inside tmux): a continuous dump
lands only on the final frame, since the alt-buffer has no scrollback.

Operators have asked for the opposite interaction: **not** a player, but a one-shot,
direct, scrollable display of the **entire** terminal history (the cast/terminal
画面 — explicitly not the rollout). A spike against a real production cast (task
`532d77f3-…`, see `research-brief.md`) found a cheap, robust way to get exactly that.

## Goals / Non-Goals

**Goals:**
- 终端记录 tab opens straight to the **full** recorded terminal history, laid out
  top-to-bottom, scrollable, read-only — no play/seek/wait.
- Reuse the shipped pieces: the cast fetch (`getSessionCast`), the asciicast parse, and
  the project's own xterm (`@cap/ui <Terminal>`).
- Faithful to what codex actually **displayed** (ANSI colors, layout), reconstructed in
  order.

**Non-Goals:**
- No timing playback / transport controls (this change removes them).
- No back-end change — recording and `GET /tasks/:id/cast` stay exactly as they are.
- Not trying to surface codex's `… +N lines (ctrl + t)`-collapsed output; those were
  never drawn to the terminal and live only in the rollout (对话记录 tab).
- Not touching `session.log`, the live WS/PTY/write-lease path, or the rollout tab.

## Decisions

### D1 — De-animate via xterm's own scrollback (run the cast in the NORMAL buffer)

Feed the recorded stream to a read-only xterm **with the alternate-screen switch
suppressed** (strip `?1049h/l`, `?1047h/l`, `?47h/l`). In the normal buffer, xterm feeds
its scrollback whenever a top-anchored scroll occurs; codex/tmux scroll their content
with top-anchored regions (`1;N`) + `SU`, so xterm's scrollback engine reconstructs the
linear history for free. Render the resulting buffer (scrollback + viewport) statically
with the native scrollbar.

Spike result on the real cast: **52 scrollback lines** (53 non-empty content lines) with
alt stripped, vs **6** (18 lines) when kept — and the stripped output reads as a coherent
top-to-bottom session log.

- **Alternatives considered:**
  - *Hand-written VT simulation + frame-diff to emit lines as they leave the scroll
    region* — maximal control but heavy and fragile (must dedupe spinner ticks, the
    pinned status bar, partial repaints). Rejected: xterm already does this correctly.
  - *Final-frame-only static render (drop controls, show end state)* — trivial but is
    NOT "all history" (you'd lose everything before the last frame). Rejected: misses
    the intent.
  - *Render the rollout as a terminal-styled static log* — clean & complete, but the
    user explicitly wants the terminal 画面/cast, not the rollout. Rejected per intent.

### D2 — Apply resize events; preserve everything except the alt-screen switch

Process events in recorded order: `r` → `term.resize(cols, rows)`; `o` → strip
alt-screen control sequences, write the data. DECSTBM scroll regions, cursor addressing,
clears, and `SU` are **preserved** — they are exactly what drives the scrollback feed.
Only the alternate-screen enter/exit is removed. Resize is applied so geometry and
scroll math match the recording (the cast resizes 80×24 → 115×18 early).

### D3 — One-shot fill, no rAF; large scrollback

Write the whole de-alt'd stream as fast as possible (no per-event delay), with a large
scrollback cap so long sessions are retained. On completion, position the view at the
**top** (start of the session) so the operator reads forward chronologically.

- **Alternative:** start at the bottom (terminal convention, final answer first).
  Rejected as default because the feature is "read the history"; trivially flippable.

### D4 — New component, delete the player

Add `components/session/session-cast-log.tsx` (read-only static xterm + alt-strip +
bulk write). `session-replay.tsx` renders it in the terminal tab. **Delete**
`session-cast-player.tsx` and `cast-playback.ts` (+ `cast-playback.test.ts`) — the rAF
timing engine and its pure helpers become dead. The asciicast parse/endpoint contracts
in `@cap/contracts` stay (still used to fetch + read the header for sizing).

If `@cap/ui <Terminal>` cannot do a read-only one-shot bulk write with a configurable
scrollback, extend it minimally (e.g. a `scrollback` option + an imperative `write`
already exposed via its handle) rather than instantiating a second raw xterm.

### D5 — Rename the tab 终端回放 → 终端记录

It is no longer a "replay". 终端记录 pairs with the existing 对话记录 tab. Meta-line
text ("…/终端为中断画面") stays accurate.

## Risks / Trade-offs

- **Sub-region scrolls (region top > 1) don't feed scrollback** → those few lines (≈18
  of 173 region sets in the sample) can be lost. → Accept; dominant scrolling is
  top-anchored, and the reconstructed log is coherent. Documented in the spec Notes.
- **Redraw fragments** (a reasoning line split mid-scroll appears twice/partially) →
  cosmetic. → Accept; no post-processing in scope.
- **Pinned bottom UI** (codex input box + tmux status bar) appears once as the trailing
  lines → expected end-of-session frame; harmless.
- **Very long sessions exceed the scrollback cap** → oldest lines drop, like a real
  terminal. → Set a generous cap; document the bound.
- **Alt-strip split across chunk boundaries** → a control sequence cut between two cast
  events could survive stripping. → The alt switch is a single short early sequence (not
  split in practice); strip on per-event data is sufficient, but the implementation
  SHOULD be resilient (e.g. strip on the data actually written) and a unit test asserts
  the alt-buffer is never entered.
- **xterm scrollback semantics are load-bearing** → pin behavior with a test using
  `@xterm/headless` that asserts a fixture cast yields materially more content lines with
  alt stripped than kept (the spike, as a regression guard).

## Migration Plan

- Front-end only. Ship via the normal web deploy (Vercel on merge to main).
- No data migration: existing `session.cast` files render unchanged (same format).
- Rollback: revert the front-end change; the back-end (recording + endpoint) was never
  touched, so old and new front-ends both work against the same casts.

## Open Questions

- Initial scroll position default — **top** (chosen). Confirm during review if bottom is
  preferred.
- Whether to add a "copy all" / download affordance for the flattened text (deferred;
  out of scope unless asked).
- Whether to cross-link the `… +N (ctrl + t)` ceiling to the 对话记录 tab in-UI
  (deferred; documented as a known ceiling for now).
