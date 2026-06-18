# Design

## Context

`openspec/specs/agent-runtime/spec.md` is the merge of two archived changes'
deltas: `add-claude-code-runtime` (9 requirements describing a method-bag port)
and `refactor-agent-runtime-policy-mechanism` (5 ADDED invariants describing the
policy/mechanism port). The refactor's ADDED-only authoring left the earlier
requirements naming removed/renamed methods. This change reconciles them.

## Goals / Non-Goals

- **Goal**: the live `agent-runtime` spec describes exactly ONE port shape — the
  shipped policy/mechanism one — with no requirement naming a method that no
  longer exists.
- **Goal**: preserve every behavioral requirement and scenario; only the
  method-name framing changes.
- **Non-Goal**: no code change, no behavior change, no edit to the refactor's
  invariants or any other capability.

## Decisions

- **MODIFIED, not REMOVED.** Each of the five requirements still carries a real
  behavioral contract (env-token auth, fail-closed on missing token, no injected
  Enter, asciicast-primary replay, behavior-preserving codex extraction). We
  keep the requirement and its scenarios and only rewrite the clauses that named
  a removed method. Removing the requirements would drop those behavioral
  contracts; the refactor's invariants are architectural and do not restate
  them.

- **Titles are preserved** so OpenSpec matches each `## MODIFIED` block to the
  existing requirement by title and replaces it in place. (The title
  "ClaudeCodeRuntime autosubmit is a no-op" is kept even though the body now
  speaks of `terminalStartup` — the concept "claude does not auto-submit" is
  still accurate; renaming the title would turn this into a RENAME+ADD and risk
  an orphaned duplicate.)

- **No duplication of the refactor's invariants.** The refactor already added
  "Terminal startup is declarative", "A single AgentRuntime interface…", "The
  runtime is a policy object…". The MODIFIED requirements reference those
  concepts (e.g. cross-reference the policy-object requirement) rather than
  re-asserting them, so the two layers stay complementary, not redundant.

- **Method-name mapping** used consistently across the rewrites:
  - `injectAuth()` → the runtime's declared launch env + `sandboxSetupCommands`
  - `autoSubmit()` → declared `terminalStartup` (`promptSubmit`,
    `replyToStartupDSR`) read by the shared pty mechanism
  - `captureTranscript()` → the shared retention path reading the `--session-id`
    JSONL (not a per-runtime port method)
  - seam set → `buildLaunchLine`, `terminalStartup`, `sandboxSetupCommands`,
    `preStopTrimCommands`, `detectExit`

## Risks

- A MODIFIED requirement whose title does not byte-match the live spec would be
  treated as an ADD (creating a duplicate). Mitigation: titles copied verbatim
  from the live spec; `openspec validate --strict` + a coverage/consistency
  review confirm the merge replaces in place with no duplicate titles.
