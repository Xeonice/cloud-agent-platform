# Verification Report — unify-transcript-parsers

Adversarial three-way routing of verify findings. The raw-unmet list handed to this
pass was empty (`[]`); every requirement below was re-traced end-to-end against the
actual implementation and confirmed **MET**. No requirement re-opened as a code task;
no requirement routed to a spec defect.

## Adjudication tally

- **verify-reopened (UNMET → code task):** 0
- **spec-defects (ambiguous/untestable → Open Questions):** 0
- **reclassified MET:** 14

## MET requirements (re-traced end-to-end)

### transcript-parser-registry/spec.md

1. **A TranscriptParser port is keyed by TranscriptFormat in a registry** — MET.
   `apps/api/src/sandbox/parse-transcript.ts` defines
   `const REGISTRY: { [F in TranscriptFormat]: TranscriptParser<F> }` and
   `parseTranscript` dispatches via `REGISTRY[format].parse(source)`. No `switch`/ternary
   on the format literal. The `Record` over the union makes the mapping total at compile
   time, so a new format forces a registry entry. The `AgentRuntime` port
   (`agent-runtime.port.ts`) declares only `transcriptFormat` and imports no parser.

2. **TranscriptSource is a format-tagged discriminated union** — MET.
   `apps/api/src/sandbox/transcript-source.ts` defines the union tagged by `format`
   (`'codex-rollout'` / `'claude-jsonl'`, both carrying `jsonl: string`) plus
   `TranscriptSourceFor<F>` for per-parser narrowing. The doc-comment and shape admit a
   future `{ format: 'opencode-parts'; … }` variant additively. Each parser reads its own
   narrowed variant (`source.jsonl`).

3. **parseTranscript keeps a stable external signature for its four call sites** — MET.
   The external surface stays `parseTranscript(jsonl, format)`; the `{ format, jsonl }`
   source is built internally by `jsonlSource()` before the registry lookup, so the union
   never leaks to callers. All four call sites use `parseTranscript(jsonl, format)`.

4. **The registry exposes the cross-runtime call-pairing primitive** — MET.
   `apps/api/src/sandbox/transcript-call-pairing.ts` provides `CallPairing<T>` with
   `registerCall(id, turn)` / `attachOutput(id, output)`. An unmatched call keeps
   `output: null`; an orphan output is silently ignored (never throws). Both parsers reuse
   it, each supplying only its id field (codex `call_id`, claude `tool_use_id`).

### agent-runtime/spec.md

5. **Transcript artifact location and format are declarative per-runtime capabilities**
   — MET. The port declares `transcriptArtifact(ctx) → { dir, filenameGlob }`,
   `transcriptFormat`, and the new `readTranscriptSource: TranscriptReadStrategy`
   (`{ kind: 'single-newest-jsonl' }`). The port imports neither the sandbox parsers nor
   `@cap/contracts` and contains no container/exec I/O — it stays a leaf. The strategy
   union is shaped for a future non-single-JSONL variant without editing codex/claude.

### sandbox-provider-port/spec.md

6. **The transcript read is generalized behind a runtime-declared source-read strategy**
   — MET. `aio-sandbox.provider.ts` `readRolloutFromContainer` resolves WHERE from
   `transcriptArtifact(ctx)`, dispatches on `runtime.readTranscriptSource.kind ===
   'single-newest-jsonl'`, and returns `TranscriptSource | null` (`{ format, jsonl }`).
   The `jsonl` is the byte-identical lexicographically-newest matching file
   (`readSingleNewestJsonl`). Every miss path (no container / no match / unreadable)
   returns `null`; the method never throws.

### session-history-replay/spec.md

7. **Codex tool turns carry a human-readable command extracted per tool name** — MET.
   `rollout-parser.ts` `extractCommand()` dispatches on tool name BEFORE arg extraction:
   `apply_patch` → raw `input`; `exec_command` → `arguments.cmd`;
   `shell`/`local_shell`/`container.exec` → `arguments.command` joined by single spaces
   (dropping `workdir`/`timeout_ms`); absent/wrong-type field falls back to the raw string.

8. **Codex exec output is conservatively stripped of the documented wrapper grammar** —
   MET. `stripExecOutputWrapper()` gates on the `Exit code:`/`Wall time:`/`Total output
   lines:` header prefix AND the `Output:\n` cut point, keeps the body, drops a trailing
   `(N lines omitted)` marker, passes through unchanged on mismatch, and never empties a
   body-carrying output.

9. **Codex adjacent duplicate user turns are deduplicated** — MET. The `pushUser()`
   closure suppresses an immediately-adjacent identical user turn (the event_msg vs
   response_item double-write) while preserving non-adjacent duplicates.

