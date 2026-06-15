# Research Brief — persist-session-transcripts

> Side-car grounding doc. NOT a tracked OpenSpec artifact. Captures the codebase
> findings the proposal/design build on. Sourced from a read-only exploration of
> the live tree (2026-06-16), not from the archived `session-sandbox-retention`
> proposal alone.

## The gap (why this change exists)

The just-shipped `session-sandbox-retention` change persists the codex
conversation record (`rollout-*.jsonl`) **inside the task's stopped container
only**. `RetentionCleaner` (`apps/api/src/guardrails/retention-cleaner.ts`)
reaps stopped `cap-aio-*` containers after a settings-driven window (default
30d, or sooner under a free-disk high-water-mark). Once a container is reaped,
`GET /tasks/:id/session-history` can no longer read its rollout and returns the
honest `expired` empty state — **the conversation content is gone forever**.

The operator's expectation is **permanent / long-term** queryability: a past
task's conversation (and the content it pulled up) must remain findable in
history indefinitely, independent of container lifetime.

## Existing seams we can reuse (no new infra)

1. **A durable per-task workspace dir already outlives the container.**
   `apps/api/src/terminal/snapshot.ts` documents `workspaces/<id>/session.log`
   as an append-only byte source on the orchestrator-side durable volume that
   "works even after the sandbox is torn down". So there is already a
   per-task storage tier that survives container reaping — today it only holds
   the terminal byte log, not a structured/raw conversation record. The
   transcript archive can live in the same `workspaces/<id>/` dir with the same
   durability guarantee.

2. **Two clean terminal chokepoints to hang a capture step on.**
   `apps/api/src/guardrails/guardrails.service.ts`:
   - `onTerminal(taskId)` (`:483`) — natural completion → stop-only teardown.
   - `forceFail(taskId, cause)` (`:589`) — all 5 abnormal causes → stop-only teardown.
   Both run while the container is still present (`AutoRemove:false`), so the
   rollout can be docker-cp'd out before/around teardown.

3. **The rollout reader already exists.**
   `apps/api/src/sandbox/aio-sandbox.provider.ts` `readRolloutFromContainer(taskId)`
   (`:362-391`) docker-cp's `rollout-*.jsonl` out of the (stopped or running)
   container via dockerode `getArchive`. The capture step reuses it verbatim.

4. **The parser already exists.**
   `apps/api/src/sandbox/rollout-parser.ts` `parseRollout(jsonl)` (`:100-220`)
   turns raw JSONL into the `SessionTurn[]` render contract. Storing the RAW
   JSONL keeps this re-runnable if the parser improves.

5. **The read endpoint + contract already exist.**
   `apps/api/src/tasks/session-history.controller.ts` (`GET /tasks/:id/session-history`)
   and `packages/contracts/src/session-history.ts` (`SessionHistory` discriminated
   5-state union). This change repoints the endpoint's READ path to a
   durable-first lookup; the response contract is largely unchanged.

6. **Prisma is the home for the index.**
   `apps/api/prisma/schema.prisma` already models `Task`, `AuditEvent`,
   `AccountSettings`. A new `SessionTranscript` model slots in cleanly, keyed by
   `taskId`. Postgres `tsvector`/FTS gives cross-history content search.

## Operator decisions already locked (from explore session)

- **Substrate = volume archive + DB index** (the most robust hybrid).
- **Archive format = RAW rollout JSONL** (re-parseable safety net), gzipped.
- **Container retention untouched** — 30d reaping stays; content lifetime is now
  decoupled and effectively permanent.
- **Read-through backfill** — an already-stopped container (pre-feature) gets its
  transcript archived on first view, so existing retained sessions are covered.
- **Capture is best-effort** — a capture failure logs and never blocks teardown.

## Known caveat to carry into design

"Permanent" == the durability of the `workspaces/` volume. If that volume is not
backed up, a host loss still loses transcripts. True permanence needs the volume
in a backup policy (or a secondary push to object storage). This is an
operational note for design.md, not necessarily in-scope code.

## Anti-scope (explicitly NOT this change)

- Not changing `RetentionCleaner` container reaping behavior.
- Not building resume-run.
- Not building the deferred `session.log` cold-replay terminal tab.
- Not adding a separate transcript-retention account setting (transcripts are
  permanent; no reaping knob).
