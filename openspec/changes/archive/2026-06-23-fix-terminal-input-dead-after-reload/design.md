# Design

## Context

`apps/web/src/components/session/session-terminal.tsx` renders the live xterm, with a fallback
text-view (`TerminalFallback` + a command box) gated by `showFallback = xtermFailed`. `xtermFailed` is
set by a watchdog: `useEffect` that, if `xtermReady` is still false, `setTimeout(() => { if
(!handleRef.current) setXtermFailed(true) }, XTERM_READY_TIMEOUT_MS)` with `XTERM_READY_TIMEOUT_MS =
4000`. `onReady` (from `@cap/ui` `<Terminal>`, fired after the async dynamic-import + `open` + `fit`)
sets `handleRef` + `setXtermReady(true)`. A wide-screen Chrome repro (1728px) showed the terminal
intermittently stuck on the fallback: the xterm build exceeded 4s, the watchdog flipped `xtermFailed`,
and the late `onReady` never cleared it.

## Goals / Non-goals

- **Goal (fix #1):** the live xterm renders on wide viewports and is NOT stuck on the read-only
  fallback when xterm is merely slow to initialize; a ready xterm always replaces the fallback.
- **Goal (fix #2):** the live terminal preserves a scrollable history (operators can scroll up to
  earlier output), instead of being pinned to the current screen.
- **Non-goal:** removing the fallback (it is still the honest state for a GENUINE xterm failure —
  dynamic import threw); the CPR/DA leak (deferred, D4); other backend/lease/API changes.

## Decisions

**D1 — Confirmed root cause (wide-screen repro + code), not a guess.** The defect is the
`xtermFailed` watchdog mis-firing on slow/wide xterm init combined with no recovery on a late
`onReady`. Earlier "onData unwired" hypothesis is retracted (it was a `computer type` automation
artifact; real-input `onData` works). This change is repro-anchored: reproduce on the wide viewport,
fix, re-verify on the same wide viewport.

**D2 — Recover from a late `onReady` (the core fix).** When xterm becomes ready (`onReady` →
`handleRef` set), CLEAR `xtermFailed` (e.g. `setXtermFailed(false)` alongside `setXtermReady(true)`).
A real, ready xterm must NEVER stay hidden behind the read-only fallback. This alone fixes the
"permanently stuck" case even if the watchdog briefly fired.

**D3 — Watchdog tolerant of legitimate slow init.** Raise `XTERM_READY_TIMEOUT_MS` from 4s to a value
that comfortably covers a large wide-viewport terminal's `open`/`fit` (e.g. 10–15s), so a merely-slow
xterm is not declared failed. The watchdog's purpose is a GENUINE failure (dynamic import threw / the
canvas never mounts), not slowness — pair the longer timeout with the D2 recovery so even an
over-budget-but-eventually-ready xterm self-heals. (The existing `if (!handleRef.current)` guard
stays: if `onReady` already landed, never fall back.)

**D4 — CPR/DA leak is DEFERRED (separate follow-up).** The `;276;0c` is a terminal query response
surfaced as visible text after reconnect — an INDEPENDENT cosmetic bug whose root is the codex/PTY
DSR-CPR handshake (`aio-pty-client.ts`), not the fallback watchdog this change fixes. It is tracked as
its own follow-up rather than coupled here, so the user-facing input fix ships without waiting on a
deeper handshake investigation.

**D5 — Verify on the wide viewport that exposed it.** Acceptance: on Browser 2 (1728px), N consecutive
reloads each render the real xterm (`hasXtermDom: true`, no 「降级为文本视图」) and accept typing, AND
the live terminal scrolls up through earlier output (`canScroll: true` once history accrues).

**D6 — codex `--no-alt-screen` for live scrollback (fix #2).** codex defaults to the alternate screen
(CSI 1049), which by spec has NO scrollback — so the live xterm could never scroll up. codex 0.131's
`--no-alt-screen` runs the TUI INLINE (normal buffer), preserving scrollback. Add it to the SINGLE
codex launch argv. The runtime source is `CodexRuntime.DEFAULT_CODEX_LAUNCH_ARGV` (`resolveArgv` →
`buildLaunchLine`, post agent-runtime-policy refactor); mirror the same string in `AioPtyClient`'s
default and the baked Dockerfile `CODEX_LAUNCH_ARGV` so all three stay byte-consistent. prod does NOT
set the `CODEX_LAUNCH_ARGV` env, so the api change alone takes effect on deploy (no aio-sandbox rebuild
needed; the Dockerfile bake applies on the next image build). RISK: codex issue #18528 reports some
terminals still can't scroll even with `--no-alt-screen` — so the post-deploy wide-viewport repro is
the acceptance gate, NOT a blind assumption.

## Risks / Trade-offs

- **Longer timeout delays the fallback for a GENUINE failure.** Acceptable: a true xterm failure is
  rare, and the D2 recovery means a late-but-successful xterm still heals; better a few extra seconds
  of skeleton than a wrongly-permanent read-only terminal. The skeleton/connecting affordance covers
  the wait.
- **Speeding xterm init (optional).** If the wide-init slowness is large, consider deferring `fit`
  off the critical path so `onReady` fires sooner — optional, secondary to D2/D3.

## Migration

None (frontend lifecycle + a reconnect display fix).
