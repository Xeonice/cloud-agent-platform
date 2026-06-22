## ADDED Requirements

### Requirement: Codex tool turns carry a human-readable command extracted per tool name
The codex rollout parser SHALL dispatch on the tool name BEFORE extracting the tool turn's `args`,
emitting a human-readable command rather than the raw arguments JSON string. The extraction SHALL be:
`apply_patch` keeps its raw `input` patch text verbatim; `exec_command` uses `arguments.cmd` (a
shell string); `shell`, `local_shell`, and `container.exec` use `arguments.command` (an argv array,
joined with single spaces). The extractor SHALL DROP `workdir` and `timeout_ms` from the
human-readable command. The extractor SHALL guard the input shape: when the expected field is
absent or of the wrong type, it SHALL fall back to the raw arguments string rather than throw or
emit an empty command. This REPLACES the prior behavior of storing the raw arguments JSON string as
`args` for `exec_command`/`shell`/`local_shell`/`container.exec` (the existing golden assertion for
that raw value SHALL be updated to the extracted command).

#### Scenario: exec_command extracts the cmd string
- **WHEN** the parser reads a codex `exec_command` call with `arguments` `{"cmd":"ls src"}`
- **THEN** the tool turn's `args` is `ls src`, not the JSON string `{"cmd":"ls src"}`

#### Scenario: shell-family extracts and joins the command array
- **WHEN** the parser reads a `shell` / `local_shell` / `container.exec` call with `arguments.command` `["bash","-lc","echo hi"]`
- **THEN** the tool turn's `args` is the array joined with single spaces (`bash -lc echo hi`)

#### Scenario: workdir and timeout_ms are dropped from the command
- **WHEN** the parser reads a `shell`-family call whose `arguments` also carry `workdir` and `timeout_ms`
- **THEN** the emitted `args` contains neither the `workdir` value nor the `timeout_ms` value — only the command

#### Scenario: apply_patch keeps its raw patch text
- **WHEN** the parser reads an `apply_patch` call whose patch body is in `input`
- **THEN** the tool turn's `args` is the raw `*** Begin Patch …` patch text, unchanged from the prior behavior

#### Scenario: Malformed tool arguments fall back to the raw string
- **WHEN** the parser reads a tool call whose expected field (`cmd`/`command`) is absent or of the wrong type
- **THEN** the emitted `args` is the raw arguments string and the parser does not throw or emit an empty command

### Requirement: Codex exec output is conservatively stripped of the documented wrapper grammar
The codex rollout parser SHALL strip the documented `exec` output wrapper from a tool turn's
`output` so the operator sees the command output, not the harness wrapper. The wrapper grammar SHALL
be recognized conservatively: a leading `Exit code:` / `Wall time:` / `Total output lines:` prefix,
the `Output:\n` cut point, and a `(N lines omitted)` middle marker. The parser SHALL keep the
content AFTER the `Output:\n` cut point as the displayed output. When the output does NOT match the
wrapper grammar (cross-version drift, or a non-wrapped output), the parser SHALL pass the output
through UNCHANGED rather than mangle it. Stripping SHALL never produce an empty output when the
wrapper carried body content.

#### Scenario: A wrapped exec output is reduced to its body
- **WHEN** the parser reads a tool output of the form `Exit code: 0\nWall time: 1.23 seconds\nTotal output lines: 2\nOutput:\napp.tsx\nlogin.tsx`
- **THEN** the tool turn's `output` is `app.tsx\nlogin.tsx` (the content after `Output:\n`), with the Exit code / Wall time / Total output lines prefix removed

#### Scenario: A non-wrapped output passes through unchanged
- **WHEN** the parser reads a tool output that does not contain the `Output:\n` cut point or the wrapper prefix
- **THEN** the tool turn's `output` is byte-identical to the input (conservative passthrough on format mismatch)

#### Scenario: Stripping never empties a body-carrying output
- **WHEN** the wrapper carries body content after `Output:\n`
- **THEN** the stripped `output` is non-empty and equals that body content

### Requirement: Codex adjacent duplicate user turns are deduplicated
The codex rollout parser SHALL deduplicate ADJACENT identical user turns, because codex writes the
same prompt into both the `event_msg` stream and the `response_item` stream. When two consecutive
user turns carry identical text, the parser SHALL emit ONE user turn, not two. Non-adjacent user
turns with identical text (a genuine repeated prompt later in the session) SHALL NOT be collapsed —
only the immediately-adjacent duplicate is removed.

