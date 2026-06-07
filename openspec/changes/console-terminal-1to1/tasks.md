<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: live-verify-direct-typing (depends: none)

- [ ] 1.1 With real ChatGPT `auth.json`, drive a live task and confirm through the full web→gateway→`AioPtyClient`→gem-server→codex path that typing directly into the xterm SUBMITS on Enter (`\r`), Ctrl-C interrupts, arrows navigate, and backspace deletes — NOT just at the PTY in isolation.
- [ ] 1.2 Reproduce the original "no effect" symptom and identify its true cause (composer readiness vs. write-lease vs. non-OPEN socket); record the finding. This GATES the box removal — if direct Enter does not submit, root-cause and fix before Track 2.
- [ ] 1.3 Confirm clipboard paste into the xterm reaches codex wrapped in `ESC[200~`/`ESC[201~` and is INSERTED (not auto-submitted), and that the bridge does not strip DEC private modes (2004/1004/2026) — a live byte-capture through `/v1/shell/ws`.

## 2. Track: terminal-input-1to1 (depends: live-verify-direct-typing)

- [x] 2.1 In `session-terminal.tsx`, remove the `<TerminalCommandInput>` render FROM THE LIVE xterm path (moved into the `showFallback` branch). `sendCommand` + the 150ms-delayed-CR `window.setTimeout` are NARROWED to the fallback-only path — NOT removed, because Track 2.3 retains the box for the xterm-unavailable fallback; `input`/`setInput`/`commandDisabled` are retained because the fallback still references them. (Also fixed: `sendCommand` now sends the trimmed `value`, not raw `input`.)
- [x] 2.2 Keep the `<Terminal>` `onData` handler as the SOLE live input path (verbatim `sendKeystroke`, lease seized once per connection); verified it performs no `\r`→`\n` translation or trimming — unchanged.
- [x] 2.3 Retain `TerminalCommandInput` for the fallback DOM line-view (xterm unavailable) and keep its input row there (rendered inside the `showFallback` branch). Component docstring updated to "fallback-only".
- [x] 2.4 Add a connection-state affordance so typing into a closed/reconnecting socket is visibly inert rather than silently dropped — a small NON-blocking top-right corner badge (NOT a full overlay, so an auto-reconnect window never hides the last codex frame), `pointer-events-none`, with `role="status"`/`aria-live="polite"` for assistive tech.
- [x] 2.5 Focus the live xterm on mount via the scoped `TerminalHandle.focus()` (new public method on `@cap/ui` `Terminal`, wrapping xterm's `term.focus()`) — NOT an unscoped `document.querySelector` on xterm internals. Guarded with `pending !== null` so it never steals focus from a pending approval surface (re-runs to restore terminal focus when the approval clears).
- [x] 2.6 Update the inline comments + the top docstring + the `TerminalCommandInput` docstring to reflect the marker-based paste reality (the prior coalescing rationale was inaccurate) and the single 1:1 live input surface.

## 3. Track: flicker-followup-note (depends: terminal-input-1to1)

- [x] 3.1 Document (in design.md D4/D5 + an inline comment by the `@xterm/xterm` CSS import) that `@xterm/xterm` is pinned `^5.5.0` so codex's synchronized-output (`ESC[?2026h/l`, DEC mode 2026) is ignored — possible flicker on full-grid repaints — and that a 6.x upgrade is a separate OPTIONAL anti-flicker follow-up, not part of this change.

## 4. Track: terminal-size-sync (depends: none)

<!-- NEW, live-verified bug; INDEPENDENT of the box-removal gate (Track 1/2). The
     PTY-resize backend path (gateway.onResize → pty.resize + resizeHeadless) and
     AIO's resize support already work; the fix only delivers the geometry on connect. -->

- [x] 4.1 Frontend: in `session-terminal.tsx` `onOpen`, after `sendReconnect`, also `socket.sendResize(geo.cols, geo.rows)` when geometry is known — the initial xterm `onResize` races the socket OPEN and is dropped, so the size must be (re)sent once OPEN. Drives the existing `gateway.onResize → pty.resize + resizeHeadless`.
- [x] 4.2 Backend: in `terminal.gateway.ts` `onReconnect`, when the reconnect frame carries `cols`/`rows`, resize `session.pty` and `session.snapshots.resizeHeadless(cols, rows)` (guard to authenticated operator, mirroring `onResize`) — honors the geometry the reconnect frame already carries (currently dead `clientCols`/`clientRows`), syncing the PTY on every reconnect even if a resize frame is lost.
- [x] 4.3 Verify (static gates GREEN): `tsc` api + web (0), nest build (0), api full test suite (all green; reconnect-replay/cpr-detector/write-lock no regression), web vitest (40/40), eslint api+web changed files (0). DYNAMIC VERIFIED LIVE (deploy `34b0dc9`): on a fresh task created post-deploy (`85151241`), codex's render width == the browser xterm width (both **130 cols**, measured from the xterm DOM: every row padded to 130 + codex's full-width "Worked for" rule = 130), vs the broken pre-fix task (`cd56f9bb`: codex 80 vs browser 137). tmux history/full-width rules align; misalignment fixed.
