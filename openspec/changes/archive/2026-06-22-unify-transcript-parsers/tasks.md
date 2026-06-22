<!-- Track-annotated tasks. Each numbered group is a parallel Track:
     `## N. Track: <kebab-name> (depends: <track>|none)`.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: golden-fixtures (depends: none)

- [x] 1.1 In `apps/api/src/sandbox/rollout-parser.test.mjs`, pin the CURRENT `parseRollout` `SessionTurn[]` output as golden characterization fixtures (real-data JSONL inputs + byte-identical expected output) covering at least one `exec_command`/`shell`-family call, an `apply_patch`, a reasoning event, an `event_msg` user turn, and the session totals — asserting the pre-refactor behavior verbatim.
- [x] 1.2 In `apps/api/src/sandbox/claude-transcript-parser.test.mjs`, pin the CURRENT claude `SessionTurn[]` output as golden characterization fixtures (user + assistant text turns, `tool_use`/`tool_result`/`thinking` currently dropped), asserting the pre-refactor behavior verbatim.
- [x] 1.3 Confirm both fixture suites run standalone via `node --test` and pass against the unmodified parsers (establishes the Part 1 byte-identical baseline before any refactor).

## 2. Track: parser-registry-source (depends: golden-fixtures)

- [x] 2.1 In `apps/api/src/sandbox/parse-transcript.ts`, define the `TranscriptSource` discriminated union (`{ format: 'codex-rollout', jsonl }` and `{ format: 'claude-jsonl', jsonl }`) tagged by `format`, shaped to admit a future `{ format: 'opencode-parts', messages }` variant additively.
- [x] 2.2 Define the `TranscriptParser` port (`parse(source: TranscriptSource): ParsedRollout`) and a `Record<TranscriptFormat, TranscriptParser>` registry mapping each format literal to exactly one parser; remove the `switch`/ternary on the format literal.
- [x] 2.3 Rewrite `parseTranscript` to construct the `{ format, jsonl }` `TranscriptSource` internally from its existing `(jsonl, format)` arguments and dispatch via a registry lookup — keeping the external signature byte-stable for the four call sites (MCP `get_transcript`, `/v1` transcript, console session-history, durable capture/backfill).
- [x] 2.4 Adapt the codex (`rollout-parser.ts`) and claude (`claude-transcript-parser.ts`) parser entry points to the `parse(source)` port shape (read `source.jsonl` of their own narrowed variant) without changing extraction behavior yet.
- [x] 2.5 Extract the cross-runtime call-pairing primitive (buffer a tool call by id, attach its matching output later; unmatched call still emits `output: null`; orphan output handled without throwing) into a SHARED registry-layer helper that takes each parser's id field name (codex `call_id`, claude `tool_use_id`).
- [x] 2.6 Run the Part 1 golden fixtures (tracks 1.1/1.2) and confirm `parseTranscript` output is byte-identical post-refactor.

## 3. Track: read-strategy-port (depends: parser-registry-source)

- [x] 3.1 In `apps/api/src/agent-runtime/agent-runtime.port.ts`, extend the port to declare a `readTranscriptSource` source-read strategy alongside `transcriptArtifact(ctx)` and `transcriptFormat`; keep the port a leaf that imports neither the sandbox parsers nor `@cap/contracts` and contains no container/exec I/O.
- [x] 3.2 In `codex-runtime.ts` and `claude-code-runtime.ts`, declare the single-newest-JSONL `readTranscriptSource` strategy that yields a `{ format, jsonl: string }` source (WHERE/WHAT unchanged), expressible such that a future multi-record runtime declares a non-single-JSONL strategy without editing these.
- [x] 3.3 In `apps/api/src/sandbox/sandbox-provider.port.ts`, generalize the `readRolloutFromContainer` contract to return a `TranscriptSource` (instead of a bare string) produced via the runtime-declared read strategy.
- [x] 3.4 In `apps/api/src/sandbox/aio-sandbox.provider.ts`, resolve WHERE from `transcriptArtifact(ctx)` and HOW from the runtime's `readTranscriptSource`, returning a `{ format, jsonl }` source whose `jsonl` is byte-identical to the prior lexicographically-newest-file read; preserve the non-throwing null-on-miss contract (no container / no match / unreadable → absent source).
- [x] 3.5 Update `aio-sandbox.provider.test.mjs` for the generalized return type and verify the codex/claude single-file read still yields the same content and the read-miss still resolves to an absent source.

## 4. Track: codex-parser-fixes (depends: parser-registry-source)

