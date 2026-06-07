<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: live-verify-direct-typing (depends: none)

- [ ] 1.1 With real ChatGPT `auth.json`, drive a live task and confirm through the full web→gateway→`AioPtyClient`→gem-server→codex path that typing directly into the xterm SUBMITS on Enter (`\r`), Ctrl-C interrupts, arrows navigate, and backspace deletes — NOT just at the PTY in isolation.
- [ ] 1.2 Reproduce the original "no effect" symptom and identify its true cause (composer readiness vs. write-lease vs. non-OPEN socket); record the finding. This GATES the box removal — if direct Enter does not submit, root-cause and fix before Track 2.
- [ ] 1.3 Confirm clipboard paste into the xterm reaches codex wrapped in `ESC[200~`/`ESC[201~` and is INSERTED (not auto-submitted), and that the bridge does not strip DEC private modes (2004/1004/2026) — a live byte-capture through `/v1/shell/ws`.

## 2. Track: terminal-input-1to1 (depends: live-verify-direct-typing)

- [ ] 2.1 In `session-terminal.tsx`, remove the `<TerminalCommandInput>` render on the LIVE xterm path, the `sendCommand` callback, and the 150ms-delayed-CR `window.setTimeout`; remove the now-unused `input`/`setInput` state if no longer referenced by the fallback.
- [ ] 2.2 Keep the `<Terminal>` `onData` handler as the SOLE live input path (verbatim `sendKeystroke`, lease seized once per connection); verify it performs no `\r`→`\n` translation or trimming.
- [ ] 2.3 Retain `TerminalCommandInput` for the fallback DOM line-view (xterm unavailable) and keep its input row there.
- [ ] 2.4 Add a connection-state affordance (state overlay / inert-cursor hint) so typing into a closed/reconnecting socket is visibly inert rather than silently dropped, replacing the box's old `connection === "open"` gate.
- [ ] 2.5 Focus the xterm canvas on mount (`term.focus()` in `onReady` or focus the container) so keystrokes are captured with the box gone.
- [ ] 2.6 Update the inline comments that describe the (now-removed) paste/CR hack to reflect the marker-based paste reality and the single 1:1 input surface.

## 3. Track: flicker-followup-note (depends: terminal-input-1to1)

- [ ] 3.1 Document (in the change/design and a code comment) that `@xterm/xterm` is pinned `^5.5.0` so codex's synchronized-output (`ESC[?2026h/l`, DEC mode 2026) is ignored — possible flicker on full-grid repaints — and that a 6.x upgrade is a separate OPTIONAL anti-flicker follow-up, not part of this change.
