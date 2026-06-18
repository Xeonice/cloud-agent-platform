# Research Brief — static-terminal-log

Side-car (not a tracked artifact). Captures the empirical grounding gathered during
`/opsx:explore` before this proposal, using a **real production cast** (task
`532d77f3-…`, 370 KB, 1753 events, 96.9 s — recorded by the live v0.4.1 backend and
pulled to `/tmp/cap-532d.cast`).

## The gap

The shipped `session-terminal-replay` (v0.4.0) plays the cast frame-by-frame on its
recorded clock (play/pause/seek/speed). The user does **not** want playback — they
want a **one-shot, direct, full display of all history**, scrollable, for the terminal
画面 (the cast source, NOT the rollout/对话记录). And they want it to **replace** the
timing player.

## Why "just dump it all at once" naïvely fails (the original constraint)

codex's terminal stream is a **full-screen alternate-screen-buffer TUI** (here, codex
running inside tmux). Control-sequence census of the real cast:

| sequence | count | meaning |
|---|---|---|
| `?1049h` enter alt-buffer | **1** (t=1.47s) | enters alt once, **never exits** (session was interrupted) |
| `?1049l` exit alt | 0 | — |
| cursor-address `[r;cH` | 7711 | full-frame cursor-addressed repaint |
| erase-line `[K` | 5818 | in-place line redraw |
| DECSTBM scroll region `[t;br` | 173 | **mostly top-anchored** (`1;18`×74, `1;12`×36, `1;10`×23, `1;17`×16) |
| scroll-up `SU [S` | 36 | scrolls content within the region |
| resize | 1 | 80×24 → **115×18** |

The alt-buffer has **no scrollback**: every repaint overwrites the same region, so a
continuous dump lands only on the final frame. (Layout: 115×18; rows ~15–18 are the
fixed input box + tmux status bar `[task532d70…]`; codex content scrolls in the top
region.)

## Key finding — xterm's own scrollback de-animates it, IF run in the normal buffer

Spike with the project's shipped `@xterm/headless`, feeding the full real cast two ways
(`/tmp/cast-flatten-spike.mjs`):

| run | scrollback lines | non-empty content lines | what you see |
|---|---|---|---|
| **alt-buffer kept** (= naïve dump) | 6 | 18 | only the final frame |
| **alt-buffer enter/exit stripped** | **52** | **53** | the **whole session flow**, in order |

Mechanism: in the **normal** buffer xterm feeds scrollback whenever a top-anchored
scroll occurs (scrollTop===0). codex/tmux scroll their content with top-anchored
regions (`1;N`) + `SU`, so stripping the single alt-buffer switch makes xterm's own
scrollback engine reconstruct the linear history — **no hand-written VT simulation, no
frame-diffing needed.**

The stripped output reads as a coherent top-to-bottom log: codex reasoning → `Explored`
(Search/List/Read) → `Ran wc -l …` (with counts) → final answer (root file list, 项目
概况, 主要结构) → the input box + status bar as the last frame. Artifacts are cosmetic:
an occasional redraw fragment (a reasoning line split by a mid-scroll), and the pinned
bottom UI appearing once at the end.

## Honest ceiling (applies to ANY terminal-sourced view)

codex collapses long tool output in its TUI as `… +N lines (ctrl + t to view
transcript)`. Those lines were **never drawn to the terminal**, so neither replay nor
this flatten can show them — only the **rollout** (the 对话记录 tab) has the complete
tool output. The terminal view's "all" = everything codex actually *displayed*.

## Approach chosen (de-risked)

**B-emulator**: fetch the cast (unchanged endpoint), strip alt-buffer enter/exit, apply
resize events, write the whole stream into a read-only xterm with a large scrollback,
render it static with the native scrollbar — no rAF, no transport controls. Reuses the
cast fetch + `@cap/ui <Terminal>`; deletes the timing engine (`cast-playback.ts`) and
the player (`session-cast-player.tsx`). Recording + endpoint untouched.

Repro: `/tmp/cast-analyze.py`, `/tmp/cast-regions.py`, `/tmp/cast-flatten-spike.mjs`
(node at `~/.local/share/fnm/node-versions/v22.22.0/installation/bin/node`).
