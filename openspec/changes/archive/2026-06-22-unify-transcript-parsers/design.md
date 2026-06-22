## Context

Transcript reading today is a half-abstraction. The dispatcher
(`apps/api/src/sandbox/parse-transcript.ts`) maps a runtime's
`transcriptFormat` to a parser with a hardcoded ternary, and both parsers share
the signature `parse(jsonl: string): ParsedRollout`. The read layer
(`AioSandboxProvider.readRolloutFromContainer`) bakes in a single-newest-JSONL-file
assumption driven by `TranscriptArtifact { dir, filenameGlob }`. Four production
call sites depend only on the stable `parseTranscript(jsonl, format)` facade: MCP
`get_transcript`, the `/v1` transcript controller, the console session-history
controller, and the durable capture/backfill service.

Two pressures motivate this change:

1. **Extensibility.** A future opencode runtime is NOT single-file JSONL — it
   persists session/message/part records. Under the current shape, adding it means
   editing five places (the `TranscriptFormat` union, the ternary, the read
   assumption, plus parser wiring on both the read and dispatch sides).
2. **Existing gaps.** The codex parser emits a raw-JSON-string `args` instead of a
   human-readable command, does not strip the exec output wrapper, does not dedup
   adjacent user turns, and renders `<environment_context>` as operator text. The
   claude parser never emits the tool dimension (`tool_use` / `tool_result` /
   `thinking`) at all.

Constraint: durable archives store RAW JSONL keyed by runtime format, so parser
fixes re-run cleanly on re-read — there is no data migration, but the parsers are
the single point of truth for what history renders. The `ParsedRollout`
(`{ turns: SessionTurn[] }`) contract and the four call-site signatures must stay
stable.

This is grounded in `proposal.md`; specs in `specs/` carry the testable
requirements.

## Goals / Non-Goals

**Goals:**

- Replace the format ternary with a `Record<TranscriptFormat, TranscriptParser>`
  registry so a new runtime registers a parser additively.
- Widen parser input from `parse(jsonl: string)` to `parse(source: TranscriptSource)`
  where `TranscriptSource` is a discriminated union — today only the JSONL-bearing
  variants, but shaped to admit a non-single-file `opencode-parts` variant.
- Make the read layer runtime-declared (`readTranscriptSource`) so the
  single-newest-JSONL read becomes one strategy among possibly many, instead of a
  baked-in assumption.
- Close the codex/claude per-tool extraction gaps in the shared `SessionTurn`
  shape, reusing the existing tool-card and 「推理」 render paths.
- Pin current output as golden characterization fixtures FIRST (Part 1 asserts
  byte-identical), then intentionally update only the assertions Part 2 changes.

**Non-Goals:**

- No frontend or `@cap/contracts` change. Reasoning maps to the existing
  `assistant{isFinalAnswer:false}` channel, not a new `reasoning` kind.
- No change to the four call-site signatures; `parseTranscript`'s facade stays
  stable.
- No Zod-schema-per-format type enhancement (recorded as an open question).
- The actual opencode runtime is out of scope — we only shape the seam so it can
  drop in later.
- The inert `agent-runtime/claude-transcript.ts` exit-detection parser is untouched;
  the fixes target the `sandbox/` render parsers.
- System-turn merge stays OUTSIDE the parser (in the controller/service) and does
  not move.

## Decisions

### D1 — Registry over ternary, keyed by `TranscriptFormat`

`parseTranscript` dispatches through `Record<TranscriptFormat, TranscriptParser>`
instead of a ternary. The facade keeps its `(jsonl, format)` external signature for
the four call sites by constructing the JSONL-bearing `TranscriptSource` variant
internally. Adding a format becomes one union member + one registry entry.

*Alternative considered:* a `parser` method on the AgentRuntime port. Rejected — the
port must stay a dependency-light leaf that never imports the sandbox parsers or
`@cap/contracts`; ownership of parsers belongs in the sandbox layer.

### D2 — `TranscriptSource` discriminated union as parser input

`parse(source: TranscriptSource)` where today
`{ format: 'codex-rollout' | 'claude-jsonl', jsonl: string }`, extensible to
`{ format: 'opencode-parts', messages: ... }`. This is the pivot that lets a
multi-record runtime feed the same parser port without forcing every parser to
pretend its input is a single JSONL string.

*Alternative considered:* keep `parse(jsonl: string)` and have opencode pre-serialize
its records into one synthetic JSONL blob. Rejected — it would smuggle a fake file
format and lose the per-record structure parsers actually need.

### D3 — Read layer becomes runtime-declared (`readTranscriptSource`)

Generalize `readRolloutFromContainer`'s single-newest-file read behind a
runtime-declared source-read strategy. The runtime port is extended so a runtime
declares HOW its source is read, not only WHERE (`dir`) and WHAT (`format`). Codex
and claude keep the existing single-JSONL `TranscriptArtifact { dir, filenameGlob }`
read verbatim; opencode could later declare a multi-record read. The leaf port still
owns no parser implementation.

