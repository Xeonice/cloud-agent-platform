# Research Brief — unify-transcript-parsers

Synthesis of explore-phase research across three routes (Web prior-art, Codebase
seams, Archive precedent) for the change that tightens the existing
format-keyed transcript-parse dispatch into a `TranscriptParser` registry,
fixes the codex/claude per-tool extraction gaps, and prepares for an opencode
third runtime without touching the dispatcher, frontend, or contract.

---

## Web route — prior-art parsers and runtime data shapes

External research into existing transcript-parsing tools (claude-code-log,
claude-code-trace, causetrace, codex-trace, opencode) and the official
codex/claude/opencode data shapes.

### F-W1 — No importable parsing library; hand-written defensive parser is the norm

There is no off-the-shelf library for parsing codex/claude transcripts. Every
prior-art tool (claude-code-log ~90 commits/30+ versions, claude-code-trace,
causetrace, codex-trace) hand-writes a defensive parser with each field
optional. The existing cap parsers (`rollout-parser.ts`,
`claude-transcript-parser.ts`) already follow this pattern: every field cast
through optional checks, malformed lines skipped not aborted.

- Evidence: `https://deepwiki.com/daaain/claude-code-log` ;
  `https://deepwiki.com/delexw/claude-code-trace/2.1.1-entry-deserialisation-and-classification` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/rollout-parser.ts:27-29`
- Implication: validates the "no external lib, hand-written defensive parser"
  non-goal — the unified `TranscriptParser` interface keeps the existing
  per-field-optional discipline, no parsing dependency adopted.

### F-W2 — Codex emits TWO shell tools with INCOMPATIBLE argument shapes

Legacy `shell` takes `command` as an argv array (`Vec<String>`) plus optional
`workdir`/`timeout_ms`; newer `exec_command` takes `cmd` as a single
shell-string. Codex Issue #20875 documents models over-quoting operators in
`exec_command.cmd` (e.g. `cmd: "rtk read package.json '|' sed -n 1p"` where
`'|'` becomes a literal). The Part 2.A extractor must branch on tool name AND
handle both `cmd` (string) and `command` (array → join).

- Evidence: `https://github.com/openai/codex/issues/20875` ;
  `https://developers.openai.com/codex/cli/reference` (shell schema: command
  array, workdir, timeout_ms, required:[command])
- Implication: defines Part 2.A field extraction — `exec_command` →
  `arguments.cmd` (string), `shell`/`local_shell` → `arguments.command` (array,
  join with spaces), both may carry `workdir`/`timeout_ms` to drop from the
  human-readable command. `rollout-parser.ts:220-223` currently passes the
  whole arguments JSON string raw — the exact bug to fix.

### F-W3 — apply_patch body lives in `input`, not a JSON arguments object

`apply_patch`'s patch body is raw `*** Begin Patch / *** Update File / @@ / +/-
/ *** End Patch` text in the `input` field of a custom_tool_call, NOT in a JSON
arguments object. The existing rollout-parser already special-cases apply_patch
for diffstat (`patchDiffstat` at `rollout-parser.ts:102-112`) and stores the raw
input as args — correct to keep per Part 2.A ("apply_patch 保持 raw patch 文本").

- Evidence: `https://github.com/openai/codex/issues/15003` ; causetrace example
  `{"tool":"apply_patch","input":"*** Begin Patch\n*** Update File: src/index.ts\n@@\n-const foo = 1\n+const foo = 2\n*** End Patch"}` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/rollout-parser.ts:216-235`
- Implication: the extractor must dispatch BEFORE extracting cmd —
  apply_patch → raw input, exec/shell → extract command. The existing diffstat
  logic is already aligned.

### F-W4 — Codex exec output wrapper has a documented fixed shape

`Exit code: 0\nWall time: 1.23 seconds\nTotal output lines: 5000\nOutput:\n[first
100 lines]\n... (N lines omitted) ...\n[last 100 lines]` — token-aware head/tail
truncation. Part 2.B's "split on `Output:\n`" is the right cut point, but the
wrapper also carries the Exit code/Wall time/Total output lines prefix and a
`(N lines omitted)` middle marker that drift across versions.

- Evidence: `https://medium.com/jonathans-musings/inside-the-agent-harness-how-codex-and-claude-code-actually-work-63593e26c176` ;
  `https://github.com/openai/codex/issues/14750` (UnifiedExec verbose exec wrappers)
- Implication: gives Part 2.B the exact wrapper grammar to strip (Exit
  code/Wall time/Total output lines/Output:) and confirms the version-drift risk
  that mandates the "format 不匹配则原样保留" conservative fallback.

### F-W5 — Claude JSONL content blocks and tool_use ↔ tool_result pairing

Claude Code content blocks are: text, thinking (extended thinking, plain text),
tool_use (id/name/input), tool_result (tool_use_id + content which is string OR
array). tool_result blocks live in a SUBSEQUENT `type:user` entry and pair to
tool_use by `tool_use_id`. The current `claude-transcript-parser.ts` ONLY reads
`type==='text'` blocks (`claudeContentText` at lines 40-53) and explicitly skips
user records that are pure tool_result — so tool_use/tool_result/thinking are
100% dropped.

- Evidence: `https://claude-dev.tools/docs/jsonl-format` ;
  `https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/claude-transcript-parser.ts:40-53,92-97`
