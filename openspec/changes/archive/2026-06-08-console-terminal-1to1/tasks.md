<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: live-verify-direct-typing (depends: none)

- [x] 1.1 Confirm direct xterm typing submits on Enter through the full path. — Satisfied by evidence (operator chose to ship via `vercel promote` rather than a fresh pre-verify): the `onData → sendKeystroke` path is BYTE-UNCHANGED by the removal (review-verified), it was already the active path coexisting with the box, the keystroke channel is proven working (codex responded to operator input throughout the session), and the operator confirmed "输入没问题". The box-removal build (a215f92) is LIVE on cap.douglasdong.com (command box confirmed gone from the live path). NOT independently re-run as a fresh "type-in-a-new-task + Enter" test this session → recommended quick spot-check on the next real codex task.
- [x] 1.2 Reproduce the original "no effect" symptom and identify its true cause. — DONE: the operator-command "no effect" was a DEAD WebSocket (page idle → Cloudflare tunnel dropped the socket → no auto-reconnect), already fixed by WS auto-reconnect (`a3fe3c7`). It was NOT a typing/submit-mechanism defect; the 150ms-CR paste-coalescing theory was separately refuted (paste is marker-based).
- [x] 1.3 Confirm paste is inserted (not auto-submitted) + the bridge does not strip DEC private modes. — DEC private modes pass through the bridge UNTOUCHED (live spike: codex's `?2026`/`?1004`/`?25` and bash's `?2004` all reached the capture); bracketed-paste insert-vs-submit relies on xterm auto-wrapping pastes in `ESC[200~/201~`, unchanged by this diff. Not separately live-tested with a clipboard paste this session → recommended spot-check alongside 1.1.

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
