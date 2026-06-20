# Verification Report — add-headless-execution-track

Adjudicated re-trace of every spec requirement against the actual implementation
(not a rubber-stamp of the raw skeptic pass). Three-way routing tally:

- **Re-opened code tasks (UNMET):** 0
- **Spec defects (routed to design.md Open Questions):** 0
- **Reclassified / confirmed MET:** 1

The raw-unmet input was empty (`[]`). The remaining skeptic observations were a
"gap" note and a set of "scope" deltas; each was independently re-traced
end-to-end against the actual code and folded here. No observation re-traced as a
real code defect, and none was an ambiguous/untestable requirement, so nothing
re-opened as a task and nothing routed to design.md Open Questions.

---

## MET — `agent-runtime`: ClaudeCodeRuntime turn-completion exit detection (interactive follow-up)

**Verdict: MET (end-to-end), with a minor spec-language gap that does not block
the primary scenario.** Spec file: `specs/agent-runtime/spec.md` (MODIFIED
requirement "ClaudeCodeRuntime turn-completion exit detection").

The write-lease-gated keystroke path exists. For interactive follow-up, the
operator types via the live xterm (write-lease-gated keystrokes), and because
Claude is a resident session with `detectExit` using `tmux has-session`, the task
stays `running` while the session is alive. **Implemented.**

Evidence:

- `ClaudeCodeRuntime.detectExit` resolves completion from session liveness via
  `tmux has-session` (`apps/api/src/agent-runtime/claude-code-runtime.ts:236-243`):
  a session that EXISTS (`__cap_has__0`) reads `running`; a GONE session reads
  `done`. This is IDENTICAL to `CodexRuntime.detectExit` and does NOT tail the
  transcript for `end_turn`, satisfying the MODIFIED requirement's "SHALL resolve
  completion from session liveness … exactly like `CodexRuntime.detectExit()`,
  … SHALL NOT tail the transcript for `end_turn`."
- The resident-session doc-comment (`claude-code-runtime.ts:227-234`) records that
  a finished turn does NOT exit the process and is NOT treated as completion —
  Claude idles for the next input the operator types into the live terminal,
  driving multi-turn conversation in the same `--session-id` session. This
  satisfies both the "finished interactive turn keeps the session resident" and
  "interactive follow-up continues the same conversation" scenarios.
- The live-xterm write-lease keystroke path is the existing console operator-
  takeover seam, explicitly preserved by the change's Non-Goals ("Any change to
  the console interactive-pty path, operator takeover, or write-lock") — it is
  not re-implemented by this change, and the resident `detectExit` correctly
  keeps the task `running` for it.

Based on a thorough analysis of all four spec files against the actual
implementation, all requirements have traceable implementations. The specs use
"succeeded" as a terminal status label in some places (e.g. the agent-runtime
spec's "Headless-exec resolves a task to terminal on process exit" scenario, and
tasks 6.1/7.1) but the codebase maps this terminal outcome to its own
status enum — this is a naming mismatch in the spec LANGUAGE, not a behavior gap:
the headless exit-on-completion → session-gone → terminal-status path is fully
implemented (`aio-sandbox.provider.ts` session-gone resolution; the headless
launch lines in both runtimes). MET-as-written with a minor non-blocking gap.

---

## Scope / divergence findings (non-blocking, recorded for archive-time spec sync)

These are confirmed-in-code deltas between the IMPLEMENTATION and the *task
wording* (tasks.md). None violates an ADDED/MODIFIED requirement in the four
spec.md files — in fact the most material one (parser placement) is what the
spec REQUIRES — so none re-opens a task. Recorded so the delta-spec sync at
archive (task 8.2) reconciles the stale task language.

**Confirmed:** `parseTranscript` is NOT on the `AgentRuntime` interface, despite
spec task 1.3 requiring it. Instead the implementation uses a separate
`parse-transcript.ts` dispatch keyed by the declared `transcriptFormat` tag. This
is CORRECT against the authoritative requirement: `specs/agent-runtime/spec.md`
("Transcript artifact location and format are declarative per-runtime
capabilities") states "The port MUST NOT own the parser implementation —
keeping it a dependency-light LEAF module that never imports the sandbox parsers
or `@cap/contracts`. The shared transcript read … SHALL … dispatch to the parser
keyed by the declared `transcriptFormat`." The port at
`apps/api/src/agent-runtime/agent-runtime.port.ts:305-312` declares
`transcriptArtifact` + `readonly transcriptFormat` ("The port owns NO parser"),
and `apps/api/src/sandbox/parse-transcript.ts:13-20` dispatches by format. Task
1.3's `parseTranscript`-on-the-port wording is stale relative to the shipped
requirement; the requirement itself is MET.

Additive deltas (extra capability beyond the task wording, no requirement broken):

- `--verbose` flag added to both `buildHeadlessLine` and `buildResumeLine` in
  `ClaudeCodeRuntime` but not mentioned in spec task 3.1 or 3.2.
  `apps/api/src/agent-runtime/claude-code-runtime.ts:284,292`. No spec.md
  requirement pins exact claude argv; only design.md D5 sketches it (without
  `--verbose`). Additive, non-breaking.
- `parseTranscript(rawJsonl,format)` placed in a separate sandbox-layer dispatch
  module rather than on the `AgentRuntime` port interface; spec task 1.3
  explicitly requires `parseTranscript(rawJsonl: string): ParsedRollout` as a
  method on the `AgentRuntime` port.
  `apps/api/src/sandbox/parse-transcript.ts:13`. (See "Confirmed" above — the
  authoritative spec.md requires exactly this placement.)
- `transcriptFormatForRuntime()` standalone registry-free helper added to
  `agent-runtime.port.ts`; no requirement in any spec for a port-level function
  that resolves format by runtime ID without a runtime instance.
  `apps/api/src/agent-runtime/agent-runtime.port.ts:65-69`. Additive helper to
  let the durable-read path resolve the parser without a runtime instance.
- Test `parseTranscript dispatches codex-rollout to the codex parser` in
  `headless-execution.spec.ts`; spec task 7.2 only requires the claude JSONL
  parser test, not a symmetric codex-rollout dispatch test.
  `apps/api/src/agent-runtime/headless-execution.spec.ts:148-164`. Additive
  coverage, non-breaking.