- Implication: confirms the claude tool-turn gap and the precise pairing
  mechanism (tool_use.id ↔ tool_result.tool_use_id across user/assistant
  entries). The parser must buffer tool_use by id and attach the later
  user-entry tool_result, mirroring codex's call_id buffering already in
  `rollout-parser.ts:143`.

### F-W6 — Claude tool_use input is tool-specific; needs a per-tool field map

Claude tool_use input is tool-specific (Bash→{command}, Read→{file_path},
Edit→{file_path,old_string,new_string}, etc.), so claude's "extract
human-readable command" must per-tool-name pull the salient field
(Bash.command, Grep.pattern, Read/Edit/Write.file_path) — analogous to codex's
per-tool cmd extraction. Pre-v2.1.92 Claude stored tool inputs as JSON strings
(needing re-parse); claude-code-trace normalizes this — a version-drift guard
worth replicating.

- Evidence: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use` ;
  `https://deepwiki.com/delexw/claude-code-trace/2.1.1-entry-deserialisation-and-classification`
  (pre-v2.1.92 tool inputs as JSON strings → parse into objects)
- Implication: the claude tool-turn extractor needs a per-tool field map and a
  string-vs-object input guard, paralleling the codex exec_command extractor —
  both can share a "tool name → command field" strategy under the unified port.

### F-W7 — Large Claude tool_result outputs are externalized to disk files

The JSONL holds a path reference rather than inline content; mining tools report
"tool-result files pollute palace" and dropped content. In the cap sandbox case
the transcript is read out of a FROZEN container by `readRolloutFromContainer`,
so externalized result files may be unreadable.

- Evidence: `https://github.com/MemPalace/mempalace/issues/111` (tool-result
  files pollute palace, user messages silently dropped) ;
  `https://deepwiki.com/daaain/claude-code-log` (tool results exceeding inline
  threshold persisted as external disk files, parser manages references)
- Implication: validates the task's explicit "claude 大 tool result 外置磁盘
  文件坑" concern. Part 2 must define a read-fail degradation path for
  externalized results in the frozen-sandbox scenario (render the reference/path
  or a `[output unavailable]` marker, never abort), since the container read may
  not have the sidecar file.

### F-W8 — opencode is NOT single-file JSONL; it stores session/message/part records

opencode stores session/message/part as separate JSON (or SQLite) records:
`session/{projectID}/{sessionID}.json`, `message/{sessionID}/{messageID}.json`,
`part/{messageID}/{partID}.json`. Parts are a Zod discriminated union tagged by
`type` (TextPart, ReasoningPart, FilePart, ToolPart{toolName,callID,input,output,state},
StepStart/StepFinishPart with token/cost).

- Evidence: `https://deepwiki.com/sst/opencode/2.2-message-and-prompt-system` ;
  `https://deepwiki.com/sst/opencode/2.9-storage-and-database`
- Implication: confirms Part 1's `TranscriptSource` discriminated union and the
  `readTranscriptSource` declaration — opencode's `{format:'opencode-parts',
  messages}` variant is real (multi-file/SDK/db), so the read-layer abstraction
  (not just the parser) must be runtime-declared. opencode's ToolPart maps
  cleanly onto the SessionTurn ToolTurn (name/args/output) — a good target shape.

### F-W9 — All three runtimes carry reasoning; SessionTurn has no reasoning kind

opencode's part union has a first-class ReasoningPart (with start/end), codex
has reasoning event_msg, claude has thinking blocks. The cap SessionTurn already
has `assistant.isFinalAnswer:false` as a "commentary" channel, but a dedicated
reasoning kind would more faithfully represent thinking/reasoning across all
three.

- Evidence: `https://deepwiki.com/sst/opencode/2.2-message-and-prompt-system`
  (ReasoningPart) ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/packages/contracts/src/session-history.ts`
  (SessionTurn union); `rollout-parser.ts` comment line 22 skips reasoning
  response_items today
- Implication: informs the "SessionTurn 可能需加 reasoning kind" contract
  decision. All three target runtimes produce reasoning, so adding a reasoning
  kind future-proofs the contract for opencode in one place rather than three.
  (See codebase F-C9 for the counter-weight: the frontend already renders
  `assistant + !isFinalAnswer` as reasoning, so reuse is the lighter path.)

### F-W10 — claude-code-trace's deserialize-then-classify pipeline is a design template

Raw JSONL → sanitization → Deserialize to a flat Entry struct → Classify into a
ClassifiedMsg discriminated enum (User/AI/System/Compact/Hook) → chunk
assembly. It rescues hook metadata BEFORE noise-dropping and normalizes version
drift (forked_from pre-v2.1.118, hookSpecificOutput v2.1.163+).

- Evidence: `https://deepwiki.com/delexw/claude-code-trace/2.1.1-entry-deserialisation-and-classification`
- Implication: provides the architecture pattern for Part 1 — a per-format
  deserialize stage (TranscriptSource → raw-entries) feeding a shared classify
  stage (raw-entries → SessionTurn[]). The "rescue before drop" and explicit
  version-range normalization tables are concrete robustness patterns to bake
  into the golden-test fixtures.

### F-W11 — Codex writes duplicate/wrapped streams and environment_context user messages

The response_item `message`/`reasoning` items are wrapper-wrapped/encrypted
DUPLICATES of the event_msg stream (already skipped in cap's parser to avoid
double-render), and environment_context is injected as a user message wrapped in
`<environment_context><cwd>...` / `<system-reminder>` blocks. The existing
`stripPromptWrapper` (`rollout-parser.ts:72-82`) peels `<x instructions>` tags
but does NOT yet handle `<environment_context>`.

