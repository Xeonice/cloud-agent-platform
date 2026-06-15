## Context

`session-sandbox-retention` (archived 2026-06-15) gave terminal tasks a read-only
session-history replay by RETAINING the stopped container and reading
`rollout-*.jsonl` out of it on demand. But the rollout lives ONLY in that
container, and `RetentionCleaner` reaps stopped `cap-aio-*` containers on a
settings-driven window (default 30d; sooner under a free-disk high-water-mark).
Reaping = the conversation is gone forever; the endpoint then returns the honest
`expired` empty state.

The operator requires PERMANENT queryability. The constraint that makes this
cheap: the orchestrator already keeps a per-task durable dir `workspaces/<id>/`
holding `session.log`, documented in `terminal/snapshot.ts` as readable "even
after the sandbox is torn down". That dir is a storage tier that already
out-lives the container — we co-locate a rollout archive there and index it in
Postgres. See `research-brief.md` for the full seam inventory.

This is a cross-cutting change (guardrails terminal path + a new persistence
service + the read endpoint + a Prisma model/migration) with a data-model
addition and a BREAKING read-path semantics shift, so a design doc is warranted.

## Goals / Non-Goals

**Goals:**
- A task's codex conversation survives container reaping permanently.
- Capture is best-effort and NEVER blocks or fails the terminal teardown / slot-free path.
- The archive is the RAW rollout JSONL so a future parser fix can re-run over old data.
- Transcripts are queryable across history by content (Postgres FTS index), not only openable per-task.
- Already-stopped pre-feature containers are backfilled on first view (no data left behind).
- Zero new infrastructure dependencies.

**Non-Goals:**
- Changing `RetentionCleaner` container reaping (containers still reap at 30d).
- A separate transcript-retention account setting (transcripts are permanent; no knob).
- Resume-run, or the deferred `session.log` cold-replay terminal tab.
- Building the cross-history content-search UI (the index enables it; the surface is a follow-up).
- Guaranteeing host-loss survival on its own (depends on the volume backup policy — see Risks).

## Decisions

### D1 — Capture at the terminal chokepoints, best-effort, before stop-only teardown
Hook capture into `guardrails.service.ts` `onTerminal` (`:483`) and `forceFail`
(`:589`), reusing the existing `sandbox.readRolloutFromContainer(taskId)`
(`aio-sandbox.provider.ts:362-391`). The container is still present at both points
(`AutoRemove:false`), so a docker-cp read is reliable. The capture call is wrapped
so any failure is logged and swallowed — teardown and slot-free proceed unconditionally.
- *Alternative considered:* capture lazily only on first read (write-through-on-read).
  Rejected as the SOLE mechanism — a task whose container is reaped before anyone
  opens it would be lost. We do BOTH: proactive capture at terminal + read-through
  backfill (D4) for pre-feature containers.
- *Alternative considered:* a Stop-lifecycle hook inside the container. Rejected
  (same reasoning as the parent change): unreliable on SIGKILL, the exact abnormal
  case we target.

### D2 — Archive = RAW rollout JSONL, gzipped, on the durable workspace volume
Write `workspaces/<id>/transcript.jsonl.gz` next to `session.log`, via Node
stdlib `zlib.gzip` (no new dep). RAW (not parsed `SessionTurn[]`) so a parser
improvement re-runs over history; gzip because JSONL compresses heavily and the
store grows unbounded over time.
- *Alternative considered:* store parsed turns. Rejected — locks old data to the
  current parser version; a parser bug can't be retroactively fixed.
- *Alternative considered:* Postgres-only blob. Rejected — a multi-MB JSONL per
  task in a row is heavy at scale; the volume already gives a free, container-
  independent durability tier.

### D3 — Index = a new Postgres `SessionTranscript` table, one row per task
Keyed by `taskId` (unique; upsert on re-capture/backfill). Columns: meta
(`model`, `cwd`, `startedAt`, `turnCount`, `isInterrupted`), `archivePath`,
`capturedAt`, and a searchable text column with a Postgres FTS index
(`tsvector`, GIN) built from the concatenated turn text. The DB is the queryable
catalog; the volume holds the bytes. Parse once at capture to populate meta +
search text; keep the raw archive as the source of truth.
- *Why both:* "查到" = look up AND search across history. The volume alone can't
  answer "which past sessions mention X" without scanning every file; the DB index can.

