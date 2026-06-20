## ADDED Requirements

### Requirement: Container transcript read resolves the per-runtime artifact path
The in-place container transcript read (`readRolloutFromContainer`) SHALL resolve the directory and
filename glob to pull FROM the task's runtime via the declared `transcriptArtifact(ctx)`, rather than
hardcoding `~/.codex/sessions` + `rollout-*.jsonl`. It reads a retained/stopped `cap-aio-<taskId>`
container's frozen layer in place (without restarting it), and SHALL stream ONLY that transcript path
out of the container (never `auth.json` or any credential file), return the newest matching file's raw
text, and return `null` on a miss (no artifact present, container reaped/expired, or read error) so
callers fall back honestly. This read feeds every transcript surface (MCP `get_transcript`, `/v1`
transcript, session-history, durable capture); consequently a finished `claude-code` task SHALL no
longer report `no-rollout`.

#### Scenario: Codex task reads its rollout path
- **WHEN** the transcript of a finished `codex` task is read from its retained container
- **THEN** the read pulls `~/.codex/sessions/**/rollout-*.jsonl` (the runtime-declared artifact) and returns the newest rollout's raw JSONL

#### Scenario: Claude task reads its projects JSONL (no more no-rollout)
- **WHEN** the transcript of a finished `claude-code` task is read from its retained container
- **THEN** the read pulls `~/.claude/projects/<slug>/<session-id>.jsonl` (the runtime-declared artifact) and returns its raw JSONL — not an empty `no-rollout`

#### Scenario: Only the transcript is pulled, never credentials
- **WHEN** the container transcript read runs for any runtime
- **THEN** it streams only the declared transcript directory out of the container and never extracts `auth.json` or other credential files

#### Scenario: A missing artifact returns null
- **WHEN** the runtime's transcript path is absent (agent never produced one, or the container was reaped)
- **THEN** the read returns `null` and the caller maps it to an honest `empty`/`expired` state