- Evidence: `https://github.com/openai/codex/discussions/12668` ;
  `https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide`
  (environment_context as user message, <system-reminder> wrapper) ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/rollout-parser.ts:72-82`
- Implication: confirms Part 2.C (duplicate user_message — codex writes the same
  prompt in event_msg AND response_item) and 2.D (environment_context wrapper
  must be filtered/degraded, not shown as operator text). `stripPromptWrapper`
  is the extension point; it needs an `<environment_context>` branch.

### F-W12 — Vitest snapshot mechanisms for golden tests

Vitest has `toMatchSnapshot()` (inline .snap) and `toMatchFileSnapshot()`
(arbitrary-extension readable file). Fixture-based input (`test.extend`) plus
committed real-rollout fixtures is the standard "pin current output" pattern. The
cap repo already verifies parsers against 211 real codex 0.131 rollouts
(`rollout-parser.ts:10`).

- Evidence: `https://vitest.dev/guide/snapshot.html` ;
  `https://github.com/vitest-dev/vitest/blob/main/docs/guide/snapshot.md` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/rollout-parser.ts:10`
- Implication: answers "golden test 怎么钉住现有 codex/claude 解析输出" — capture
  the CURRENT SessionTurn[] before refactor (zero-diff during Part 1 pure
  refactor), then update snapshots intentionally in Part 2 when
  extraction/cleaning changes output. (Note: codebase F-C12 records the repo's
  actual mechanism is `.test.mjs` + `node --test`, not vitest — reconcile in the
  proposal.)

### F-W13 — Zod discriminated unions are the mature type pattern but non-essential here

opencode and claude-code-viewer define every message/part type as a Zod schema;
the codex app-server exposes a generate-ts path for typed event shapes. This is
the optional "类型增强" the task flags as non-essential; the existing cap parsers
use hand-rolled TS interfaces + runtime `typeof` guards, which is sufficient and
lower-risk for a pure refactor.

- Evidence: `https://deepwiki.com/sst/opencode/2.2-message-and-prompt-system` ;
  `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`
  (app-server generate-ts) ; `https://zod.dev/api` (z.discriminatedUnion)
- Implication: Zod-schema-per-format is the mature type pattern IF the team
  wants validation at the TranscriptSource boundary, but the task correctly
  marks it non-required; the existing interface+typeof-guard style already
  satisfies the defensive requirement without adding Zod to the parse hot path.

### F-W14 — Cross-runtime call-pairing invariant: buffer call by id, attach output later

Codex tool calls are flat and linked by `call_id` (no begin/end nesting);
function_call and matching function_call_output can be separated by many
token_count/reasoning lines, so a parser MUST buffer pending calls by call_id
(cap already does via `toolByCallId` Map). causetrace implements the identical
`pending_calls[call_id]` buffer. This is the cross-runtime invariant (codex
call_id, claude tool_use_id, opencode callID).

- Evidence: `https://dev.to/milkoor/reverse-engineering-codex-cli-rollout-traces-3b9b` ;
  `https://github.com/milkoor/causetrace/blob/main/causetrace/hooks/codex_parser.py`
  (pending_calls keyed by call_id) ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/rollout-parser.ts:143,240,247`
- Implication: all three runtimes share a "buffer call by id, attach output
  later" pairing primitive — the unified `TranscriptParser` port can expose this
  as shared helper logic so each format only declares its id field name,
  reducing the per-parser surface the task wants to minimize for adding opencode.

---

## Codebase route — current seams, blast radius, and test conventions

Investigation of the live code the change will refactor.

### F-C1 — The change is a stub to fill, not a fresh change to create

An active OpenSpec change `unify-transcript-parsers` already exists but contains
ONLY `.openspec.yaml` (schema: spec-driven, created 2026-06-21) — no
proposal.md / design.md / specs / tasks.md.

- Evidence:
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/openspec/changes/unify-transcript-parsers/.openspec.yaml`
  (only file present)
- Implication: the propose step should populate this existing change; the slug
  already matches the proposal's intent.

### F-C2 — The "half-abstraction" is exactly as described

`agent-runtime.port.ts` declares `RuntimeId('codex'|'claude-code')`,
`TranscriptFormat('codex-rollout'|'claude-jsonl')`, per-runtime
`readonly transcriptFormat` + `transcriptArtifact(ctx)`, plus a registry-free
`transcriptFormatForRuntime(runtime)` accessor. `parse-transcript.ts` dispatches
with a ternary on format to `parseRollout` / `parseClaudeTranscript`, both with
signature `(jsonl: string)`.

- Evidence:
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/agent-runtime/agent-runtime.port.ts:30,49,65-69,306-312` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/api/src/sandbox/parse-transcript.ts:13-20`
- Implication: defines the exact seams Part 1 must wrap — the format tag stays
  on the leaf port; the parser+dispatch live in the sandbox layer. A registry
  `Record<TranscriptFormat, TranscriptParser>` replaces the ternary; the
  `parse(jsonl: string)` signature widens to `parse(source: TranscriptSource)`.

### F-C3 — parseTranscript has exactly FOUR production call sites

All identical shape `parseTranscript(jsonl, transcriptFormatForRuntime(runtime))`
or `parseTranscript(jsonl, format)`: MCP get_transcript, /v1 transcript, console
session-history, durable capture/backfill.

