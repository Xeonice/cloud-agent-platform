# Fix wide-screen live terminal: stuck read-only fallback + no scrollback

## Why

Two defects surface on the live session terminal (`/tasks/:id`) on a **wide viewport**, both
reproduced in Chrome on the user's wide screen (Browser 2, 1728px):

### 1. Intermittently stuck on the read-only fallback → input "does nothing"

On a wide viewport the terminal intermittently shows 「终端渲染器不可用，已降级为文本视图。」(the
read-only fallback) instead of the real xterm; typing then "does nothing" (the fallback is a text view
with only a bottom command box). One reload landed on the fallback (`hasXtermDom: false`), another
showed the real xterm — INTERMITTENT, and far more likely on the wide viewport.

Root cause (`apps/web/src/components/session/session-terminal.tsx`): a readiness **watchdog**
(`XTERM_READY_TIMEOUT_MS = 4000`) flips `setXtermFailed(true)` if xterm's `onReady` has not fired
within 4s. On a wide viewport xterm's async build (dynamic import + `open` + `fit`) is slower and
intermittently exceeds 4s. When `onReady` fires LATER than 4s it only `setXtermReady(true)` and **never
resets `xtermFailed`** — and `showFallback = xtermFailed`, so the terminal is **permanently stuck on
the fallback** even though the real xterm is now ready. (The earlier "onData unwired" hypothesis was a
`computer type` automation artifact and is retracted — real-input `onData` works.)

### 2. Cannot scroll up in the live terminal

The live terminal cannot scroll back to earlier output. Confirmed via web research + repro: codex runs
in the **alternate screen (CSI 1049)**, which by xterm spec has **no scrollback** — so the live xterm
viewport is only ever the current screen (`scrollHeight == clientHeight`, `canScroll: false`). codex
0.131 ships a `--no-alt-screen` flag ("inline mode, preserving terminal scrollback history"); we did
not pass it, so codex defaulted to the alt-screen.

## What Changes

- **Recover from a late xterm `onReady`** (fix #1): when xterm becomes ready, clear `xtermFailed` so a
  late-but-successful xterm replaces the fallback instead of staying stranded behind it.
- **Make the watchdog tolerant of slow/wide init** (fix #1): raise `XTERM_READY_TIMEOUT_MS` from 4s to
  15s so a merely-slow xterm is not declared failed (paired with the recovery → self-heals).
- **Launch codex with `--no-alt-screen`** (fix #2): run codex's TUI INLINE so its output stays in the
  NORMAL buffer and the live xterm keeps a scrollable history. Applied to the SINGLE codex launch argv
  (CodexRuntime is the runtime source post agent-runtime refactor; mirrored in `AioPtyClient`'s default
  + the baked Dockerfile `CODEX_LAUNCH_ARGV` for consistency).
- **Verify on the wide viewport** (Browser 2, 1728px) after deploy: N reloads each render the real
  xterm (not the fallback) AND the live terminal scrolls up through history.
- **(Deferred — separate follow-up)** The CPR/DA `;276;0c` echoed as visible text on reconnect is an
  independent cosmetic bug in the codex/PTY DSR-CPR handshake; tracked separately.

## Impact

- Affected spec: `realtime-terminal` (renders on wide viewports without sticking on the fallback; the
  live terminal preserves a scrollable history).
- Affected code:
  - `apps/web/src/components/session/session-terminal.tsx` (watchdog timeout + `onReady` recovery)
  - `apps/api/src/agent-runtime/codex-runtime.ts` (the runtime codex argv) +
    `apps/api/src/terminal/aio-pty-client.ts` (mirrored default) + `docker/aio-sandbox.Dockerfile`
    (baked `CODEX_LAUNCH_ARGV`) — all add `--no-alt-screen`.
- No DB migration. No schema change. (codex argv is constructed by the api and injected into the
  sandbox; prod does not override `CODEX_LAUNCH_ARGV`, so the api change takes effect on deploy without
  rebuilding the aio-sandbox image — the Dockerfile bake is for consistency on next image build.)
