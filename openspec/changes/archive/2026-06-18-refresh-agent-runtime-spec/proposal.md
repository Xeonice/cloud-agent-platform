# Refresh the agent-runtime spec to match the shipped policy/mechanism port

## Why

`refactor-agent-runtime-policy-mechanism` reshaped the `AgentRuntime` port from
the original method-bag (`injectAuth`, `autoSubmit`, `captureTranscript`) into a
policy object: declarative `terminalStartup`, pure command-emitters
`sandboxSetupCommands` / `preStopTrimCommands`, one `detectExit`, a single
interface with no adapter. That refactor is shipped and verified end-to-end on
x86 (codex + claude).

But the refactor authored its delta specs as `## ADDED Requirements` (new
architectural invariants) and did NOT mark the now-obsolete
`add-claude-code-runtime` requirements as `## MODIFIED`. So after both changes
were synced into `openspec/specs/agent-runtime/spec.md`, the live spec carries a
contradiction: five earlier requirements still name the removed/renamed methods
`injectAuth()` / `autoSubmit()` / `captureTranscript()` as the port shape, while
the refactor's invariants say those were removed. An adversarial 3-lens review
flagged one HARD enumeration contradiction (the seam list names `autoSubmit` /
`injectAuth` as port members) plus five stale-method-name references.

The drift must be fixed THROUGH a change delta (not an ad-hoc edit of the
derived live spec) to keep the OpenSpec audit trail intact. This change is that
delta.

## What Changes

Documentation-only — there is NO code change (the code is already
post-refactor; only the spec lags). This change MODIFIES five requirements in
the `agent-runtime` capability so the prose matches the shipped policy/mechanism
port, while preserving every behavioral requirement and scenario:

- **AgentRuntime port abstracts per-agent execution seams** — replace the seam
  enumeration `buildLaunchLine, injectAuth, autoSubmit, detectExit,
  captureTranscript` with the shipped seams `buildLaunchLine, terminalStartup,
  sandboxSetupCommands, preStopTrimCommands, detectExit`; reword the
  behavior-preserving clause/scenario in those terms (the byte-identical codex
  behavior claim is unchanged).
- **ClaudeCodeRuntime credential injection via env token** — drop the
  `injectAuth()` method reference; the token is contributed to the launch env
  via the runtime's declared launch env / `sandboxSetupCommands`. All three
  fail-closed / stray-key scenarios are unchanged.
- **ClaudeAuthSource port with environment source** — the env source feeds the
  token into the runtime's credential setup (not `injectAuth`); port + leak
  scenarios unchanged.
- **ClaudeCodeRuntime autosubmit is a no-op** — express "no auto-submit" as the
  declared `terminalStartup` (`promptSubmit: 'none'`, `replyToStartupDSR:
  false`) read by the shared mechanism, instead of an `autoSubmit()` method; the
  no-CR / no-DSR-handshake behavior is unchanged.
- **ClaudeCodeRuntime transcript capture** — the structured `--session-id` JSONL
  is read by the shared retention path (not a per-runtime `captureTranscript()`
  method); the asciicast-primary replay behavior is unchanged.

Out of scope: no change to `CodexRuntime` / `ClaudeCodeRuntime` behavior, the
refactor's invariants, or any other capability spec. The `aio-sandbox-execution`
refactor invariants already merged consistently and need no fix.

## Impact

- Affected specs: `agent-runtime` (5 MODIFIED requirements).
- Affected code: none.
- Risk: low — prose-only reconciliation; behavioral requirements and scenarios
  are preserved verbatim except where they named a removed method.
