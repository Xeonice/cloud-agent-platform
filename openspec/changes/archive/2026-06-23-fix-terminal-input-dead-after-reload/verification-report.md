# Verification Report — fix-terminal-input-dead-after-reload

Three-way routing of the verify pass. Each raw-unmet finding was re-traced
end-to-end against the actual code before adjudication (not rubber-stamped).

## Requirement: A ready xterm always replaces the read-only fallback → MET

A prior pass RE-OPENED this as task V.1 because the late-`onReady` recovery was
structurally unreachable: `showFallback ? <fallback> : <Terminal>` UNMOUNTED
`<Terminal>` on the watchdog flip, so its cleanup set `disposed = true`, the
in-flight async init short-circuited at `if (disposed) return;`, the late
`onReady` never fired, and `setXtermFailed(false)` was a no-op.

V.1 is now FIXED, and this pass's re-trace against the CURRENT code REFUTES the
skeptic — the structural defect no longer exists:

- `<Terminal>` is ALWAYS mounted when `theme` is ready
  (`session-terminal.tsx:681–718`); it is NO LONGER gated on `!showFallback`.
- The read-only fallback now renders as an ABSOLUTE OVERLAY layered on top
  (`absolute inset-0 z-20`, `session-terminal.tsx:744–754`) while `xtermFailed`,
  rather than as a sibling that unmounts `<Terminal>`.
- Because `<Terminal>` stays mounted UNDER the overlay, a slow/wide xterm keeps
  initializing; its late `onReady` DOES fire (`session-terminal.tsx:688–697`)
  and calls `setXtermFailed(false)` (line 696) → the overlay drops → the real
  xterm self-heals into view. This is exactly the spec's required recovery.
- `XTERM_READY_TIMEOUT_MS = 15_000` (`session-terminal.tsx:99`) keeps the
  tolerant budget so a merely-slow wide-viewport init is not declared failed in
  the first place; the `if (!handleRef.current)` guard
  (`session-terminal.tsx:525`) still prevents a fallback once `onReady` landed.

The "late onReady recovers" path is a React-DOM render+timing behavior; apps/web
vitest runs in the `node` env with no DOM, so it is covered by the post-deploy
wide-viewport live verification (task 4.1) rather than a unit render test — a
test-harness limitation acknowledged in V.1, not a code gap. Re-traces
end-to-end as MET.

## Requirement: The live terminal preserves a scrollable history → MET

Re-traces end-to-end as satisfied. `--no-alt-screen` is present and
byte-consistent across all three required sources and asserted in both tests:

- `apps/api/src/agent-runtime/codex-runtime.ts:61` — `CodexRuntime` default argv.
- `apps/api/src/terminal/aio-pty-client.ts:127` — mirrored pty-client default.
- `docker/aio-sandbox.Dockerfile:253` — baked `CODEX_LAUNCH_ARGV` env.
- `apps/api/src/agent-runtime/agent-runtime.test.mjs:231` and
  `apps/api/src/terminal/codex-launch.test.mjs:80` — argv assertions updated.

The codex TUI therefore runs in the normal buffer, so output accrues in xterm
scrollback. Minor residual (does NOT block the primary scenario): the
wide-viewport scroll-up acceptance is a post-deploy gate already tracked as task
4.1, and codex issue #18528 (some terminals can't scroll even with
`--no-alt-screen`) is an acknowledged risk in design D6 to confirm against OUR
xterm at that gate.

## Gap analysis

Both requirements have traceable implementations:

1. **"A ready xterm always replaces the read-only fallback"** — implemented in
   `session-terminal.tsx`: `XTERM_READY_TIMEOUT_MS = 15_000` (tolerant budget),
   `<Terminal>` stays mounted under the fallback overlay (never unmounted), and
   `onReady` calls `setXtermFailed(false)` to recover a late-ready xterm. The
   overlay renders conditionally on `showFallback` while `<Terminal>` remains in
   the DOM.

2. **"The live terminal preserves a scrollable history"** — `--no-alt-screen` is
   present in `codex-runtime.ts` (line 61), `aio-pty-client.ts` (line 127),
   `codex-launch.test.mjs` (line 80), and verified by `agent-runtime.test.mjs`
   (lines 231–233).

Both requirements have concrete, traceable implementations. No requirement is
entirely without implementation.

## Scope analysis

The connection badge was already present in the `!showFallback` branch in the
prior commit. The restructure moved it from the live-path-only branch to the
shared always-mounted container — that is purely structural refactoring required
by the fix, not a new behavior.

All 6 changed files implement behaviors that are directly required by or
logically entailed by the two spec requirements (fix #1 watchdog/recovery + fix
#2 `--no-alt-screen`) plus the task-mandated test updates. No scope creep
detected. Every implemented behavior maps directly to a spec requirement:

- `session-terminal.tsx`: always-mounted `<Terminal>` + overlay restructure +
  `setXtermFailed(false)` in `onReady` + raising timeout to 15 000 ms — all
  required by Requirement 1 (late `onReady` recovery). The connection-state
  corner badge was pre-existing and merely moved structurally as a consequence
  of the restructure.
- `codex-runtime.ts`, `aio-pty-client.ts`, `aio-sandbox.Dockerfile`: adding
  `--no-alt-screen` to the launch argv — required by Requirement 2 (scrollable
  history).
- `agent-runtime.test.mjs`, `codex-launch.test.mjs`: updating argv assertions —
  mandated by tasks 2.2 to keep the test suite green after the argv change.
