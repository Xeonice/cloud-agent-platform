# Verification Report — persist-session-transcripts

Adversarial spec verification with three-way routing. Each requirement was
re-traced end-to-end against the actual implementation, not rubber-stamped from
the skeptic's raw findings.

## Three-way tally (this pass)

- reopened code tasks: 0
- spec-defects (routed to design.md Open Questions): 1
- met / reclassified-met: 1 (the sole raw finding, re-traced)

The skeptic surfaced no by-name UNMET requirement; it surfaced one gap note and a
scope-creep list. The gap re-traces to a KNOWN spec-defect already recorded in
design.md Open Questions (the cross-history search surface is a deliberate
Non-Goal), so it is NOT re-opened as a code task.

## MET requirements (re-traced end-to-end)

### session-transcript-persistence

- **Terminal tasks capture the codex rollout to a durable archive** — MET.
  `SessionTranscriptService.capture` (`session-transcript.service.ts:92`) reuses
  `sandbox.readRolloutFromContainer`, gzips the RAW JSONL (`zlib.gzip`), and writes
  `workspaces/<taskId>/transcript.jsonl.gz` via the workspace-dir resolver. Every
  failure path is logged + swallowed and returns a status flag; `capture` never
  throws. Raw bytes (not parsed `SessionTurn[]`) are stored, satisfying the
  re-parseable-archive scenario.

- **Each captured transcript is indexed in a queryable store** — MET-AS-WRITTEN
  with a scoped gap (see below). The `SessionTranscript` model
  (`schema.prisma:357`) + migration `20260616000000_add_session_transcript` create
  a 1:1-per-task row (UNIQUE `task_id`) carrying meta (`model`, `cwd`,
  `started_at`, `turn_count`, `is_interrupted`), `archive_path`, `captured_at`, and
  a `content` column with a Postgres GIN `to_tsvector('english', content)` FTS
  index. `persist` (`:161`) upserts keyed by `taskId` (idempotent overwrite),
  satisfying "indexed on capture" and "re-capture upserts rather than duplicates."
  The raw archive on the volume remains the source of truth and the row is
  derivable from it.

- **Transcript lifetime is decoupled from container retention** — MET.
  `RetentionCleaner` is untouched (no edit in the change); the archive lives on the
  durable `workspaces/` volume and the index row is a separate Postgres table, so
  reaping a `cap-aio-<id>` container leaves both intact. No transcript reaper is
  introduced. Task 5.3 documents the volume-backup operational requirement.

### session-history-replay

- **Read-only session-history endpoint reads durable-first** — MET.
  `session-history.controller.ts:73` resolves durable-first:
  `transcripts.readDurable(id)` hit → parse + return WITHOUT touching the container
  (`:88`); miss → `sandbox.readRolloutFromContainer` fallback + read-through
  `backfill` (`:96-102`); credentials never exported (delegated to the provider's
  rollout read, unchanged from the parent change); stays off the live WS/PTY path
  (standalone REST read). Auth via the global `APP_GUARD`.

- **Session-history response is a discriminated honest 5-state contract** — MET.
  `agent_failed_to_start` → `empty/agent-failed-to-start` without reading any
  source (`:79`); available states parse the rollout and set `isInterrupted` from
  `status === 'cancelled'` (`:129`); `expired` is returned ONLY when BOTH durable
  archive AND container yield nothing AND the sandbox no longer exists (`:109-112`);
  every path returns through `SessionHistorySchema.parse`, so empty/expired are
  states, never errors.

### guardrails

- **Terminal teardown captures the task rollout to durable storage** — MET.
  `captureTranscript` (`guardrails.service.ts:520`) is invoked at BOTH chokepoints
  — `onTerminal:557` and `forceFail:684` — BEFORE the stop-only `teardownSandbox`,
  while the container is still present. It is awaited-and-swallowed (try/catch logs
  the error), a no-op when no provider is wired, and never alters the stop-only
  teardown or slot-free path.

## Gap / scope findings

### Gap: no query surface exercises the FTS index (KNOWN spec-defect, not re-opened)

The requirement "Each captured transcript is indexed in a queryable store" says the
index SHALL *support* querying across history — satisfied: the GIN
`to_tsvector('english', content)` index is created and `content` is populated on
every capture/backfill. But its scenario "Transcripts are searchable across history
by content" describes an OBSERVABLE behavior ("WHEN a query searches the transcript
index for a content term, THEN the index returns the matching tasks' transcript
records via a full-text content match") that has NO implementation: the only DB
access to `sessionTranscript` is `findUnique` by `taskId` (durable read) and
`upsert` (`session-transcript.service.ts:133,202`). Nothing runs a
`@@ plainto_tsquery('english', :q)` query against the GIN index, and no service
method or endpoint exposes a content search.

Adjudication: this is NOT re-opened as a code task. The search SURFACE is an
explicit Non-Goal (design.md:36 — "Building the cross-history content-search UI ...
the surface is a follow-up") and the index-vs-surface decision is already recorded
in design.md Open Questions (line 124) from a prior pass. The requirement is
internally contradictory ("support querying" = index exists, satisfied; vs the
scenario's runnable-query observable, deliberately deferred), so it is routed as a
SPEC-DEFECT (a clarifying note was appended to the existing Open Question), not a
new implementation task in this change.

### Scope: working-tree behaviors mapped to NO requirement in the 3 specs

These are out-of-scope changes present in the working tree (UI polish + two
internal implementation choices). None map to a `persist-session-transcripts`
requirement; recorded here so the scope is explicit, not silently absorbed.

- Terminal height changed from `min-h-[min(820px,...)]` to `h-[calc(100dvh-210px)]`
  with a `min-h-[420px]` floor — `apps/web/src/components/session/session-terminal.tsx:563`.
- xterm `.xterm-viewport` scrollbar hidden via CSS (`scrollbar-width:none` +
  `::-webkit-scrollbar`) — `apps/web/src/styles/app.css:358`.
- CommandPreview `<code>` switched from `whitespace-pre` to `whitespace-pre-wrap` +
  `[overflow-wrap:anywhere]` — `apps/web/src/components/dashboard/new-task-dialog.tsx:179`.
- CommandPreview `<pre>` layout changed from grid to flex+`min-w-0`+flex-col —
  `apps/web/src/components/dashboard/new-task-dialog.tsx:176`.
- Preview aside column gains `min-w-0` to prevent overflow blowout —
  `apps/web/src/components/dashboard/new-task-dialog.tsx:560`.
- Duplicate CommandPreview + aside `min-w-0` fix in the `/tasks/new.tsx` page
  variant — `apps/web/src/routes/_app/tasks/new.tsx:115`.
- `isInterrupted` in the `SessionTranscript` DB index derived from the ABSENCE of a
  final-answer assistant turn (not from `task.status`); the derivation rule is not
  specified in any spec — `apps/api/src/tasks/session-transcript.service.ts:195`.
  (Internal choice; harmless — the wire-level `isInterrupted` the read endpoint
  returns is independently derived from `status === 'cancelled'`.)
- `resolveWorkspaceDir` honors a legacy `WORKSPACES_ROOT` env var as a fallback in
  addition to the spec-implied `WORKSPACES_DIR`; no legacy-fallback requirement in
  the spec — `apps/api/src/tasks/session-transcript.service.ts:31`.
  (Internal compatibility choice; the spec only says "co-located with session.log".)
