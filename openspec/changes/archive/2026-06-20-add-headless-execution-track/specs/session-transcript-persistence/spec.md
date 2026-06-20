## RENAMED Requirements

- FROM: `### Requirement: Terminal tasks capture the codex rollout to a durable archive`
- TO: `### Requirement: Terminal tasks capture the per-runtime transcript to a durable archive`

## MODIFIED Requirements

### Requirement: Terminal tasks capture the per-runtime transcript to a durable archive
At a task's terminal transition, the system SHALL capture the TASK RUNTIME's transcript artifact out
of the task's still-present `cap-aio-<taskId>` container — the directory and filename glob resolved
from the runtime's declared `transcriptArtifact(ctx)` (codex `~/.codex/sessions/rollout-*.jsonl`,
claude `~/.claude/projects/<canonicalized-workspace-slug>/<session-id>.jsonl`) — and persist it as a
RAW, gzip-compressed archive on the durable per-task workspace volume, co-located with `session.log`
(e.g. `workspaces/<taskId>/transcript.jsonl.gz`), so the conversation record outlives the container.
The capture SHALL store the RAW transcript JSONL (NOT a parsed render contract) so a future parser
change can re-run over historical data. The capture SHALL be best-effort: any capture or write failure
SHALL be logged and SHALL NOT block, delay, or fail the terminal teardown or slot-free path.

#### Scenario: A codex task's rollout is archived to the durable volume at terminal
- **WHEN** a `codex` task reaches a terminal state and its container still holds a `rollout-*.jsonl`
- **THEN** the system reads that rollout out of the container and writes it as a gzip-compressed RAW JSONL archive on the durable workspace volume alongside `session.log`

#### Scenario: A claude task's transcript is archived (no longer lost)
- **WHEN** a `claude-code` task reaches a terminal state and its container holds `~/.claude/projects/<slug>/<session-id>.jsonl`
- **THEN** the system reads THAT path (resolved via the runtime's declared artifact) and archives it durably — a finished claude task's transcript is no longer silently dropped

#### Scenario: Archive stores raw JSONL, not parsed turns
- **WHEN** the transcript is archived
- **THEN** the stored bytes are the raw runtime JSONL lines, re-parseable by that runtime's parser, not a pre-parsed `SessionTurn[]` render contract

#### Scenario: Capture failure never blocks teardown
- **WHEN** the transcript capture or archive write fails (e.g. no artifact present, read error, disk error)
- **THEN** the failure is logged and the terminal teardown and slot-free path proceed unaffected, leaving no archive for that task until a later read-through backfill