### D4 — Read path: durable-first → container-fallback → read-through backfill
`session-history.controller.ts` resolves in order:
1. `SessionTranscript` row exists + archive readable → gunzip, `parseRollout`, return (permanent hit).
2. No archive → read the container via `readRolloutFromContainer` (current behavior); on success, **backfill** (archive + index) so the next read is a durable hit, then return.
3. Neither → the honest `expired`/empty state.
The 5-state discriminated contract is preserved; `expired` now means "truly gone"
(pre-feature reaped), not "container reaped".
- This is the BREAKING semantics shift called out in the proposal: the endpoint
  now PREFERS the durable copy over the live container.

### D5 — Container retention untouched; lifetimes decoupled
`RetentionCleaner` is not modified. The transcript's lifetime is now independent
of the container's. No transcript reaper is added (transcripts are permanent).

## Risks / Trade-offs

- **"Permanent" == the `workspaces/` volume's durability.** → The volume MUST be
  in a backup policy for host-loss survival; otherwise a host failure still loses
  transcripts. Documented as an operational requirement; a secondary push to
  object storage is a future option, out of scope here.
- **Unbounded storage growth.** → gzipped raw JSONL is small per task; acceptable
  for the foreseeable volume. If it ever matters, a transcript-archival/compaction
  policy is a clean follow-up (the DB index makes candidates queryable).
- **Capture races teardown / partial rollout.** → Capture is best-effort and
  ordered before the stop; if codex was still flushing, we archive what exists
  (matching the `failed`/`cancelled` "up to the failure point" semantics). A
  failed capture leaves NO archive, so the read path falls back to the container
  (D4) until backfilled — no worse than today.
- **Double-capture / re-capture.** → Index keyed by `taskId` with upsert; archive
  write is idempotent (overwrite). Backfill and proactive capture converge safely.
- **FTS index cost on write.** → One parse + one upsert at terminal (already a
  cold path); GIN index maintenance is negligible at this row volume.
- **Migration on a live DB.** → Additive table + index only; no change to existing
  tables. Safe forward migration, trivial rollback (drop table).

## Migration Plan

1. Ship the Prisma `SessionTranscript` model + additive migration (new table + GIN FTS index).
2. Deploy the persistence service + guardrails capture hook + durable-first read path.
3. From deploy on, every new terminal task is captured proactively; existing
   retained (pre-feature) containers backfill on first view.
4. Verify e2e against the live api with a retained sandbox, then flip the
   frontend `capabilities.ts` `sessionHistory` flag `false → true`.
- **Rollback:** revert the read path to container-only and drop the table; archives
  on the volume are inert and harmless if left.

## Open Questions

- Expose a cross-history content-search endpoint/UI now, or land the index first
  and add the surface as a follow-up? (Proposal scopes the UI OUT; index lands now.)
  - SPEC-DEFECT (verify, known/unresolved): the requirement "Each captured
    transcript is indexed in a queryable store" is internally contradictory on
    this point. Its prose says the index SHALL *support* querying across history —
    satisfied as built: the GIN `to_tsvector('english', content)` index is created
    by the migration and `content` is populated on every capture/backfill. But its
    scenario "Transcripts are searchable across history by content" asserts an
    OBSERVABLE behavior — "WHEN a query searches the transcript index for a content
    term, THEN the index returns the matching tasks' transcript records via a
    full-text content match" — which implies a runnable query path (service method
    or endpoint). No such query surface exists: `session-transcript.service.ts`
    only ever `findUnique`s by `taskId` and `upsert`s; nothing runs
    `@@ plainto_tsquery` against the GIN index. The scenario is therefore
    untestable end-to-end while the search surface is a deliberate Non-Goal. This
    requires a spec decision (split the "support" capability from the "searchable"
    observable, or move the scenario to the follow-up that lands the surface), NOT
    an implementation task in this change.
  - RESOLVED (post-verify): the spec was tightened rather than deferred. The
    requirement prose now scopes the deliverable to the queryable SUBSTRATE
    (content column populated + GIN `to_tsvector` index built, so a Postgres
    full-text predicate is index-served) and the scenario asserts exactly that
    data-layer behavior (`to_tsvector(content) @@ plainto_tsquery(:term)` served
    by the GIN index), explicitly marking the application-level search
    endpoint/UI a Non-Goal. The contradiction is gone; the search surface remains
    a follow-up.
- Does the contract need an explicit `source: "archive" | "container"` discriminator,
  or is the durable-first read transparent to the client? (Lean: keep it transparent;
  add the field only if the console needs to badge provenance.)