#### Scenario: Two adjacent identical user turns collapse to one
- **WHEN** the parser would emit two consecutive user turns with identical text
- **THEN** it emits a single user turn for that text

#### Scenario: Non-adjacent identical user turns are preserved
- **WHEN** two user turns carry identical text but are separated by at least one other turn
- **THEN** both user turns are emitted (only the adjacent duplicate is removed)

### Requirement: Codex environment_context user wrappers are filtered from operator text
The codex rollout parser SHALL filter the injected `<environment_context>` / `<system-reminder>`
wrapper so it is NOT rendered as operator prompt text. A user payload that is ENTIRELY an
`<environment_context>` (or `<system-reminder>`) block SHALL NOT produce a user turn. A user payload
that wraps the operator's own text in such a block SHALL be DEGRADED so only the operator's text
remains in the user turn. This filtering SHALL apply on the `event_msg` user path (in addition to
the existing `stripPromptWrapper` fallback path), since `stripPromptWrapper`'s tag regex does not
match `<environment_context>`.

#### Scenario: A pure environment_context user message produces no user turn
- **WHEN** the parser reads a user payload whose entire content is an `<environment_context><cwd>…</environment_context>` block
- **THEN** no user turn is emitted for that payload

#### Scenario: An operator message wrapped in environment_context keeps only the operator text
- **WHEN** the parser reads a user payload that wraps the operator's own prompt inside an `<environment_context>` / `<system-reminder>` block
- **THEN** the emitted user turn's text is only the operator's prompt, with the wrapper removed

#### Scenario: Filtering runs on the event_msg user path
- **WHEN** an `<environment_context>` block arrives via the `event_msg` user stream (not the response_item fallback)
- **THEN** it is filtered there, not left to the `stripPromptWrapper` fallback which does not match the tag

### Requirement: The Claude parser emits tool_use turns with a per-tool command field
The Claude sandbox render parser SHALL emit a `tool` turn for each `tool_use` content block,
extracting a human-readable command via a per-tool field map: `Bash` → `input.command`, `Grep` →
`input.pattern`, `Read` / `Edit` / `Write` → `input.file_path`. The extractor SHALL guard the input
shape with a string-vs-object check: when `input` is a JSON string (pre-v2.1.92 transcripts) it
SHALL be parsed to an object before field extraction, and when the named field is absent it SHALL
fall back to a stable serialization of the input rather than throw. The emitted tool turn SHALL
carry the tool `name` and the extracted command as `args`. This is net-new: the prior parser emitted
only user and assistant text turns and dropped `tool_use` blocks entirely.

#### Scenario: A Bash tool_use becomes a tool turn with the command
- **WHEN** the parser reads a `tool_use` block with `name: "Bash"` and `input.command: "npm test"`
- **THEN** it emits a `tool` turn with `name` `Bash` and `args` `npm test`

#### Scenario: Read/Edit/Write extract the file_path
- **WHEN** the parser reads a `tool_use` block for `Read`, `Edit`, or `Write` with `input.file_path: "src/index.ts"`
- **THEN** the emitted tool turn's `args` is `src/index.ts`

#### Scenario: A JSON-string input is parsed before extraction
- **WHEN** the parser reads a `tool_use` block whose `input` is a JSON string (pre-v2.1.92 shape) rather than an object
- **THEN** it parses the string to an object before pulling the per-tool field, and does not throw

#### Scenario: An unmapped tool falls back to a stable serialization
- **WHEN** the parser reads a `tool_use` block whose tool name has no field-map entry or whose named field is absent
- **THEN** it emits a tool turn whose `args` is a stable serialization of `input` rather than throwing or emitting empty `args`

### Requirement: The Claude parser pairs tool_result to tool_use by tool_use_id with frozen-sandbox degradation
The Claude sandbox render parser SHALL pair each `tool_result` block to its originating `tool_use`
by matching `tool_use_id`, attaching the result as the tool turn's `output`. Because `tool_result`
blocks live in a SUBSEQUENT `type: user` entry, the parser SHALL buffer the `tool_use` by id and
attach the later result. A `tool_use` whose `tool_result` never arrives SHALL still yield a tool
turn with `output: null` (never dropped). When a result references an externalized/missing result
file that cannot be read out of the FROZEN sandbox container, the parser SHALL degrade the output to
a `[output unavailable]` marker rather than abort the parse. This is net-new: the prior parser
explicitly SKIPPED `tool_result`-only user records.

