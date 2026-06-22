## MODIFIED Requirements

### Requirement: Transcript artifact location and format are declarative per-runtime capabilities
The `AgentRuntime` port SHALL declare, per runtime, the on-container transcript artifact via
`transcriptArtifact(ctx) → { dir, filenameGlob }`, a `transcriptFormat: 'codex-rollout' | 'claude-jsonl'`
tag, AND a `readTranscriptSource` source-read strategy that declares HOW the runtime's transcript
is read into a `TranscriptSource` — not only WHERE the artifact lives and WHAT format it is. The
codex and claude runtimes SHALL declare the single-newest-JSONL read strategy (producing a
`{ format, jsonl: string }` source), and the declaration SHALL be expressible for a future
multi-record runtime that is NOT single-file JSONL (producing a non-single-JSONL source) without
changing the codex/claude declarations. The port MUST NOT own the parser implementation NOR the
read I/O — it stays a dependency-light LEAF module that never imports the sandbox parsers or
`@cap/contracts`; the shared sandbox-layer read + durable-capture mechanism (which already owns the
parsers) SHALL resolve the directory, filename glob, AND read strategy FROM the task's runtime and
dispatch to the registry parser keyed by the declared `transcriptFormat` — never hardcoding a single
runtime's layout or read assumption. Each parser SHALL be defensive: unknown record types are
skipped and missing fields degrade to honest omissions, mapping into the shared `SessionTurn[]`
render contract.

#### Scenario: Codex declares its rollout layout + format
- **WHEN** the mechanism resolves the artifact for a `codex` task
- **THEN** it receives `{ dir: ~/.codex/sessions, filenameGlob: rollout-*.jsonl }` + `transcriptFormat: 'codex-rollout'`, and dispatches to the codex parser

#### Scenario: Claude declares its projects-JSONL layout + format
- **WHEN** the mechanism resolves the artifact for a `claude-code` task
- **THEN** it receives `{ dir: ~/.claude/projects/<canonicalized-workspace-slug>, filenameGlob: <session-id>.jsonl }` + `transcriptFormat: 'claude-jsonl'`, and dispatches to the claude parser

#### Scenario: Parser skips unknown record types
- **WHEN** a runtime's JSONL contains record types the parser does not recognize (e.g. claude `queue-operation`/`attachment`/`last-prompt`)
- **THEN** those lines are skipped and the conversational `user`/`assistant` turns are still extracted into `SessionTurn[]`

#### Scenario: The runtime declares how its source is read
- **WHEN** the shared read mechanism resolves the transcript source for a `codex` or `claude-code` task
- **THEN** it obtains the runtime's declared `readTranscriptSource` strategy and produces a `{ format, jsonl: string }` `TranscriptSource` via the single-newest-JSONL read
- **AND** the resulting source is the input handed to the registry parser keyed by `transcriptFormat`

#### Scenario: A multi-record read strategy is declarable without touching codex/claude
- **WHEN** a future runtime that is NOT single-file JSONL declares a non-single-JSONL `readTranscriptSource` strategy
- **THEN** it produces a non-`{ format, jsonl }` `TranscriptSource` variant, and the codex and claude `readTranscriptSource` declarations are unchanged

#### Scenario: The port stays a leaf with no parser or read I/O
- **WHEN** the `AgentRuntime` port module is inspected after adding the read-source declaration
- **THEN** it imports neither the sandbox parsers nor `@cap/contracts`, and its `readTranscriptSource` declaration contains no container/exec/Docker I/O call (the read I/O is run by the shared mechanism)