*Alternative considered:* refactor only the parser and leave the read assumption in
place. Rejected — it would leave opencode blocked on the read side after the parser
seam was already clean, defeating the "four additive edits" goal.

### D4 — Codex parser fixes dispatch on tool name BEFORE extracting

`apply_patch` keeps its raw `input` patch text; `exec_command` → `arguments.cmd`
(string); `shell` / `local_shell` / `container.exec` → `arguments.command` (array,
joined); `workdir` / `timeout_ms` dropped from the human-readable command. Output
cleaning strips the documented exec wrapper grammar (Exit code / Wall time / Total
output lines / `Output:\n` / `(N lines omitted)`) **conservatively** — passthrough on
format mismatch, because the wrapper drifts across codex versions. Adjacent identical
user turns are deduped; `<environment_context>` / `<system-reminder>` wrappers are
filtered so they never render as operator text.

*Alternative considered:* a single generic arg extractor across all tools. Rejected —
codex tool shapes genuinely differ (string `cmd` vs array `command` vs raw patch), so
a per-tool dispatch is both correct and readable.

### D5 — Claude tool dimension with graceful degradation

Emit `tool_use` → ToolTurn via a per-tool field map (`Bash.command`, `Grep.pattern`,
`Read`/`Edit`/`Write`.`file_path`) with a string-vs-object input guard. Pair
`tool_result` (by `tool_use_id` from the subsequent user entry) → output. When a
result file is externalized or missing in the frozen sandbox, degrade to
`[output unavailable]` and NEVER abort. Map `thinking` → reasoning. The
call-pairing primitive (buffer a call by id, attach its output later) is the shared
cross-runtime mechanism introduced by the registry capability.

### D6 — Reasoning reuses the existing channel (no contract change)

Codex reasoning and claude thinking both map to `assistant{isFinalAnswer:false}`,
which the frontend already renders as 「推理」. This holds the contract frozen. The
new-`reasoning`-kind path is recorded as an alternative: it would require an additive
optional union member plus a backward-compat scenario per the wire-transcript-real-data
playbook, for no rendering benefit today.

### D7 — Golden characterization fixtures FIRST

Pin current `SessionTurn[]` output as golden fixtures before any refactor, using the
repo's existing `.test.mjs` + `node --test` mechanism (not vitest snapshots). Part 1
asserts byte-identical output; Part 2 updates only the assertions it intentionally
changes (e.g. codex `args` → human-readable command) and adds positive/honest-omission
pairs plus a new wrapped-output fixture. These tests run standalone (NOT in the CI
gate), so verification must invoke them explicitly while contract-typed code still
passes `turbo typecheck`.

## Risks / Trade-offs

- **Silent regression in the pure refactor** → Part 1 golden fixtures asserted
  byte-identical before any behavior change; Part 2 diffs are reviewed as intentional
  assertion updates, not surprises.
- **`.test.mjs` fixtures are outside the CI gate** → Verification explicitly runs the
  two parser test files; `turbo typecheck` still covers the contract-typed surfaces.
- **Codex exec-wrapper grammar drifts across versions** → Cleaning is conservative
  with passthrough-on-mismatch, so a future wrapper shape degrades to raw output
  rather than corrupting it.
- **Frozen-sandbox claude result files may be missing/externalized** →
  `[output unavailable]` degradation; the parser never throws into the read path.
- **FTS content text shifts when arg-extraction changes `args`** → Accepted and
  additive; durable archives keep RAW JSONL so re-reads reflect the new extraction
  with no migration.
- **Over-abstracting for a runtime not yet built** → Bounded: the union admits exactly
  one future variant shape and the read strategy is runtime-declared; codex/claude keep
  their existing single-file path verbatim, so the refactor pays its way on the gap
  fixes alone even if opencode never lands.

## Migration Plan

No data migration — archives store RAW JSONL keyed by runtime format, so every parser
fix re-runs on re-read. Deployment is a pure code change behind a stable facade:

1. Pin golden fixtures (Part 1) and land the registry/source-union/read-strategy
   refactor asserting byte-identical output.
2. Land Part 2 parser fixes with intentionally updated assertions + new fixtures.
3. Deploy normally; history endpoints re-parse on next read.

**Rollback:** revert the commit. Because archives are RAW JSONL, reverting the parser
restores the previous rendering with no data repair.

## Open Questions

- Zod-schema-per-format validation for `TranscriptSource` variants — deferred as
  non-required; would harden parser input but adds a dependency surface.
- Final shape of the `opencode-parts` variant and its `readTranscriptSource` strategy
  — only the seam is shaped now; the concrete variant is pinned when the opencode
  runtime actually lands.
