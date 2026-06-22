## ADDED Requirements

### Requirement: A TranscriptParser port is keyed by TranscriptFormat in a registry
The sandbox layer SHALL define a `TranscriptParser` port — a single-method shape
`parse(source: TranscriptSource): ParsedRollout` — and a `Record<TranscriptFormat, TranscriptParser>`
registry that maps each `TranscriptFormat` literal to exactly one parser. `parseTranscript`
SHALL dispatch by LOOKING UP the parser in the registry keyed by the runtime's declared
`transcriptFormat`, and SHALL NOT contain a `switch`/ternary on the format literal. Adding a
new format to the registry SHALL require ONLY a new key→parser entry; no existing call site,
the dispatcher control flow, the frontend, or `@cap/contracts` SHALL need to change to register
it. The registry SHALL own the parser implementations; the `AgentRuntime` port SHALL remain a
leaf that declares only the format tag and never imports the sandbox parsers.

#### Scenario: Format dispatch is a registry lookup, not a branch
- **WHEN** the `parse-transcript` module source is inspected after the refactor
- **THEN** it dispatches by indexing a `Record<TranscriptFormat, TranscriptParser>` registry with
  the format key
- **AND** it contains no `switch (format)` and no `format === 'claude-jsonl' ? … : …` ternary
  selecting a parser

#### Scenario: A codex source resolves the codex parser through the registry
- **WHEN** `parseTranscript` is invoked with a source whose `format` is `codex-rollout`
- **THEN** the registry resolves the codex parser and the returned `ParsedRollout` equals what the
  pre-refactor ternary produced for the same input

#### Scenario: A claude source resolves the claude parser through the registry
- **WHEN** `parseTranscript` is invoked with a source whose `format` is `claude-jsonl`
- **THEN** the registry resolves the claude parser and the returned `ParsedRollout` equals what the
  pre-refactor ternary produced for the same input

#### Scenario: Registering a new format needs no dispatcher or call-site edit
- **WHEN** a new `TranscriptParser` is added to the registry under a new format key
- **THEN** no change is required to the four `parseTranscript` call sites (MCP `get_transcript`,
  `/v1` transcript, console session-history, durable capture/backfill), to the dispatcher control
  flow, to the frontend, or to `@cap/contracts`

### Requirement: TranscriptSource is a format-tagged discriminated union
The parser input SHALL be a `TranscriptSource` discriminated union tagged by `format`, replacing
the prior `parse(jsonl: string)` signature. The union SHALL carry, for each format, exactly the
fields that format's parser consumes: the single-JSONL formats SHALL be
`{ format: 'codex-rollout', jsonl: string }` and `{ format: 'claude-jsonl', jsonl: string }`,
and the union SHALL be EXTENSIBLE to a non-single-JSONL variant
(`{ format: 'opencode-parts', messages: … }`) without changing the existing variants or any of
the four call sites. A parser SHALL receive its own variant already narrowed by the discriminant,
so it never re-parses the file layout to learn which format it is handling.

#### Scenario: The single-JSONL variants carry the raw text
- **WHEN** the read layer produces a `TranscriptSource` for a codex or claude task
- **THEN** the source is `{ format: 'codex-rollout', jsonl }` or `{ format: 'claude-jsonl', jsonl }`
  carrying the raw JSONL string the parser consumes

#### Scenario: A parser receives its variant already discriminated
- **WHEN** a registry parser is invoked with a `TranscriptSource`
- **THEN** it reads the fields of its own `format` variant directly (the discriminant has already
  selected the variant) and does not inspect another format's fields

#### Scenario: A non-single-JSONL variant is expressible additively
- **WHEN** a multi-record format variant (e.g. `{ format: 'opencode-parts', messages }`) is added to
  the `TranscriptSource` union
- **THEN** the existing `codex-rollout` and `claude-jsonl` variants are unchanged, and the four
  `parseTranscript` call sites compile and run without edits

### Requirement: parseTranscript keeps a stable external signature for its four call sites
`parseTranscript` SHALL preserve a call-site-stable external surface so the four production callers
— MCP `get_transcript`, the `/v1` transcript controller, the console session-history controller,
and the durable capture/backfill service — continue to call it as
`parseTranscript(jsonl, transcriptFormatForRuntime(runtime))` (or `parseTranscript(jsonl, format)`)
with NO edit to the caller. The `TranscriptSource` construction from `(jsonl, format)` SHALL happen
INSIDE the dispatcher, so the widened internal `parse(source)` shape never leaks to the callers, and
the dispatcher, frontend, and contract stay untouched.

#### Scenario: Existing callers compile and run unchanged
- **WHEN** the four production call sites invoke `parseTranscript(jsonl, format)` after the refactor
- **THEN** each call type-checks and returns the same `ParsedRollout` it did before, with no edit to
  the calling code

#### Scenario: TranscriptSource is constructed inside the dispatcher
- **WHEN** a caller passes raw `(jsonl, format)` to `parseTranscript`
- **THEN** the dispatcher constructs the `{ format, jsonl }` `TranscriptSource` internally before the
  registry lookup, so callers never construct or see the union

### Requirement: The registry exposes the cross-runtime call-pairing primitive
The registry layer SHALL expose the call-pairing primitive — buffer a tool call by its id and attach
its output when the matching result arrives later — as SHARED helper logic, so each format's parser
declares ONLY its id field name (codex `call_id`, claude `tool_use_id`, a future opencode `callID`)
rather than re-implementing the buffer. A tool call whose matching output never arrives SHALL still
yield a tool turn with `output: null` (the call is never dropped), and an output whose call was
never seen SHALL be handled without throwing.

#### Scenario: A call and its later output pair by id through the shared primitive
- **WHEN** a parser reads a tool call and, after intervening lines, a matching output sharing the
  same id
- **THEN** the shared pairing primitive attaches the output to the buffered call and emits one tool
  turn carrying both

#### Scenario: An unmatched call still emits a turn with null output
- **WHEN** a tool call is buffered but no matching output arrives before the source ends
- **THEN** a tool turn is emitted with `output: null` rather than being dropped

#### Scenario: A parser declares only its id field name
- **WHEN** a format's parser is wired to the shared pairing primitive
- **THEN** it supplies its id field name (e.g. `call_id` / `tool_use_id`) and does not re-implement
  the buffer-by-id map