- Evidence: `mcp.server.ts:178`; `v1-transcript.controller.ts:119`;
  `tasks/session-history.controller.ts:219`;
  `tasks/session-transcript.service.ts:203-206` (all import from
  `../sandbox/parse-transcript` and call `transcriptFormatForRuntime`)
- Implication: these four are the blast radius. Keeping `parseTranscript`'s
  external signature stable (or adding a thin overload) means dispatcher and
  consumers stay untouched — matches the design goal "introduce opencode without
  touching dispatcher/frontend/contract".

### F-C4 — The read layer assumes ONE file (readRolloutFromContainer)

`readRolloutFromContainer(taskId, runtimeId?)` on the SandboxProvider port,
implemented in `AioSandboxProvider`, resolves WHERE to read from the runtime's
`transcriptArtifact(ctx)` (dir + filenameGlob), pulls a tar via dockerode
getArchive, and returns the lexicographically-newest matching single JSONL file's
text — assuming ONE file. Returns null on any miss; never throws.

- Evidence: `sandbox-provider.port.ts:139-142`;
  `aio-sandbox.provider.ts:619-658` (resolves `transcriptArtifact(ctx)`,
  `extractFilesFromTar`, sorts, returns `files[files.length-1].content.toString('utf8')`)
- Implication: this is the `readTranscriptSource` seam to abstract. codex/claude
  single-JSONL stays as-is; opencode (multi-file SDK/db) needs the runtime to
  declare a different read strategy. Today the read returns a raw string, so
  TranscriptSource for codex/claude is `{format, jsonl:string}`.

### F-C5 — Codex tool args are stored RAW (no per-tool extraction)

For function_call/custom_tool_call the parser sets `args = arguments` JSON string
verbatim (e.g. `{"cmd":"ls src"}`), with no per-tool extraction. The golden test
asserts `exec.args === '{"cmd":"ls src"}'`.

- Evidence: `rollout-parser.ts:215-241`
  (`toolArgs = typeof argsRaw === 'string' ? argsRaw : safeStringify(argsRaw)`);
  `rollout-parser.test.mjs:137`
- Implication: Part 2.A — extracting cmd/command from
  exec_command/shell/local_shell/container.exec will CHANGE this asserted value.
  Golden test line 137 must update to the new human-readable command, and a new
  defensive extractor added. apply_patch already keeps raw `input` (test line 142
  asserts `args === '*** Begin Patch'`).

### F-C6 — Codex output is stored RAW (no wrapper stripping; no fixture)

function_call_output `output` is taken verbatim. The test feeds a clean
`app.tsx\nlogin.tsx` with no Chunk ID/Wall time wrapper, so Part 2.B's wrapper
noise is NOT yet covered by any fixture.

- Evidence: `rollout-parser.ts:243-249` (`turn.output = text` directly);
  `rollout-parser.test.mjs:138` (clean output, no wrapper)
- Implication: Part 2.B (strip `Output:\n` wrapper / Chunk ID / Wall time /
  Process exited noise) is net-new behavior with no existing fixture. A new
  golden fixture with a real wrapped output must be added; the strip must be
  conservative (passthrough on format mismatch).

### F-C7 — Codex parser has NO adjacent-duplicate-user dedup and NO environment_context filter

user_message turns are pushed whenever message.length>0; the only wrapper
handling is `stripPromptWrapper` on the response_item role=user FALLBACK path
(exec mode, no user_message events), which peels leading
`<x instructions>...</x>` blocks.

- Evidence: `rollout-parser.ts:174-183` (user_message push, no dedup), `72-82`
  (stripPromptWrapper handles tagged instruction blocks only), `255-264`
  (fallback path)
- Implication: Part 2.C (dedup adjacent identical user turns) and 2.D
  (environment_context wrapper) are net-new. `stripPromptWrapper`'s regex
  `/<([a-z][\w-]*(?:\s+instructions)?)>/` would NOT catch `<environment_context>`,
  and it only runs on the fallback path, not the event_msg user path — 2-D needs
  its own handling.

### F-C8 — Production claude parser emits ONLY user + assistant text turns

`sandbox/claude-transcript-parser.ts` (the PRODUCTION parser) has NO tool
handling: tool_use blocks not extracted, tool_result-only user records explicitly
SKIPPED, thinking blocks ignored. `claudeContentText` only concatenates
`type==='text'` blocks.

- Evidence: `sandbox/claude-transcript-parser.ts:40-53` (only type==='text'),
  `92-110` (user/assistant only); `claude-transcript-parser.test.mjs:73,88-89`
  (tool_result-only user record skipped, expected kinds
  ['user','assistant','assistant'])
- Implication: Part 2 claude core — this is where tool_use→ToolTurn,
  tool_result(by tool_use_id)→output, and thinking→reasoning(assistant
  isFinalAnswer:false) must be added. The golden test's expected-kinds assertion
  (line 88) must change once tool turns appear.

### F-C9 — There are TWO parseClaudeTranscript functions; target the sandbox/ render parser

`sandbox/claude-transcript-parser.ts` returns ParsedRollout (the render contract,
used by parse-transcript dispatch). `agent-runtime/claude-transcript.ts` returns
TranscriptRecord[] (raw records, used ONLY for exit-detection helper
`isTurnComplete`, now demoted/unwired per align-claude-runtime-resident-session).

- Evidence: `sandbox/claude-transcript-parser.ts:43,60` vs
  `agent-runtime/claude-transcript.ts:43`
  (`parseClaudeTranscript(jsonl): TranscriptRecord[]`); `claude-transcript.ts:64-88`
  (isTurnComplete DEMOTED, no longer wired into detectExit)
