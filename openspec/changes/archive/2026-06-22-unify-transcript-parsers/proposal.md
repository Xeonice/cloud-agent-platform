## Why

The transcript-parse seam is a half-abstraction: `parse-transcript.ts` dispatches
with a hardcoded `switch(format)` ternary to `parseRollout` / `parseClaudeTranscript`
(both `(jsonl: string)`), and the read layer (`readRolloutFromContainer`) bakes in a
single-newest-JSONL-file assumption — so adding a third runtime (opencode, which is
NOT single-file JSONL but session/message/part records) requires touching five
places, and the two existing parsers carry real extraction gaps. Tightening this into
a `TranscriptParser` registry over a `TranscriptSource` discriminated union now lets a
future opencode runtime drop in as four additive edits, and lets us close the
codex/claude per-tool gaps in one shared shape instead of three.

## What Changes

Part 1 — registry refactor (pure, behavior-preserving):

- Replace the `parse-transcript.ts` format ternary with a
  `Record<TranscriptFormat, TranscriptParser>` registry; widen the parser input from
  `parse(jsonl: string)` to `parse(source: TranscriptSource)` where `TranscriptSource`
  is a discriminated union (`{ format: 'codex-rollout' | 'claude-jsonl', jsonl }` today,
  extensible to `{ format: 'opencode-parts', messages }`).
- Abstract the read layer into a runtime-declared `readTranscriptSource` so codex/claude
  keep the single-JSONL read while opencode can declare a multi-record read strategy —
  the read abstraction, not just the parser, becomes runtime-declared.
- Keep `parseTranscript`'s external signature stable for its four production call sites
  (MCP `get_transcript`, `/v1` transcript, console session-history, durable
  capture/backfill) — dispatcher, frontend, and contract stay untouched.
- Pin current SessionTurn[] output as golden characterization fixtures FIRST and assert
  byte-identical after the refactor, using the repo's existing `.test.mjs` + `node --test`
  mechanism (not vitest snapshots).

Part 2 — codex/claude parser fixes (added behavior; golden assertions updated intentionally):

- **Codex command extraction (2.A):** dispatch on tool name BEFORE extracting —
  `apply_patch` keeps its raw `input` patch text; `exec_command` → `arguments.cmd`
  (string); `shell` / `local_shell` / `container.exec` → `arguments.command` (array,
  joined); drop `workdir` / `timeout_ms` from the human-readable command. Replaces the
  current raw-JSON-string `args`.
- **Codex output cleaning (2.B):** strip the documented exec wrapper grammar (Exit code
  / Wall time / Total output lines / `Output:\n` / `(N lines omitted)`) conservatively —
  passthrough on format mismatch given cross-version drift. Net-new; needs a new fixture.
- **Codex dedup + environment_context (2.C/2.D):** dedup adjacent identical user turns;
  filter/degrade the `<environment_context>` / `<system-reminder>` wrapper so it is not
  rendered as operator text (net-new branch on the event_msg user path).
- **Claude tool dimension (genuinely-undone remainder, previously deferred):** emit
  `tool_use` → ToolTurn via a per-tool field map (Bash.command, Grep.pattern,
  Read/Edit/Write.file_path) with a string-vs-object input guard; pair
  `tool_result` (by `tool_use_id` from the subsequent user entry) → output, with a
  graceful `[output unavailable]` degradation for externalized/missing result files in
  the frozen sandbox (never abort); map `thinking` → reasoning. Target the `sandbox/`
  render parser, not the inert `agent-runtime/` exit-detection parser.
- **Reasoning channel (decision):** map codex reasoning / claude thinking to the existing
  `assistant{isFinalAnswer:false}` channel the frontend already renders as 「推理」
  (zero contract change) rather than adding a new `reasoning` kind; the new-kind path is
  recorded as a design alternative.

## Capabilities

### New Capabilities

- `transcript-parser-registry`: A `TranscriptParser` port keyed by `TranscriptFormat`
  in a registry, fed by a runtime-declared `readTranscriptSource` producing a
  `TranscriptSource` discriminated union — the shared deserialize→classify shape and the
  cross-runtime call-pairing primitive (buffer call by id, attach output later) that
  lets a new runtime register a parser without touching the dispatcher, read layer
  hardcoding, frontend, or contract.

### Modified Capabilities

- `session-history-replay`: The codex and claude parsers extract human-readable tool
  commands (codex per-tool: exec_command/shell/local_shell/container.exec/apply_patch),
  clean codex exec output wrappers, dedup adjacent user turns, filter codex
  environment_context, and the claude parser additionally emits tool_use/tool_result/
  thinking turns (paired by tool_use_id, with frozen-sandbox output degradation) — all
  reusing the existing tool-card and 「推理」 rendering with no frontend change.
- `agent-runtime`: The per-runtime "transcript artifact location and format" declaration
  is extended so the runtime also declares how its source is read (`readTranscriptSource`
  strategy), not only where/what format — the leaf port still owns no parser
  implementation and never imports the sandbox parsers or `@cap/contracts`.
- `sandbox-provider-port`: `readRolloutFromContainer`'s single-newest-file read is
  generalized behind a runtime-declared source-read strategy so multi-record runtimes
  can supply a non-single-JSONL source without breaking the codex/claude single-file path.

## Impact

- Code: `apps/api/src/sandbox/parse-transcript.ts` (ternary → registry), `rollout-parser.ts`
  (codex extraction/cleaning/dedup/env_context), `sandbox/claude-transcript-parser.ts`
  (tool_use/tool_result/thinking), `agent-runtime/agent-runtime.port.ts` (read-source
  declaration), `aio-sandbox.provider.ts` + `sandbox-provider.port.ts`
  (`readRolloutFromContainer` generalization).
- Tests: `rollout-parser.test.mjs` and `claude-transcript-parser.test.mjs` — Part 1
  golden characterization fixtures pinned first; Part 2 updates the changed assertions
  (e.g. codex `args` becomes a human-readable command) and adds positive/honest-omission
  pairs plus a new wrapped-output fixture. These run standalone (not in the CI gate), so
  verification must invoke them explicitly while contract changes still pass
  `turbo typecheck`.
- Call sites (unchanged signature): MCP `get_transcript`, `/v1` transcript controller,
  console session-history controller, durable capture/backfill service.
- Contract: no change under the chosen reuse-the-reasoning-channel decision (a new
  `reasoning` kind would otherwise need an additive optional union member + backward-compat
  scenario per the wire-transcript-real-data playbook).
- Data/migration: none — durable archives store RAW JSONL keyed by runtime format, so
  every parser fix re-runs cleanly over historical data on re-read; FTS content text may
  shift when arg-extraction changes args (acceptable, additive). System-turn merge stays
  OUTSIDE the parser in the controller/service and must not move.
- Out of scope: Zod-schema-per-format type enhancement (non-required; recorded as an
  open question), and the inert `agent-runtime/claude-transcript.ts` exit-detection parser.
