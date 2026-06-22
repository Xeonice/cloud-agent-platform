## ADDED Requirements

### Requirement: The transcript read is generalized behind a runtime-declared source-read strategy
The `SandboxProvider` port's transcript read (`readRolloutFromContainer`) SHALL be generalized so
the read strategy is supplied by the task's runtime rather than baked as a single-newest-JSONL
assumption. The provider SHALL resolve WHERE to read from the runtime's `transcriptArtifact(ctx)`
and HOW to read from the runtime's declared `readTranscriptSource` strategy, and SHALL return a
`TranscriptSource` (for codex/claude: `{ format, jsonl: string }`) rather than a bare string. For
the codex and claude single-file path the produced source SHALL be byte-identical in `jsonl`
content to the pre-refactor read — the same lexicographically-newest matching JSONL file's text —
so the existing single-file behavior is preserved. A future multi-record runtime SHALL be able to
supply a non-single-JSONL source through the SAME generalized read seam without breaking the
codex/claude single-file path. The read SHALL remain non-throwing: a miss (no container, no
matching file, unreadable) SHALL resolve to an absent source rather than an error, exactly as
before.

#### Scenario: Codex/claude single-file read returns the same content as before
- **WHEN** the provider reads the transcript for a `codex` or `claude-code` task whose retained container holds the rollout
- **THEN** it resolves the directory + glob from `transcriptArtifact(ctx)`, applies the runtime's single-newest-JSONL `readTranscriptSource` strategy, and returns a `TranscriptSource` whose `jsonl` equals the lexicographically-newest matching file's text — byte-identical to the pre-refactor single-file read

#### Scenario: A multi-record runtime supplies a non-single-JSONL source through the same seam
- **WHEN** a runtime declares a multi-record `readTranscriptSource` strategy
- **THEN** the provider produces that runtime's non-single-JSONL `TranscriptSource` through the same generalized read path, and the codex/claude single-file path is unaffected

#### Scenario: A read miss resolves to an absent source, never an error
- **WHEN** the provider attempts the transcript read but the container is gone, no file matches the glob, or the file is unreadable
- **THEN** the read resolves to an absent source (the prior null-on-miss contract) rather than throwing
