# Session Replay (terminal tab — asciicast + xterm timing player) — Design

## Context

`SessionReplay` renders a two-tab head for a finished task: 「对话记录」 (wired, from the codex rollout) and 「终端回放」 (a dead placeholder). This change wires the terminal tab.

**Empirical finding (the hard constraint — measured, not assumed).** We rendered a real codex `session.log` (sd-pdk0jt, 122 KB) in a headless xterm and inspected the buffers at several progress points:

| through the session | active buffer | non-empty lines |
|---|---|---|
| 30% | alternate | 15 |
| 70% | alternate | 29 (content: "Thinking", "Working (Esc to interrupt)", "Exploring the repo"…) |
| 95% | alternate | 31 |
| 100% (full dump) | **normal** | **12 — only the startup banner** |

Conclusion: **codex's TUI is a full-screen alternate-screen-buffer app.** The whole session lives in the alt-buffer (which does NOT accumulate scrollback); on exit it returns to the main screen leaving only the banner. Therefore **a continuous write of the whole cast cannot reconstruct the session** (it lands on a near-empty banner); the replay MUST be **timing-driven** — write events frame-by-frame on the recorded clock so the alt-buffer's evolution is visible over time.

Reused: the live terminal already renders codex's alt-buffer TUI with `@cap/ui <Terminal>` (xterm) — proving xterm handles this; the replay reuses that exact renderer + the `--terminal-*` theme.

## Goals / Non-Goals

**Goals**
- Faithfully replay a finished codex terminal session as it evolved over time, in the 终端回放 tab, with play/pause/seek/speed.
- Record to standard asciicast v2 (carries the timing + geometry); replay with our own xterm, unifying the renderer with the live terminal.

**Non-Goals (cut by decision)**
- asciinema-player (we use our own xterm — unified stack; see D4).
- Oversized-cast truncation, `session.log` retention cleanup, any change to `session.log` / the live path / the rollout-backed 对话记录 tab.

## Decisions

### D1 — Format: asciicast v2 `session.cast`
Per-task asciicast v2 file on the durable volume (co-located with `session.log`). v2 (widest compatibility; v3 tooling still catching up). The format carries everything needed: header `width`/`height` (geometry), `[time,"o",data]` (timing-stamped output), `[time,"r","CxR"]` (resize). `time` is cumulative seconds since start; `data` is a valid-UTF-8 JSON string (NOT base64). The pure line builders live in `cast-writer.ts` (testable in isolation); the contracts package owns the parse side (`parseCast`).

### D2 — Writer: gateway appends asciicast in the existing PTY-output hook
A per-task `sessionCasts` Map (parallel to `sessionLogs`, its OWN tail chain). On session open, write the header once (geometry from `SnapshotManager.cols/rows`, new getters; `startMs` anchors `time`). Per chunk in `onPtyOutput` — AFTER `appendSessionLog`, never touching it or the lockstep — append an `o` event; in `onResize` append an `r` event. `unregisterSession` drops the cast state. Best-effort: failures logged + swallowed, never blocking streaming.

**UTF-8**: verified `onPtyOutput(chunk: string)` receives an already-decoded UTF-8 string (the AioPtyClient decodes the PTY byte stream upstream), so `JSON.stringify(chunk)` yields valid UTF-8 `data` with no split-multibyte risk at this layer. A multibyte round-trip test guards it.

### D3 — Transport: return the full `session.cast`
`GET /tasks/:id/cast` returns the whole cast as `text/plain` (`CAST_CONTENT_TYPE`), behind `APP_GUARD`; 404 (via `findById`) for an unknown task; an absent/empty/unreadable cast degrades to an empty body (200) — the honest "nothing to replay" signal, never 500. The player needs all events up front for the timeline (duration, seek); a normal cast is small (~100 KB).

### D4 — Render: our own xterm + a timing player (NOT asciinema-player)
Mount `@cap/ui <Terminal>` read-only (`onData` omitted) — the SAME renderer the live terminal uses (proven to render codex's alt-buffer TUI), so replay and live share one stack/theme/font. Parse the cast; size the terminal to the header geometry. Drive writes on the recorded clock: a rAF loop advances the play head (× speed) and applies events crossing it via the pure `applyWindow(events, prev, next, idx, handlers)` — `o`: `write`, `r`: `resize`. **Controls**: play/pause, a seekable progress bar, speed (1×/2×/4×). **Seek to T**: the terminal is a state machine (esp. alt-buffer), so `clear()` + `rebuildStateUpTo(events, T)` (fast-replay all events ≤ T), then resume. `@cap/ui` gains a `TerminalHandle.resize(cols,rows)` so the player can match the recording geometry. Timing/seek logic is pure (`cast-playback.ts`) and unit-tested without a canvas.

Why our own xterm, not asciinema-player: unifies the renderer with the live terminal (one theme/font/behavior, no second terminal engine), and the live terminal already proves xterm renders codex's TUI. The cost — writing the small timing loop + player UI ourselves — is modest and was chosen for unification.

### D5 — 对话记录 unchanged (rollout)
The existing 对话记录 tab already renders the structured rollout transcript (the conversation source). This change does not touch it; asciicast has no structured-conversation slot, so the conversation view stays rollout-backed.

### D6 — Empty state: simple and honest
When `session.cast` is absent or empty, the endpoint returns an empty body and the tab shows an honest empty face — never a fabricated frame.

## Risks / Trade-offs

- **alt-buffer**: measured and confirmed; it is precisely WHY playback must be timing-driven. The "scrollable history" idea is dropped; the operator scrubs the timeline instead.
- **Seek cost**: rebuilding state to T = clear + fast-replay of all events ≤ T. For a large cast a far-back seek does more work; acceptable, optimizable later with periodic state snapshots if needed.
- **Redundancy with `session.log`**: the cast records the same terminal bytes. Accepted for the standard format + timing.
- **Player UI is ours to build**: play/pause/seek/speed. Modest; chosen over asciinema-player to unify on xterm.

## Migration Plan

Purely additive: a per-task best-effort gateway append (+ header), a read endpoint, a tab swap, and an additive `TerminalHandle.resize`. No existing route, contract, `session.log`, live path, or 对话记录 tab changes. Pre-feature tasks have no `session.cast` → honest empty face.

## Open Questions

- Seek performance on long casts — measure real `session.cast` sizes/durations; add periodic snapshots only if seek feels heavy.
- Whether `i` (input) events are worth recording — deferred; `o`/`r` suffice to reconstruct the画面.