- Implication: the refactor targets the sandbox/ render parser. The
  agent-runtime/ one is a separate, now-inert exit-detection helper — leave it or
  fold its block-walking knowledge into the new parser, but they serve different
  contracts.

### F-C10 — SessionTurn has no reasoning kind, but the frontend already renders one

SessionTurn is a `discriminatedUnion('kind', [user, assistant, tool, system])`
in @cap/contracts. ToolTurn has name/args/output(nullable)/tokenCount?/diffstat?/at?;
AssistantTurn has text/isFinalAnswer/at — NO reasoning kind. All additions to
date are additive+optional+backward-compatible.

- Evidence:
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/packages/contracts/src/session-history.ts:39-122,130-145`
- Implication: for reasoning, the contract has no reasoning kind BUT the frontend
  already renders `assistant + !isFinalAnswer` as 「推理」. So codex reasoning /
  claude thinking can map to `assistant{isFinalAnswer:false}` with ZERO contract
  change. A dedicated reasoning kind requires a contracts rebuild + new variant +
  frontend handling — heavier; reuse is the lighter path. (Counter-weighs web
  F-W9.)

### F-C11 — The frontend already renders tool turns and reasoning; backend fix is sufficient

The transcript route already renders tool turns (WrenchIcon + name + args code +
collapsible output + diffstat/tokenCount) and reasoning (assistant !isFinalAnswer
→ italic 「推理」). It only reads the SessionTurn contract; no per-runtime branch.

- Evidence:
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/web/src/routes/_app/tasks/$taskId_.transcript.tsx:222-281` ;
  `/Users/tanghehui/ExploreProject/cloud-agent-platform/apps/web/src/lib/transcript-timeline.ts:42-53`