#### Scenario: A tool_result attaches to its tool_use by id
- **WHEN** the parser reads a `tool_use` with id `X` and a later `type: user` entry carrying a `tool_result` with `tool_use_id: X`
- **THEN** the tool turn for that `tool_use` carries the result content as its `output`

#### Scenario: An unmatched tool_use yields a null-output turn
- **WHEN** a `tool_use` with id `X` has no `tool_result` with `tool_use_id: X` anywhere in the transcript
- **THEN** the tool turn is emitted with `output: null` rather than being dropped

#### Scenario: An externalized/missing result degrades, never aborts
- **WHEN** a `tool_result` references content externalized to a disk file that is unreadable from the frozen container
- **THEN** the tool turn's `output` is the marker `[output unavailable]` and the parse continues to completion

#### Scenario: tool_result-only user entries no longer produce spurious user turns
- **WHEN** a `type: user` entry contains ONLY `tool_result` blocks (no operator text)
- **THEN** the parser consumes it for pairing and emits no user turn for it

### Requirement: Codex reasoning and Claude thinking map to the existing assistant commentary channel
The parsers SHALL map agent reasoning to the EXISTING `assistant` turn with `isFinalAnswer: false`
(the channel the frontend already renders as 「推理」), with ZERO change to `@cap/contracts` — no new
`reasoning` turn kind is introduced. The codex reasoning event and the Claude `thinking` content
block SHALL each produce an `assistant` turn whose `isFinalAnswer` is `false` and whose `text` is the
reasoning content. A final-answer assistant turn SHALL remain `isFinalAnswer: true` and SHALL NOT be
confused with reasoning.

#### Scenario: Claude thinking becomes an assistant commentary turn
- **WHEN** the Claude parser reads a `thinking` content block
- **THEN** it emits an `assistant` turn with `isFinalAnswer: false` carrying the thinking text, and adds no new turn kind to the contract

#### Scenario: Codex reasoning becomes an assistant commentary turn
- **WHEN** the codex parser reads a reasoning event
- **THEN** it emits an `assistant` turn with `isFinalAnswer: false` carrying the reasoning text

#### Scenario: A final answer stays distinct from reasoning
- **WHEN** the same transcript carries both a reasoning turn and a final-answer turn
- **THEN** the reasoning turn is `isFinalAnswer: false` and the final-answer turn is `isFinalAnswer: true`, and they render as 「推理」 vs 「最终回答」 with no contract change

### Requirement: The fixed parsers preserve prior wire-transcript behaviors and re-run over raw archives without migration
The Part 2 parser fixes SHALL NOT regress the prior wire-transcript-real-data behaviors: per-turn
`at` timestamps, `apply_patch` diffstat, session totals (`totalTokens` / `durationMs`), the
phase-keyed final-answer categorization, and the system-turn merge staying OUTSIDE the parser (in
the controller/service). Because durable archives store RAW JSONL keyed by runtime format, the
improved parsers SHALL re-run cleanly over historical archives on re-read with NO migration and NO
re-parse step; a shift in FTS `content` text caused by the new arg extraction is acceptable and
additive. The Claude parser's new tool/thinking turns SHALL carry `at` from their source line when
present (omitted, never fabricated, when absent), consistent with the existing per-turn-timestamp
requirement.

#### Scenario: A historical raw archive re-parses with the fixed parser, no migration
- **WHEN** a durable archive stored as RAW JSONL before this change is re-read and re-parsed by the fixed parser
- **THEN** it parses without error and produces the improved turns, with no migration or re-parse step performed on the archive

#### Scenario: The system-turn merge stays outside the parser
- **WHEN** the fixed rollout/claude parser runs on its source
- **THEN** it emits no `system` turns (those are still merged by the controller/service layer from audit rows)

#### Scenario: New Claude tool/thinking turns carry their source timestamp when present
- **WHEN** the Claude parser emits a tool or thinking turn from a line that has a `timestamp`
- **THEN** the turn's `at` equals that line's timestamp, and a line with no timestamp yields a turn with `at` omitted (never fabricated)

#### Scenario: Prior codex behaviors are unchanged by the fixes
- **WHEN** the fixed codex parser runs on a rollout that also exercises diffstat, session totals, and phase-keyed final-answer categorization
- **THEN** the `apply_patch` diffstat, `totalTokens`/`durationMs` totals, and the final-answer-by-phase categorization are unchanged from the wire-transcript-real-data behavior
