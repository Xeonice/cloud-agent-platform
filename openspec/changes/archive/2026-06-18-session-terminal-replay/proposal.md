# Session Replay (terminal tab — asciicast recording + xterm timing player)

## Why

The session-replay view's 「终端回放」 tab is still a dead placeholder ("终端回放待接入"). This change wires it. An empirical probe (rendering a real codex `session.log` in headless xterm) established the hard constraint: **codex's TUI is a full-screen alternate-screen-buffer application** — the entire session (thinking / working / tool output) is redrawn inside the alt-buffer and does NOT accumulate scrollback; a continuous dump of the whole recording yields only a near-empty startup-banner screen. So the replay MUST be **timing-driven** (frame-by-frame on the recorded clock), like a screen recording. We record the terminal to a per-task **asciicast v2** file (which carries the timing) and replay it with **our own xterm** plus a small timing player — the SAME renderer the live terminal already uses to render codex's alt-buffer TUI, so the replay and the live terminal share one rendering stack (NOT asciinema-player). The 「对话记录」 tab already renders the codex rollout (the structured conversation source) and is unchanged.

## What Changes

- Add a per-task **asciicast v2** recording `session.cast`. The gateway, in its EXISTING PTY-output hook, writes the header once and one `[time, "o", data]` event per chunk (plus `[time, "r", "COLSxROWS"]` on resize). `session.log` is left unchanged.
- Add a read endpoint (`GET /tasks/:id/cast`) that returns a finished task's `session.cast`.
- Swap the 「终端回放」 placeholder for a read-only xterm + **timing player**: parse the cast, schedule each event on its recorded `time` (`o`⇒`write`, `r`⇒`resize`), with play/pause, a seekable progress bar, and speed control. Rendered by **our own xterm** (unified with the live terminal), NOT asciinema-player.

**Out of scope**: oversized-cast handling/truncation, `session.log` retention cleanup, asciinema-player, and re-working the existing rollout-backed 「对话记录」 tab.

## Impact

- **API** (`apps/api`): gateway PTY-output hook also writes `session.cast` (asciicast v2, best-effort, `session.log` untouched); a new read endpoint; `SnapshotManager` gains `cols`/`rows` getters + a `SESSION_CAST_FILENAME` constant.
- **Web** (`apps/web`): `session-replay.tsx` 终端回放 tab becomes an xterm timing player (`session-cast-player.tsx` + pure `cast-playback.ts`), reusing the live terminal's `@cap/ui <Terminal>` + theme; `real.ts` gains `getSessionCast`.
- **UI** (`packages/ui`): `TerminalHandle` gains a `resize(cols,rows)` method.
- **Contracts** (`packages/contracts`): asciicast v2 header + event shapes + parse helpers.
- **Untouched**: `session.log`, the live WebSocket / PTY / write-lease path, the rollout-backed 「对话记录」 tab.
