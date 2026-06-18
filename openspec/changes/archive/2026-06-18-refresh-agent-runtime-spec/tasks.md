# Tasks

This is a documentation-only spec reconciliation — there is NO code change (the
code is already post-refactor). The change IS the `agent-runtime` MODIFIED
delta; archiving applies it to the live spec.

## 1. Author the reconciliation delta

- [x] 1.1 MODIFIED `AgentRuntime port abstracts per-agent execution seams`: seam
  list → `buildLaunchLine, terminalStartup, sandboxSetupCommands,
  preStopTrimCommands, detectExit`; behavior-preserving clause/scenario reworded
  (codex byte-identity claim unchanged).
- [x] 1.2 MODIFIED `ClaudeCodeRuntime credential injection via env token`: drop
  the `injectAuth()` method; token contributed via declared launch env /
  `sandboxSetupCommands`; all fail-closed/stray-key scenarios preserved.
- [x] 1.3 MODIFIED `ClaudeAuthSource port with environment source`: env source
  feeds the runtime's credential setup (not `injectAuth`); port + leak scenarios
  preserved.
- [x] 1.4 MODIFIED `ClaudeCodeRuntime autosubmit is a no-op`: express via
  declared `terminalStartup` (`promptSubmit:'none'`, `replyToStartupDSR:false`)
  read by the shared mechanism; no-CR / no-DSR-handshake behavior preserved.
- [x] 1.5 MODIFIED `ClaudeCodeRuntime transcript capture`: structured JSONL read
  by the shared retention path (not `captureTranscript()`); asciicast-primary
  replay scenario preserved.

## 2. Verify

- [x] 2.1 `openspec validate refresh-agent-runtime-spec --strict` passes.
- [x] 2.2 Each MODIFIED title byte-matches the live `agent-runtime` requirement
  it replaces (no orphaned duplicate); every prior behavioral scenario is
  retained; no method name `injectAuth`/`autoSubmit`/`captureTranscript` remains
  in the reconciled requirements; no contradiction with the refactor's ADDED
  invariants (adversarial review).

## 3. Apply

- [x] 3.1 Archive the change so the MODIFIED delta is synced into
  `openspec/specs/agent-runtime/spec.md`, replacing the five drifted
  requirements in place.
