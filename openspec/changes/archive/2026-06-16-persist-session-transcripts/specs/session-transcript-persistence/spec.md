## ADDED Requirements

### Requirement: Terminal tasks capture the codex rollout to a durable archive
At a task's terminal transition, the system SHALL capture the codex
`rollout-*.jsonl` out of the task's still-present `cap-aio-<taskId>` container
(reusing the existing container rollout read) and persist it as a RAW,
gzip-compressed archive on the durable per-task workspace volume, co-located with
`session.log` (e.g. `workspaces/<taskId>/transcript.jsonl.gz`), so the
conversation record outlives the container. The capture SHALL store the RAW
rollout JSONL (NOT a parsed render contract) so a future parser change can re-run
over historical data. The capture SHALL be best-effort: any capture or write
failure SHALL be logged and SHALL NOT block, delay, or fail the terminal
teardown or slot-free path.

#### Scenario: Rollout is archived to the durable volume at terminal
- **WHEN** a task reaches a terminal state and its `cap-aio-<taskId>` container still holds a `rollout-*.jsonl`
- **THEN** the system reads that rollout out of the container and writes it as a gzip-compressed RAW JSONL archive on the durable workspace volume alongside `session.log`

#### Scenario: Archive stores raw JSONL, not parsed turns
- **WHEN** the rollout is archived
- **THEN** the stored bytes are the raw codex rollout JSONL lines, re-parseable by the rollout parser, not a pre-parsed `SessionTurn[]` render contract

#### Scenario: Capture failure never blocks teardown
- **WHEN** the rollout capture or archive write fails (e.g. no rollout present, read error, disk error)
- **THEN** the failure is logged and the terminal teardown and slot-free path proceed unaffected, leaving no archive for that task until a later read-through backfill

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
