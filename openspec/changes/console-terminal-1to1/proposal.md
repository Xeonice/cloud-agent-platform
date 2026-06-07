## Why

The session terminal is not a true 1:1 surface to the sandbox codex TUI. A separate "command input box" plus a 150ms-delayed-carriage-return submit hack mediate operator input. Live byte-capture + adversarially-verified research show the hack's premise is FALSE: TUIs (crossterm/ratatui) detect paste ONLY by the `ESC[200~`/`ESC[201~` markers a terminal adds, NEVER by keystroke timing/batching — so a plain `text\r` is parsed as typing + Enter regardless of how the bytes arrive, and direct xterm typing should submit on Enter with no delay. The command box and the timing hack are therefore redundant; the xterm `onData → sendKeystroke` path already forwards each event verbatim (the canonical ttyd/code-server architecture).

## What Changes

- **Make the live xterm the SOLE input surface.** Delete the `<TerminalCommandInput>` box, the `sendCommand` callback, and the 150ms-delayed-CR `window.setTimeout` hack in `session-terminal.tsx`. The existing `onData` handler already seizes the write lease once per connection then sends each xterm event verbatim (`\r` for Enter, `ESC[A..D` arrows, `\x03` Ctrl-C, `\x7f` backspace; clipboard pastes auto-wrapped in `ESC[200~`/`ESC[201~`).
- **Keep the fallback line-view input.** When xterm fails to mount there is no terminal to type into, so the fallback DOM line-view retains its input row.
- **Add a connection-state affordance.** The command box was the only thing gating input on `connection === "open"`; with it gone, typing into a disconnected/closed socket would be silently dropped (`sendFrame` only sends when OPEN). Add a visible affordance (state overlay / inert cursor hint) so typing into a non-deliverable socket is obviously inert, not mysteriously ignored.
- **Focus the xterm canvas on mount** so keystrokes land in the terminal.
- **GATE the box removal on a live authed verification** that direct typing's Enter actually submits and reproduces/explains the original "no effect" symptom (the timing theory was wrong, so the real cause — composer readiness, lease, or socket-open — must be confirmed before deleting the only working input).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `frontend-console`: the **Session page renders the live terminal and controls** requirement changes from "a keystroke/command input" to **direct 1:1 keystroke input typed straight into the live `<Terminal>` as the sole live-terminal input surface** (no separate command-input box, no delayed-CR submit hack), with a connection-state affordance for non-deliverable sockets; the fallback line-view (xterm unavailable) retains its input row.

## Impact

- **Code:** `apps/web/src/components/session/session-terminal.tsx` only (remove `TerminalCommandInput` render + `sendCommand` + the 150ms `setTimeout`; focus xterm in `onReady`; connection-state affordance). The `TerminalCommandInput` component may remain for the fallback view.
- **No backend change:** byte passthrough is already correct — `aio-sandbox-execution` forwards operator keystrokes as `{type:"input"}`; `write-lock-and-takeover` keystroke lease-gating is unchanged (the `onData` path already does takeover-on-first-keystroke).
- **xterm `^5.5.0`:** ignores codex's synchronized-output (DEC mode 2026, lands in xterm 6.0.0), so codex's full-grid repaints may FLICKER — cosmetic, NOT a typing-correctness bug. A `@xterm/xterm` 6.x upgrade is a separate OPTIONAL anti-flicker follow-up, not part of this change.
- **Specs:** `openspec/specs/frontend-console/spec.md` (one MODIFIED delta).
- **Live verification (requires real ChatGPT `auth.json`):** reproduce + explain the original "no effect"; confirm through the full web→gateway→`AioPtyClient`→gem-server→codex path that direct typing Enter SUBMITS, Ctrl-C interrupts, arrows/backspace work, and clipboard paste INSERTS (does not submit).