- Implication: confirms the non-goal "don't change frontend rendering" — claude
  tool turns light up the existing tool-card UI once the parser emits them. If a
  reasoning kind is added to the contract, this file's `assistant &&
  !isFinalAnswer` block and the timeline filter need a small extension.

### F-C12 — Golden-test mechanism: .test.mjs compiles the real .ts, runs inline assert

`<name>.test.mjs` sits beside the parser, compiles the REAL .ts with the
workspace tsc into a temp dir, imports the compiled JS, and runs inline
`assert()`s with `process.exit`. `rollout-parser.test.mjs` and
`claude-transcript-parser.test.mjs` already pin current behavior (synthetic
content, real codex-0.131 / claude-2.1.183 line shapes).

- Evidence: `rollout-parser.test.mjs:22-68,107-214`;
  `claude-transcript-parser.test.mjs:40-66,80-123`
- Implication: this is the established golden-test mechanism. New behavior (arg
  extraction, output cleaning, dedup, claude tool turns) extends these files;
  the type-only @cap/contracts imports elide at compile so they stay
  standalone-compilable. (Reconciles with web F-W12: the repo uses .test.mjs +
  node --test, not vitest snapshots — adopt the existing mechanism.)

### F-C13 — Golden tests are NOT in the CI gate

api `test` runs only `node --test dist/**/*.spec.js`; the .test.mjs files run
standalone via `node <file>`. CI (ci.yml) runs turbo build→typecheck→lint only.

- Evidence: `apps/api/package.json:16` (`node --test ... dist/**/*.spec.js`);
  scripts/*.test.mjs headers note "run with node scripts/..."; memory
  repo-ci-no-tsc-gate-and-mcp-browsers (CI = build+typecheck+lint, required check
  "typecheck + lint")
- Implication: golden tests guard against regression only when run
  manually/locally; the proposal's verification must run them explicitly
  (`node apps/api/src/sandbox/rollout-parser.test.mjs` etc.), and any contract
  change must still pass `turbo typecheck` (the real CI gate).

### F-C14 — Durable capture parses ONCE for FTS; stores RAW JSONL so future parsers re-run

`session-transcript.service.ts` parses once to build the FTS `content` column and
the isInterrupted flag, switching on turn.kind including 'tool' ([name,args,output])
and 'system'. It stores RAW JSONL (not parsed turns) so a future parser
improvement re-runs over history.

- Evidence: `session-transcript.service.ts:54-58` (raw archive is source of
  truth), `203-237` (parse→content/isInterrupted), `210-219` (kind switch over
  tool/system)
- Implication: improved parsers automatically benefit historical archives on
  re-read (no migration). The FTS content builder reads tool.args/output — if
  arg-extraction changes args text, re-captured content text changes (acceptable,
  additive).

### F-C15 — Archived specs already codify the read-and-capture invariants the refactor must not regress

`add-headless-execution-track` codifies the per-runtime transcriptArtifact read
(codex `sessions/rollout-*.jsonl`, claude
`projects/<slug>/<session-id>.jsonl`) and RAW re-parseable JSONL capture.
`wire-transcript-real-data` codifies per-turn `at`, system-turn merge OUTSIDE the
parser, apply_patch diffstat, session totals, and additive/backward-compatible
contract evolution.

- Evidence:
  `openspec/changes/archive/2026-06-20-add-headless-execution-track/specs/session-transcript-persistence/spec.md:8-33` ;
  `openspec/changes/archive/2026-06-21-wire-transcript-real-data/specs/session-history-replay/spec.md:33-145`
- Implication: these are the existing requirements the refactor must NOT regress
  (the verify gate enumerates them). New work (tool-arg extraction, output
  cleaning, dedup, env_context filter, claude tool turns) is ADDED behavior
  layered on top; system-turn merge must stay in the controller/service, not the
  parser.

### F-C16 — Adding opencode today requires touching 5 places; the abstraction collapses it to 4 additive edits

Introducing opencode as a 3rd runtime today requires touching: RuntimeId union +
transcriptFormatForRuntime (port), a new TranscriptFormat literal, a new runtime
class, the parse-transcript ternary, AND readRolloutFromContainer's single-file
assumption. The proposal's registry + TranscriptSource + readTranscriptSource
abstraction collapses this to: add enum + runtime + parser + register.

- Evidence: `agent-runtime.port.ts:30,49,65-69` (hardcoded unions/ternary-free
  accessor); `parse-transcript.ts:17-19` (ternary);
  `aio-sandbox.provider.ts:651-657` (single-newest-file read)
- Implication: quantifies the refactor's payoff and the exact edit points the new
  abstraction must remove hardcoding from — the format→parser map becomes a
  Record registry, and the read strategy becomes a runtime-declared source
  producer instead of a baked single-JSONL read.

---

## Archive route — OpenSpec precedent, patterns to reuse, scope to avoid

Review of archived changes for design invariants, artifact conventions, and
settled scope.

### F-A1 — add-headless-execution-track is the direct architectural precedent; preserve its invariants verbatim

It introduced the per-runtime transcript contract this change refactors:
`transcriptArtifact(ctx) → {dir, filenameGlob}` + `transcriptFormat:
'codex-rollout'|'claude-jsonl'` on the AgentRuntime port, the parse-transcript.ts
switch dispatcher, and runtime-aware `readRolloutFromContainer`. Its spec encodes
the design invariant: "The port MUST NOT own the parser implementation — keeping
it a dependency-light LEAF module that never imports the sandbox parsers or
@cap/contracts. The shared transcript read + durable-capture mechanism ... SHALL
resolve ... FROM the task's runtime and dispatch to the parser keyed by the
declared transcriptFormat — never hardcoding a single runtime's layout. Each
parser SHALL be defensive: unknown record types are skipped and missing fields
degrade to honest omissions."

- Evidence:
  `openspec/changes/archive/2026-06-20-add-headless-execution-track/specs/agent-runtime/spec.md:40-61`;
  design.md D2/D6
- Implication: REUSE — the new TranscriptParser-interface change is a natural
  evolution of this seam (port declares format tag; sandbox layer owns
  parsers+dispatch). Frame the new change as "tighten the existing switch into a
  TranscriptParser registry" rather than a new abstraction, and PRESERVE the
  leaf-port / defensive-parser invariants verbatim or the spec will conflict.

### F-A2 — Current code matches the proposal's "current state" exactly (no stale assumptions)

`parse-transcript.ts` is a 20-line `switch(format)` (ternary) dispatching to
parseClaudeTranscript/parseRollout with signature
`parseTranscript(jsonl: string, format)`; the port declares
`type TranscriptFormat = 'codex-rollout' | 'claude-jsonl'`, `type RuntimeId =
'codex' | 'claude-code'`, `readonly transcriptFormat` per runtime, and
`transcriptFormatForRuntime(runtime)`.

- Evidence: `apps/api/src/sandbox/parse-transcript.ts:13-20`;
  `apps/api/src/agent-runtime/agent-runtime.port.ts:30,49,65,312`
- Implication: confirms the proposal's "current state" is accurate — this is a
  real refactor of live code, not greenfield. The `(jsonl: string)` signature is
  literally there to replace with `TranscriptSource`.

### F-A3 — wire-transcript-real-data deliberately scoped the claude parser OUT; the gap is real and previously deferred

wire-transcript-real-data (archived 2026-06-21, PR #43) modified both parsers but
its verification report flags that `claude-transcript-parser.ts` does NOT carry
`at` on turns and does NOT compute totalTokens/durationMs, recording: "That
parser is a SECONDARY runtime parser owned by a DIFFERENT change
(add-headless-execution-track), not in this change's scope." It also lists 5
"Scope findings" — behaviors present with no requirement.

- Evidence:
  `openspec/changes/archive/2026-06-21-wire-transcript-real-data/verification-report.md:74-120`;
  tasks.md Track 7 (claude-parser-parity)
- Implication: AVOID re-opening settled scope. wire-transcript added codex
  `at`/diffstat/totals AND a partial claude parity track (Track 7 carried claude
  `at`+durationMs). The new change's "fix claude tool-dimension
  (tool_use/tool_result/thinking)" is the genuinely-NOT-DONE remainder — cite
  this report as proof the gap is real and previously deferred, not a regression.

### F-A4 — wire-transcript-real-data is the contract-evolution playbook to copy

Every new SessionTurn/meta field was added to
`packages/contracts/src/session-history.ts` as `.optional()` (additive), a new
`system` kind added as a union member, justified by an explicit additivity
requirement + scenario ("Old durable archive reads back without error" /
"existing SessionReplay renderer unaffected"). It tracks the full serialization
blast radius (contract → rollout-parser → both controllers → v1-transcript.controller
+ OpenAPI regen → mock.ts → real.ts auto-flows → route).

- Evidence:
  `openspec/changes/archive/2026-06-21-wire-transcript-real-data/specs/session-history-replay/spec.md:130-145`
  (additive requirement); research-brief.md:64-83 (serialization surface map)
- Implication: REUSE the additivity pattern verbatim for a possible `reasoning`
  kind — add as optional union member + explicit backward-compat requirement + a
  "durable archive reads back" scenario. REUSE the blast-radius checklist; the
  new change touches the same files. The proposal's claim "front-end
  auto-benefits when contract gains fields" is validated by real.ts being a bare
  `SessionHistorySchema.parse`.

### F-A5 — Verification-report and tasks.md artifact conventions to reuse

The verification-report is a three-way adjudication: re-trace each raw-unmet
requirement end-to-end against code, reclassify as MET/spec-defect/code-task, and
separately list "Scope findings". tasks.md uses track-annotated parallel
structure (`## N. Track: <kebab-name> (depends: <track>|none)`) with `[x]`
checkboxes carrying inline post-hoc notes.