10. **Codex environment_context user wrappers are filtered from operator text** — MET.
    `stripEnvironmentWrapper()` runs on the `event_msg user_message` path: a pure-wrapper
    payload yields `''` (no turn); a wrapped operator message degrades to only the
    operator text. It targets `<environment_context>`/`<system-reminder>`, which
    `stripPromptWrapper`'s `<x instructions>` regex does not match.

11. **The Claude parser emits tool_use turns with a per-tool command field** — MET.
    `claude-transcript-parser.ts` `TOOL_ARG_FIELD` + `toolArgsFor()` map
    `Bash.command` / `Grep.pattern` / `Read|Edit|Write.file_path`; `normalizeToolInput()`
    parses pre-v2.1.92 JSON-string inputs; unmapped/absent fields fall back to a stable
    serialization. The tool turn carries `name` + extracted `args`.

12. **The Claude parser pairs tool_result to tool_use by tool_use_id with frozen-sandbox
    degradation** — MET. The shared `CallPairing` pairs `tool_result` (in a subsequent
    `type:user` entry) to its `tool_use` by id; an unmatched call keeps `output: null`;
    an externalized/missing/unreadable result degrades to the `[output unavailable]`
    marker (`OUTPUT_UNAVAILABLE`) without aborting; tool_result-only user entries emit no
    spurious user turn.

13. **Codex reasoning and Claude thinking map to the existing assistant commentary
    channel** — MET. Claude `thinking` blocks → `assistant{isFinalAnswer:false}`. Codex
    reasoning/commentary surfaces via `event_msg → agent_message` with `phase:
    'commentary'` → `isFinalAnswer: phase === 'final_answer'` (i.e. `false` for
    commentary); the raw `reasoning` response_item is intentionally skipped as an
    encrypted duplicate so it is not double-rendered. No new `reasoning` contract kind is
    introduced; final-answer turns stay `isFinalAnswer: true`.

14. **The fixed parsers preserve prior wire-transcript behaviors and re-run over raw
    archives without migration** — MET. No migration step; parsers read raw JSONL.
    Codex session totals (`totalTokens`/`durationMs`), `apply_patch` diffstat, per-turn
    `at`, and phase-keyed final-answer categorization are preserved. Neither parser emits
    a `system` turn (those merge in the controller/service). New claude tool/thinking
    turns carry `at` from their source line when a `timestamp` is present (omitted, never
    fabricated, when absent).

## Gap finding (no missing implementations)

The skeptic's completeness sweep found NO requirement lacking an implementation: every
requirement in all four spec files has a traceable, exercised implementation (enumerated
above). There is no requirement that is unimplemented. This finding is folded in as a
confirmation, not a reopened task.

## Scope findings (extra behaviors with no spec requirement)

These behaviors exist in the change but are NOT covered by any spec requirement. They are
recorded here as scope observations. None is an unmet requirement (nothing required is
missing) and none is a spec defect (no requirement is ambiguous/untestable/contradictory),
so none re-opens a code task or routes to Open Questions.

Notably, design.md Non-Goals states "No frontend or `@cap/contracts` change," yet the
frontend transcript view and a new frontend test were modified/added. This is scope creep
relative to a stated Non-Goal — a quality observation, not a requirement failure (no spec
scenario asserts frontend behavior, so nothing is left unsatisfied). Flagged for reviewer
awareness; the parser-layer requirements all remain MET.

Frontend (apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx):
- Removed the `终端记录` navigation link from the transcript page header panel.
- Tool-card args `<code>` changed `truncate` → `whitespace-pre-wrap break-all flex-1`
  (prevents clipping of multiline args).
- Tool output `<pre>` changed `overflow-x-auto` → `whitespace-pre-wrap break-all`
  (line-wraps long lines).
- Tool card icon/label row changed `items-center` → `items-start` (multiline alignment).
- `TxRow` exported (was private) to enable unit testing via `react-dom/server`.
- `TerminalIcon` SVG removed (only used by the deleted `终端记录` link).

Frontend test / config:
- New `apps/web/src/routes/_app/tasks/$taskId_.transcript.test.tsx` asserting `TxRow`
  renders tool/reasoning/final-answer turns — no spec requirement for a frontend test.
- `apps/web/vitest.config.ts` extended to collect `.test.tsx` in addition to `.test.ts`
  (to support the new frontend test).

Claude parser metadata (apps/api/src/sandbox/claude-transcript-parser.ts):
- `durationMs` (session total) computed from last-line timestamp minus `startedAt` — the
  spec covers codex session totals; the claude counterpart is unspecified.
- `cwd` and `startedAt` extracted from the first seen line — no spec requirement for the
  claude parser to populate header metadata.
- `model` extracted from `msg.model` on the first assistant entry into `meta.model` — no
  spec requirement for the claude parser to populate model metadata.

These claude-metadata extras are consistent with the codex parser's existing header
metadata and harmless (additive, honest-omission on absence). They do not regress any
required behavior; recorded for traceability only.
