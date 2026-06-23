# Verification Report — fix-cast-replay-viewport-sync

## Adjudication summary

The raw-skeptic pass flagged **zero** requirements as unmet. Re-tracing the
single MODIFIED requirement (`Static all-at-once terminal log`, 8 scenarios)
against the actual code confirms every scenario is satisfied end-to-end.

- **Re-opened code tasks:** none
- **Spec defects routed to design.md Open Questions:** none
- **Met (folded below):** all 8 scenarios of `Static all-at-once terminal log`

## Requirement: Static all-at-once terminal log — MET

Implementation in `apps/web/src/components/session/session-cast-log.tsx`
(`SessionCastLog`) + `apps/web/src/components/session/cast-log.ts` (pure
`buildCastOps`/`stripAltScreen`/`capCastOps`). Handle API (`geometry`,
`resize`, `scrollToTop`) is real on `@cap/ui <Terminal>`
(`packages/ui/src/terminal/terminal.tsx`).

| Scenario | Trace | Status |
| --- | --- | --- |
| The full history is shown at once | fetch via `getSessionCast` → `parseCast` → `buildCastOps` applies `r` resize events + writes `o` data, alt-screen stripped via `stripAltScreen`, no per-event timing | MET |
| The viewport is scrollable once the fill completes | `complete()` reads `handle.geometry()`, null-guarded, does `resize(cols, rows+1)` then `resize(cols, rows)` to fire xterm `syncScrollArea`, then `scrollToTop()` — the focus of this change | MET |
| Large cast replays losslessly via flow control | watermark pump with `WRITE_HIGH_WATERMARK`/`WRITE_LOW_WATERMARK`, flush-callback pacing; bounded chunks from `buildCastOps` | MET |
| Loading state until the replay is complete | `feedingDone` state + absolute overlay; `<Terminal>` stays mounted underneath; overlay drops only when `complete()` sets `feedingDone = true` | MET |
| Oversized cast is capped with a notice | `capCastOps` / `DEFAULT_CAST_MAX_OUTPUT` in `cast-log.ts` with `CAST_TRUNCATION_NOTICE` prepended | MET |
| All-at-once recovers more than the final frame | alt-screen suppression via `stripAltScreen` (only `?1049/1047/47 h/l` removed; scroll-region/cursor/clear/scroll-up intact) | MET |
| Read-only, no playback or live affordances | `<Terminal>` has no `onData`, no WebSocket, no play/pause/seek controls | MET |
| Theme parity with the live terminal | effect resolves `--terminal-*` CSS vars + `--font-mono` and passes `theme`/`fontFamily` to `<Terminal>` | MET |

## Scope finding

The diff is tightly scoped to the viewport-sync requirement. Inside `complete()`
it adds only: `const g = handle.geometry()` + null guard +
`handle.resize(g.cols, g.rows + 1)` + `handle.resize(g.cols, g.rows)`. No new
imports, no new functions, no new props, no side effects beyond the resize
nudge. `scrollToTop()` and `setFeedingDone(true)` pre-existed. Every added line
maps directly to D2/D3 in design.md ("resize nudge (rows+1 then rows back)",
"null-geometry guarded"). No scope creep.

## Gap finding

No gaps. All 8 scenarios have traceable implementations. The single documented
limitation (D4: a 137MB alt-screen clear-redraw cast may hold no scrollback at
all) is explicitly out of scope as a codex-render limitation, not a
viewport-sync defect — consistent with the spec, which targets casts whose
buffer DOES accumulate scrollback.

## Acceptance gate (tasks 2.x)

- 2.1 typecheck clean + 236 web tests green — DONE (no test asserted the old
  completion shape).
- 2.2 Live verify in Chrome on the wide viewport — POST-DEPLOY, still open
  (deployment-time activity, not a code gap).