- Evidence:
  `openspec/changes/archive/2026-06-21-wire-transcript-real-data/verification-report.md:1-7`;
  tasks.md:1-2,4,28
- Implication: REUSE this exact artifact structure — proposal.md
  (Why/What Changes/Capabilities/Impact), design.md
  (Context/Goals-Non-Goals/Decisions D1..Dn/Risks/Migration/Open Questions),
  spec deltas under specs/<cap>/spec.md with ADDED/MODIFIED/RENAMED headers +
  `#### Scenario` WHEN/THEN, track-partitioned tasks.md, and a post-apply
  verification-report. This research-brief.md is the untracked side-car for
  explore evidence (the codex-trace/claude-code-log reference logic).

### F-A6 — refactor-agent-runtime-policy-mechanism is the precedent for a pure behavior-preserving refactor

Archived 2026-06-19; it explicitly resolved `captureTranscript` ("Either both
runtimes own their transcript source ... or it leaves the port"), mandated
golden/characterization tests pinning deterministic observable outputs FIRST then
asserting byte-identical after each refactor step, and forbade agent-identity
branches (`runtime.id === 'codex'`) in shared mechanism.

- Evidence:
  `openspec/changes/archive/2026-06-19-refactor-agent-runtime-policy-mechanism/proposal.md:18-49`
- Implication: REUSE the golden-test gate for Part 1 ("golden test 钉住现有输出
  避免回归") — pin current parser outputs as characterization fixtures, assert
  identical post-refactor. AVOID re-introducing format/identity branching in the
  dispatcher — a `Record<TranscriptFormat, TranscriptParser>` registry is the
  compliant shape. This was a 0→5 SERIAL step sequence (not parallel tracks)
  because it was behavior-preserving — Part 1 (pure refactor) likely wants the
  same serial discipline.

### F-A7 — Test conventions are fixed and proven (.test.mjs)

Backend parsers are tested with `.test.mjs` (tsc-compiles the real .ts, runs
`node --test` + inline assert, synthetic-content/real-structure fixtures).
`rollout-parser.test.mjs` (13.5KB) and `claude-transcript-parser.test.mjs`
(6.7KB) already exist (last touched 2026-06-22). The repo vitest is node-env (no
DOM), so pure parsing/timeline logic is extracted to lib modules and
unit-tested; rendering is covered by the visual gate.

- Evidence: `apps/api/src/sandbox/rollout-parser.test.mjs`,
  `claude-transcript-parser.test.mjs` (present, dated 6月22);
  research-brief.md:84-104 (verification map)
- Implication: REUSE — golden tests for Part 1 and parser-fix tests for Part 2 go
  in these existing .test.mjs files following the established "assert populated
  AND assert honest-omission negative case" pattern (every wire-transcript task
  pairs a positive with a "source missing → omitted, never fabricated" case).
  Match this defensive-test posture for new exec-args/output-wrapper/tool_use
  extraction.

### F-A8 — Durable archive stores RAW JSONL → parser fixes re-run cleanly, no migration

persist-session-transcripts (archived 2026-06-16) established the
durable-archive-stores-RAW-JSONL invariant that headless-execution-track later
RENAMED to per-runtime: "The capture SHALL store the RAW transcript JSONL (NOT a
parsed render contract) so a future parser change can re-run over historical
data."

- Evidence:
  `openspec/changes/archive/2026-06-20-add-headless-execution-track/specs/session-transcript-persistence/spec.md:13-17,27-30`
  (RENAMED + scenario "Archive stores raw JSONL, not parsed turns")
- Implication: CRITICAL for the new change's risk section — because archives
  store RAW JSONL keyed by runtime format, a parser refactor/fix re-runs cleanly
  over historical data on re-read. Cite this to justify "no archive migration
  needed" the same way wire-transcript-real-data did (D6/Migration Plan:
  additive-optional, no re-parse).

---

## Implications for the proposal

The three routes converge on a tightly-scoped, low-risk change. Pulling the
cross-route signal together:

1. **Frame as "tighten the switch into a registry", not a new abstraction.**
   The leaf-port / format-tag / sandbox-owns-parsers seam already exists by
   design (F-A1, F-C2, F-A2). The change replaces the `parse-transcript.ts`
   ternary with a `Record<TranscriptFormat, TranscriptParser>` registry and
   widens `parse(jsonl: string)` → `parse(source: TranscriptSource)`, while
   keeping `parseTranscript`'s external signature stable for its four call sites
   (F-C3). PRESERVE the archived leaf-port + defensive-parser invariants verbatim
   (F-A1) or the spec conflicts.