- [x] 4.1 In `apps/api/src/sandbox/rollout-parser.ts`, dispatch on tool name BEFORE arg extraction: `exec_command` → `arguments.cmd`; `shell`/`local_shell`/`container.exec` → `arguments.command` joined with single spaces; `apply_patch` keeps raw `input` patch text; drop `workdir`/`timeout_ms`; guard shape and fall back to the raw arguments string on absent/wrong-type field.
- [x] 4.2 Add conservative exec-output wrapper stripping: keep content after the `Output:\n` cut point, recognize the `Exit code:`/`Wall time:`/`Total output lines:` prefix and `(N lines omitted)` marker, pass through unchanged on format mismatch, and never empty a body-carrying output.
- [x] 4.3 Deduplicate ADJACENT identical user turns (event_msg vs response_item double-write) while preserving non-adjacent identical user turns.
- [x] 4.4 Filter `<environment_context>` / `<system-reminder>` wrappers on the `event_msg` user path: a pure-wrapper payload emits no user turn; a wrapped operator message degrades to only the operator text (the `stripPromptWrapper` regex does not match these tags).
- [x] 4.5 Map the codex reasoning event to an `assistant` turn with `isFinalAnswer: false` (existing 「推理」 channel, zero contract change); keep final-answer turns `isFinalAnswer: true`.
- [x] 4.6 In `rollout-parser.test.mjs`, intentionally update the changed golden assertions (raw-`args` → human-readable command), add positive/honest-omission pairs for each extraction branch, add a new wrapped-output fixture, and assert diffstat / session totals / phase-keyed final-answer / no `system` turns are unchanged.

## 5. Track: claude-parser-fixes (depends: parser-registry-source)

- [x] 5.1 In `apps/api/src/sandbox/claude-transcript-parser.ts`, emit a `tool` turn per `tool_use` block via a per-tool field map (`Bash.command`, `Grep.pattern`, `Read`/`Edit`/`Write`.`file_path`) carrying tool `name` + extracted `args`; guard string-vs-object `input` (parse pre-v2.1.92 JSON-string inputs) and fall back to a stable serialization for unmapped tools / absent fields.
- [x] 5.2 Pair `tool_result` to its `tool_use` by `tool_use_id` (results live in a SUBSEQUENT `type: user` entry) using the shared call-pairing primitive: attach output, emit `output: null` for an unmatched `tool_use`, and consume `tool_result`-only user entries without emitting a spurious user turn.
- [x] 5.3 Degrade an externalized/missing/unreadable frozen-sandbox result to the `[output unavailable]` marker rather than aborting the parse.
- [x] 5.4 Map `thinking` content blocks to an `assistant` turn with `isFinalAnswer: false` (existing 「推理」 channel, zero contract change), distinct from final-answer turns.
- [x] 5.5 Carry `at` from the source line on new tool/thinking turns when a `timestamp` is present (omit, never fabricate, when absent).
- [x] 5.6 In `claude-transcript-parser.test.mjs`, update the golden assertions to include the new tool_use/tool_result/thinking turns, add positive/honest-omission pairs (incl. `[output unavailable]` degradation and unmatched-call null output), and assert no `system` turns and unchanged user/assistant text behavior.

## 6. Track: verification (depends: read-strategy-port, codex-parser-fixes, claude-parser-fixes)

- [x] 6.1 Run the standalone parser test files explicitly (`node --test` on `rollout-parser.test.mjs`, `claude-transcript-parser.test.mjs`, `aio-sandbox.provider.test.mjs`) and confirm all pass (these are OUTSIDE the CI gate, so they must be invoked directly). — rollout 56/56, claude 34/34, aio 109 passed / 1 failed where the SOLE failure (`pre-stop trim drops the codex cache + sqlite logs`) is pre-existing on HEAD and unrelated to this change (this change actually REMOVED a second pre-existing aio failure: the `readRolloutFromContainer` TypeError, now that the read returns a `TranscriptSource`).
- [x] 6.2 Run `turbo typecheck` across the contract-typed surfaces (parse-transcript registry, ports, provider, call sites) and confirm the four call sites compile unchanged and `@cap/contracts` is untouched. — `turbo typecheck` 9/9 successful; all four `parseTranscript(jsonl, format)` call sites unchanged; `packages/contracts` working-tree clean.
- [x] 6.3 Confirm a historical RAW-JSONL archive re-parses through the fixed parsers without error or migration step (re-read path), validating the no-migration claim. — re-read check (12/12) drove historical codex-rollout + claude-jsonl RAW JSONL (incl. malformed lines + an externalized claude result) through the public `parseTranscript` facade: no throw, valid `ParsedRollout`, tool/推理/final-answer turns recovered, no migration.
