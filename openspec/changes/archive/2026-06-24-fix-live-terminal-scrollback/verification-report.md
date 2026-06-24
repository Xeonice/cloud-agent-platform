# Verification Report — fix-live-terminal-scrollback

## Three-way adjudication (verify pass)

The single capability `realtime-terminal` requirement "The live terminal preserves a
scrollable history" decomposes into four spec scenarios. Adjudicated individually:

### MET (re-traced end-to-end as satisfied)

The MET portion is the normal-buffer root-cause fix, covering two of the four scenarios. Folded
here as the satisfied sub-requirement; the requirement as a whole is NOT yet fully met because the
viewport-sync scenario is reopened (see VR.1 in tasks.md).

- **Scenario: codex launches in inline (non-alt-screen) mode** — MET. `--no-alt-screen` is in the
  codex launch argv (pre-existing, c8928769; `aio-pty-client.ts` `DEFAULT_CODEX_LAUNCH_ARGV`). Golden
  argv tests assert it.

- **Scenario: tmux does not pin the pane to the alternate screen** — MET. `codex-launch.ts:138`
  (`wrapInDetachedSession`) and `codex-launch.ts:169` (`wrapHeadlessDetachedSession`) both append
  `; tmux set-window-option -t ${name} alternate-screen off` after `tmux new-session`, session-scoped
  (NOT `-g`, so the AIO sandbox's own tmux sessions are untouched). Both interactive and headless
  launch paths are covered. Tests updated (codex-launch golden + headless-execution sentinel);
  apps/api typecheck clean, 432 tests green (task 1.1, marked DONE).

### Previously NOT MET → now RESOLVED (re-traced MET this pass)

- **Scenario: The live viewport reflects accumulated scrollback** — was reopened as VR.1 (no
  viewport-sync on the live write path); RE-TRACED MET this pass. `session-terminal.tsx` now wires
  `syncViewportSoon` (debounced, `VIEWPORT_SYNC_DEBOUNCE_MS` = 120ms) into the `handle.write(...)` flush
  callback inside `onRaw` (line 374-379), so the viewport scroll-area syncs as live output accrues. The
  sync is a LOCAL-ONLY resize nudge (`cols` unchanged → no wrap reflow; `rows` +1 then back) gated by
  `suppressResizeRef` so `onResize` skips `sendResize` and the codex PTY is never perturbed
  (line 245-257, 750). The debounce timer is cleaned up on socket teardown (line 431-433). Called via a
  ref (`syncViewportSoonRef`) so the once-constructed socket closure always invokes the latest stable
  callback. Ships unconditionally per the spec SHALL + design D4 (no longer gated behind a post-deploy
  observation). web typecheck clean + 236 tests green (task 2.1, marked DONE). VR.1 in tasks.md is
  marked RESOLVED.

  The overarching scenario "Operator scrolls up through earlier output while running" is the composite
  of the tmux normal-buffer fix + this viewport sync; both code halves now trace end-to-end. Its final
  ACTUALLY-scrollable confirmation is the post-deploy live-verify (tasks 1.2 / 3.2), a dynamic/deploy
  step, not an outstanding code defect.

### All four scenarios — code re-trace

All four spec scenarios have clear traceable implementations; none are unimplemented:

1. **"Operator scrolls up through earlier output while running"** (composite) — Covered by the
   combination of the tmux fix + viewport sync.
2. **"codex launches in inline (non-alt-screen) mode"** — `--no-alt-screen` is present in
   `aio-pty-client.ts` line 127 (`DEFAULT_CODEX_LAUNCH_ARGV`) and `codex-runtime.ts` line 61.
3. **"tmux does not pin the pane to the alternate screen"** —
   `tmux set-window-option -t ${name} alternate-screen off` appended in both `wrapInDetachedSession`
   (line 138) and `wrapHeadlessDetachedSession` (line 169) in `codex-launch.ts`.
4. **"The live viewport reflects accumulated scrollback"** — `syncViewportSoon` in
   `session-terminal.tsx` (debounced, local-only resize nudge, fired in the `onRaw` flush callback,
   suppressing `sendResize` via `suppressResizeRef`).

## Scope check — this change's own diff

No out-of-spec scope creep. Every modification directly implements or tests the spec scenarios:

- `codex-launch.ts` — `wrapInDetachedSession` + `wrapHeadlessDetachedSession` append
  `tmux set-window-option -t <name> alternate-screen off` → maps to the tmux scenario. In scope.
- `session-terminal.tsx` — `syncViewportSoon` debounced viewport sync, `suppressResizeRef`, refs,
  timer cleanup → maps to the viewport-sync scenario. In scope.
- `codex-launch.test.mjs` — golden test updated to reflect the new command. Required to keep task 1.1
  tests green. In scope.
- `headless-execution.spec.ts` — loosening the exit-sentinel regex from `$`-anchored to non-anchored is
  a forced consequence of the main change (the exit sentinel is no longer the last token, since
  `tmux set-window-option` is appended after it), not independent behavior; the new
  `assert.match(line, /; tmux set-window-option -t tasktask-abc alternate-screen off$/)` is the new
  assertion for the alternate-screen feature; the comment wording tweak is trivial. All in scope.

## Findings — out-of-scope code in adjacent commits (scope check)

Recorded for traceability; these belong to OTHER changes, not fix-live-terminal-scrollback. They are
not scope creep within this change's own diff (this change's diff is `codex-launch.ts` +
`codex-launch.test.mjs` = task 1.1), but they show up near the live-terminal code:

- `XTERM_READY_TIMEOUT_MS` raised 4s→15s for wide-viewport slow init —
  `apps/web/src/components/session/session-terminal.tsx:95`. Belongs to
  `fix-terminal-input-dead-after-reload`. No spec requirement here mentions a readiness watchdog/timeout.
- `<Terminal>` always-mounted overlay pattern (vs sibling ternary unmount) so a late `onReady` fires
  after the watchdog — `apps/web/src/components/session/session-terminal.tsx:670-758`. Same other change.
- `setXtermFailed(false)` in `onReady` to self-heal after a watchdog flip —
  `apps/web/src/components/session/session-terminal.tsx:689`. Same other change.

Commits `3e31954` (`fix-terminal-record-replay-flow-control`) and `d2b8850`
(`fix-cast-replay-viewport-sync`) touch `session-cast-log.tsx` / `cast-log.ts` under their own
OpenSpec changes — not this change.
