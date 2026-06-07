## Context

`apps/web/src/components/session/session-terminal.tsx` (the rebuilt TanStack console; `rebuild-console-tanstack-start` is archived/done) currently exposes TWO input paths to the same lease-gated `sendKeystroke`:

1. The live `<Terminal>` `onData` handler (lines ~497-510): seizes the write lease once per connection (`claimedRef` + `sendTakeover`), then `sock.sendKeystroke(taskId, data)` verbatim — no `\r`→`\n` translation. This is already a true byte-passthrough.
2. A separate `<TerminalCommandInput>` box (lines ~516-522) + `sendCommand` (lines ~396-419): sends the whole line, then a `\r` via `window.setTimeout(…, 150)`. The inline comment claims codex coalesces "text + immediate `\r`" into a PASTE (inserts a newline, does not submit) and that a delayed `\r` is a "real" Enter.

Live capture (codex 0.131 in the pinned image) + adversarial web research refuted that premise:
- **REFUTED:** paste detection is purely marker-based (`ESC[200~`/`ESC[201~`), never timing/batching. crossterm `parse.rs` has no timing logic. A programmatic `text\r` lacking the markers is parsed as normal typing + Enter regardless of arrival batching. (Two independent verifiers; sources: xterm.js Clipboard `bracketTextForPaste`, crossterm `EnableBracketedPaste`/`parse.rs`, invisible-island bracketed-paste spec.)
- xterm.js wraps ONLY clipboard pastes in the markers; individual keystrokes pass raw. So human typing's Enter is an unbracketed `\r` → submits.
- ttyd / Wetty / code-server / VS Code all use `onData → PTY stdin`, `PTY → term.write`, resize via fit; NONE use a separate command box.
- xterm is pinned `^5.5.0` (apps/web + packages/ui); synchronized-output (DEC mode 2026) landed in 6.0.0, so codex's `ESC[?2026h/l` are ignored (harmless; possible flicker on full-grid repaints). The bridge passes DEC private modes through untouched (verified: codex's `?2026/?1004/?25` and bash's `?2004` all reached the capture).

The original "no effect" symptom was real but mis-diagnosed as paste-coalescing; the true cause is most likely the `\r` racing composer-readiness or being dropped on a non-OPEN socket — which is why box removal is GATED on a live authed repro.

## Goals / Non-Goals

**Goals:**
- A single, true 1:1 input surface: typing into the live xterm goes straight to codex; Enter submits with no delay; arrows/Ctrl-C/backspace/paste behave like a real terminal.
- Remove the command box and the 150ms hack once direct typing is verified.
- No silent input loss when the socket is not connected.

**Non-Goals:**
- Backend bridge / byte-protocol changes (already correct).
- Auto-injecting the task goal (sibling change `aio-codex-prompt-autostart`).
- A `@xterm/xterm` 6.x upgrade (separate optional anti-flicker follow-up).
- Changing write-lock/takeover semantics.

## Decisions

- **D1 — Delete the command box + the 150ms-CR hack; `onData` becomes the sole live input.** The hack's premise is refuted and `onData` already forwards verbatim. Alternative (keep both) rejected as redundant and the source of the confusing dual-path UX.
- **D2 — Keep the fallback DOM line-view's input.** When xterm cannot mount there is no terminal to type into, so that path still needs a line input. The box removal is scoped to the LIVE xterm path. The `TerminalCommandInput` component is retained for the fallback only.
- **D3 — Add a connection-state affordance.** `sendFrame` only transmits when the socket is OPEN; the box was the only `connection === "open"` gate. Replace it with a visible terminal-state affordance (overlay/inert-cursor) so typing into a closed/reconnecting socket is obviously inert.
- **D4 — Focus the xterm canvas on mount** (`term.focus()` in `onReady`) so keystrokes are captured, since the competing input box is gone.
- **D5 — Do NOT block on xterm 6.x.** codex's `?2026` frames are ignored by 5.5.0 (no corruption, possible flicker). Treat the 6.x upgrade as a separate optional change; this change is about typing correctness, not flicker.
- **D6 — Gate box removal on a live authed verification.** The original "no effect" symptom must be reproduced + explained with real `auth.json` before deleting the only working input. Until verified, keep the box but stop relying on the timing hack.

- **D7 — Sync terminal size to the sandbox PTY on connect (live-verified bug, folded in).** Live diagnosis: codex PTY = 80×24 (AIO default `default-size`), browser xterm = ~137×24 → codex renders in 80 cols, cursor-addressed history misaligns in the 137-col browser grid (the user-reported "tmux 历史错位"). `gateway.onResize` already does the complete right thing (`session.pty.resize` + `session.snapshots.resizeHeadless`), and AIO honors `{type:resize}` (live-proven: probe sent 137×40 → PTY became 137×40). The ONLY gap: the geometry is never delivered to the PTY at runtime — the initial xterm `onResize` fires at mount and races the socket OPEN (`sendFrame` drops it when not OPEN), and `onOpen` sends only a `reconnect` frame whose cols/rows the backend ignores for PTY sizing. **Fix:** (a) frontend `onOpen → sendResize(geo)` (socket is OPEN there, so it drives the existing guarded `onResize` path), AND (b) backend `onReconnect` resizes `pty` + `resizeHeadless` from the `frame.cols/rows` it already receives (making those currently-dead params meaningful + robust against a lost/reordered resize frame). Alternative (start codex at the right size) rejected: codex launches on `ready` before any browser attaches, so an initial default + resize-on-connect is unavoidable; the brief 80-col window before the browser connects is acceptable (codex re-renders on resize). This is INDEPENDENT of the box-removal gate (D6) and ships now. Dynamic verification is LIVE post-deploy (re-run the codex-PTY-cols == browser-cols check) — the gateway/React wiring layer is not unit-tested in this repo (covered by e2e + live), matching the existing convention.

## Risks / Trade-offs

- **The refuted-premise reasoning is theory until live-confirmed** → if direct Enter still doesn't submit through the full path, the box removal would break input. Mitigation: D6 — verification is task 1, gating the removal; root-cause (composer readiness / lease / socket-open) before deleting.
- **Typing into a disconnected socket is silently dropped** → Mitigation: D3 connection-state affordance.
- **Flicker on xterm 5.5.0** from codex full-grid repaints (no mode-2026 batching) → cosmetic; Mitigation: optional 6.x follow-up; document so it is not read as instability.
- **Multi-line clipboard paste** depends on codex honoring bracketed paste; codex 0.131 has open paste-newline auto-submit regressions (#2006/#10065) — upstream, affects pasting not typing, unchanged by this change.

## Migration Plan

- Ship AFTER the live authed verification passes. Deploy via Vercel git auto-deploy (frontend).
- **Rollback:** restore the `TerminalCommandInput` render + `sendCommand` for the live path (the component is retained for the fallback, so rollback is re-wiring, not re-adding).

## Open Questions

- The exact root cause of the original "no effect" symptom (to be settled by the live authed repro) — composer readiness, lease timing, or non-OPEN socket?
- Flicker severity on 5.5.0 with codex's full-grid repaints — enough to prioritize the 6.x upgrade?
