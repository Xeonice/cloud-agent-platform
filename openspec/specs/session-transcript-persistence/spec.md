# session-transcript-persistence Specification

## Purpose
TBD - created by archiving change persist-session-transcripts. Update Purpose after archive.
## Requirements
### Requirement: Each captured transcript is indexed in a queryable store
The system SHALL maintain a `SessionTranscript` index record, one per task
(keyed by `taskId`, upserted on re-capture or backfill), carrying the session
meta (model, cwd, started-at, turn count, interrupted flag), the durable archive
path, a captured-at timestamp, and a content column derived from the parsed
transcript text. To make content queryable ACROSS history (not only openable by
id), the system SHALL populate that content column on every capture/backfill AND
build a Postgres full-text index (a GIN `to_tsvector` index) over it, so a
full-text content query is index-served at the data layer. The raw archive on the
volume SHALL remain the source of truth; the index SHALL be derivable from it.
(Exposing an application-level search endpoint/UI over this index is a Non-Goal of
this change — see design.md; this requirement covers the queryable SUBSTRATE, not
a search surface.)

#### Scenario: A transcript is indexed on capture
- **WHEN** a rollout is archived for a task
- **THEN** a `SessionTranscript` record keyed by that `taskId` is upserted with the session meta, the archive path, a captured-at timestamp, and a full-text-searchable content column

#### Scenario: The content substrate is full-text queryable across history
- **WHEN** transcripts have been captured and a Postgres full-text predicate (`to_tsvector(content) @@ plainto_tsquery(:term)`) is run against the `SessionTranscript` table
- **THEN** the populated `content` column and its GIN `to_tsvector` index serve the query and return the matching tasks' rows via a full-text content match, independent of whether each task's container still exists
- **AND** this holds at the data layer without requiring an application-level search endpoint/UI (that surface is a Non-Goal of this change)

#### Scenario: Re-capture upserts rather than duplicates
- **WHEN** a task's transcript is captured again (proactive capture and a later backfill, or a re-run)
- **THEN** the index record for that `taskId` is upserted in place and the archive is overwritten idempotently, never producing a duplicate row

### Requirement: Transcript lifetime is decoupled from container retention
A persisted transcript (archive + index) SHALL survive the reaping of its task's
container by the retention cleaner, and SHALL NOT itself be reaped on the
container retention window. Container retention behavior SHALL be unchanged by
this capability.

#### Scenario: Transcript survives container reaping
- **WHEN** the retention cleaner reaps a task's stopped `cap-aio-<taskId>` container after the retention window
- **THEN** the task's archived transcript and its index record remain intact and readable

#### Scenario: No transcript reaper is introduced
- **WHEN** the retention cleaner runs its sweep
- **THEN** it reaps only stopped containers as before and does NOT delete any transcript archive or index record

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

### Requirement: Transcript capture moves out of the tasks context without moving its happens-before

The transcript capture service SHALL be reachable by the orchestrator without the orchestrator's
module importing the tasks module, so the composition edge that exists solely to reach this service
is removed. The orchestrator SHALL keep an AWAITED call to capture at both terminal chokepoints,
before the stop-only teardown. That awaited call is the mechanism carrying the ordering guarantee —
the archive write must happen while the sandbox still exists — and this change SHALL NOT replace it
with a published event, a fire-and-forget call, or a lifecycle hook, because the framework gives no
ordering guarantee across providers and the repository has already taken a production incident from
assuming otherwise.

What DOES disappear is the optional-reference guard beside the call: the port SHALL be injected
non-optionally, with a no-op implementation standing in wherever no capture provider is wired, so
the orchestrator no longer branches on the collaborator's presence. Capture SHALL remain best-effort
at the seam: a capture that throws or rejects SHALL be logged and swallowed so the terminal
transition, the teardown, and the slot release proceed unconditionally.

The move SHALL declare its new directory in the contexts manifest in the SAME commit, SHALL re-key
rather than shrink the path-keyed cross-context ratchet entries, and SHALL re-provide any token the
moved service injects that the tasks module provided without exporting.

#### Scenario: Capture completes before teardown begins

- **WHEN** a task reaches a terminal state and the recorded call sequence is inspected, with capture
  made artificially slow
- **THEN** capture has COMPLETED before the stop-only teardown is invoked, and the assertion is on
  completion ordering rather than on elapsed time, so it cannot pass by racing

#### Scenario: The ordering assertion discriminates

- **WHEN** the same assertion is run against an implementation whose capture call is not awaited
- **THEN** it fails — an assertion that passes against both implementations is not testing the
  guarantee and SHALL be rewritten

#### Scenario: A failing capture still lets the task settle

- **WHEN** the capture provider throws, rejects, and is absent, in three separate runs
- **THEN** in every case the terminal transition, the teardown, and the slot release still complete,
  and the orchestrator contains no branch on whether a capture provider exists

#### Scenario: The composition edge is gone and the module graph still boots

- **WHEN** the guardrails module's imports are read, and the application context is booted
- **THEN** it no longer imports the tasks module for transcript access, and boot completes with no
  unresolved-dependency error for any token the moved service injects

