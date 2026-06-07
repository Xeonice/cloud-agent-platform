# Research brief — console-terminal-1to1

Side-car provenance. Live byte-capture on the pinned image + adversarially-verified web research.

## The refuted premise (the crux)

The command box exists with a 150ms-delayed-CR hack whose inline comment claims "text + immediate `\r` is coalesced by codex into a PASTE (inserts newline, does not submit); a delayed `\r` is a real Enter." Two independent adversarial verifiers **REFUTED** this:

- Paste detection is purely MARKER-based: a terminal wraps clipboard pastes in `ESC[200~`/`ESC[201~`; crossterm/ratatui detect paste ONLY by those markers (crossterm `parse.rs` has no timing logic). A programmatic `text\r` lacking the markers is parsed as normal typing + Enter regardless of arrival batching/timing.
- xterm.js wraps ONLY clipboard pastes (`bracketTextForPaste`); individual keystrokes pass raw. So human typing's Enter is an unbracketed `\r` → submits.

Sources: xterm.js commit `1dbcf70` + PR #1097; invisible-island bracketed-paste spec; crossterm `EnableBracketedPaste` docs + `parse.rs`; cirw.in bracketed-paste; en.wikipedia.org/wiki/Bracketed-paste.

Implication: the 150ms hack and the command box are redundant; direct `onData → sendKeystroke` (already verbatim) is the correct 1:1 surface. The original "no effect" symptom was real but mis-diagnosed — true cause is likely composer-readiness or a non-OPEN socket, hence the live-verify gate (Track 1).

## Canonical 1:1 architecture (CONFIRMED)

ttyd / Wetty / code-server / VS Code integrated terminal all use `onData → PTY stdin`, `PTY stdout → term.write`, resize via fit addon → PTY resize. NONE use a separate command box. Sources: tsl0922/ttyd, butlerx/wetty, microsoft/vscode-wiki xterm.js.

## xterm version (CONFIRMED in-repo)

`@xterm/xterm` is pinned `^5.5.0` in both `apps/web/package.json` and `packages/ui/package.json`. Synchronized-output (DEC mode 2026) landed in xterm 6.0.0 (PR #5453), so codex's live-verified `ESC[?2026h/l` frames are IGNORED by 5.5.0 — harmless (no corruption) but no atomic frame batching, so codex's full-grid repaints may flicker. A 6.x upgrade is an OPTIONAL anti-flicker follow-up, NOT a prerequisite for correct typing.

## Live capture corroboration (codex 0.131, pinned image)

The bridge passes DEC private modes through untouched in the OUTPUT direction: codex's `?2026/?1004/?25` and bash's `?2004` all reached the capture. The DSR/CPR injection (`\x1b[6n` → `\x1b[1;1R`) in `AioPtyClient.onOutput` is the verified crossterm-startup unblock and is independent of this change (keep it).

## Backend is already correct

`aio-sandbox-execution` forwards operator keystrokes as `{type:"input"}`; `write-lock-and-takeover` keystroke lease-gating is unchanged. This change is frontend-only (`session-terminal.tsx`).

## Still open (needs live auth)

The true cause of the original "no effect" (composer readiness / lease / socket-open); whether codex submits as expected through the full path; flicker severity on 5.5.0.