2. **TranscriptSource must be a discriminated union, and the read layer must be
   abstracted too — not just the parser.** opencode is genuinely not single-file
   JSONL (F-W8); the current read bakes in a single-newest-file assumption
   (F-C4). So the abstraction is two-part: a runtime-declared `readTranscriptSource`
   producing `{format, jsonl}` for codex/claude and `{format:'opencode-parts',
   messages}` for opencode, feeding a per-format parser. This is what collapses
   "add opencode" from 5 edit points to 4 additive edits (F-C16).

3. **Adopt the deserialize-then-classify two-stage shape** (F-W10): per-format
   deserialize (TranscriptSource → raw entries) feeding a shared classify stage
   (raw entries → SessionTurn[]). The cross-runtime call-pairing primitive
   (buffer call by id, attach output later) becomes shared helper logic where
   each format only declares its id field name — codex call_id, claude
   tool_use_id, opencode callID (F-W14). cap already does codex call_id buffering
   (F-C5/F-W14); claude needs the same by tool_use_id (F-W5).

4. **Part 2.A (codex command extraction) must dispatch on tool name BEFORE
   extracting.** apply_patch → keep raw `input` (F-W3, already aligned);
   exec_command → `arguments.cmd` (string); shell/local_shell/container.exec →
   `arguments.command` (array, join); drop workdir/timeout_ms from the
   human-readable text (F-W2). This CHANGES the golden assertion at
   `rollout-parser.test.mjs:137` (F-C5) — update intentionally.

5. **Part 2.B (codex output cleaning) is net-new with no fixture.** Strip the
   documented wrapper grammar (Exit code / Wall time / Total output lines /
   `Output:\n` / `(N lines omitted)`), but conservatively — passthrough on
   format mismatch given cross-version drift (F-W4). Add a new golden fixture
   with a real wrapped output (F-C6).

6. **Part 2.C/2.D (codex dedup + environment_context) are net-new.** Dedup
   adjacent identical user turns; filter/degrade the `<environment_context>` /
   `<system-reminder>` wrapper. `stripPromptWrapper` is the extension point but
   currently only runs on the fallback path and won't catch the tag — 2.D needs
   its own branch on the event_msg user path (F-W11, F-C7).

7. **Part 2 claude tool dimension is the genuinely-undone remainder.** The
   production sandbox parser drops tool_use/tool_result/thinking entirely
   (F-W5, F-C8); the gap was explicitly deferred, not regressed (F-A3). Add:
   tool_use → ToolTurn with a per-tool field map (Bash.command, Grep.pattern,
   Read/Edit/Write.file_path) and a string-vs-object input guard (F-W6);
   tool_result (paired by tool_use_id from the subsequent user entry) → output,
   with a graceful degradation path for externalized/missing result files in the
   frozen sandbox (`[output unavailable]`, never abort) (F-W7); thinking →
   reasoning. The frontend already renders tool cards and reasoning, so the
   backend fix is sufficient (F-C11). Target the sandbox/ render parser, not the
   inert agent-runtime/ exit-detection parser (F-C9).

8. **Reasoning: prefer reuse over a new contract kind (lighter path), but record
   the decision.** All three runtimes carry reasoning and SessionTurn has no
   reasoning kind (F-W9), which argues for adding one to future-proof opencode in
   one place. But the frontend already renders `assistant{isFinalAnswer:false}`
   as 「推理」 (F-C10/F-C11), so mapping codex reasoning / claude thinking to that
   channel is a ZERO-contract-change path. A dedicated reasoning kind needs a
   contracts rebuild + new variant + frontend extension. Make this an explicit
   design decision; if a reasoning kind is chosen, follow the additivity playbook
   (optional union member + backward-compat requirement + "durable archive reads
   back" scenario) verbatim (F-A4).

9. **Golden tests are the regression gate; use the repo's actual mechanism.** Use
   the existing `.test.mjs` + `node --test` convention (F-C12, F-A7) — NOT vitest
   snapshots (F-W12 is the generic pattern; the repo's concrete mechanism is
   .test.mjs). Part 1 pins current SessionTurn[] output for zero-diff during the
   pure refactor (F-A6 serial discipline); Part 2 updates the pinned assertions
   intentionally as extraction/cleaning/tool-turns change output, pairing each
   positive with an honest-omission negative case. Verification must RUN these
   explicitly since they are not in the CI gate (F-C13), while still passing
   `turbo typecheck` for any contract change.

10. **No migration needed; cite the RAW-JSONL invariant in the risk section.**
    Durable archives store RAW JSONL keyed by runtime format (F-A8, F-C14), so
    every parser fix re-runs cleanly over historical data on re-read — no
    migration, additive-only. The FTS content text may shift when arg-extraction
    changes args (acceptable, additive). System-turn merge stays OUTSIDE the
    parser in the controller/service (F-C15) and must not move.

11. **Keep type-enhancement (Zod schemas) out of scope.** The hand-rolled
    interface + `typeof`-guard style already satisfies the defensive requirement;
    Zod-per-format is mature but explicitly non-required and would add weight to
    the parse hot path (F-W1, F-W13). Note as an open question, not a deliverable.

12. **Artifacts and discipline.** Populate the existing stub change (F-C1) — do
    not create a new one. Use the established artifact set (proposal/design/spec
    deltas/track-partitioned tasks/post-apply verification-report) per F-A5.
    Part 1 (pure behavior-preserving refactor) runs as a serial step sequence
    with golden tests first (F-A6); Part 2 (parser fixes) layers added behavior
    on top. Avoid re-opening the settled wire-transcript-real-data scope (codex
    `at`/diffstat/totals, system-turn merge location) — those are
    must-not-regress, not re-do (F-A3, F-C15).
