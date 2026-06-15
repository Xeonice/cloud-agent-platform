## Why

Today a completed task's codex conversation record (`rollout-*.jsonl`) lives ONLY inside its stopped container, so `RetentionCleaner` reaping that container (default 30 days, or sooner under disk pressure) destroys the conversation forever — `GET /tasks/:id/session-history` then returns the `expired` empty state and the past content is unrecoverable. The operator's requirement is **permanent / long-term** queryability: a past task's conversation and the content it pulled up must stay findable in history indefinitely, decoupled from container lifetime.

> Side-car: `research-brief.md` records the codebase seams this builds on and is explicitly NOT a tracked OpenSpec artifact.

## What Changes

- **Capture the rollout to a durable store at task terminal.** At the two terminal chokepoints — `guardrails` `onTerminal` (natural completion) and `forceFail` (all 5 abnormal causes) — add a best-effort step that docker-cp's the codex `rollout-*.jsonl` out of the still-present container (reusing the existing `readRolloutFromContainer`) BEFORE/around the stop-only teardown, and persists it. Capture failure logs and NEVER blocks teardown.
- **Archive the RAW rollout JSONL, gzipped, on the durable workspace volume.** Write `workspaces/<id>/transcript.jsonl.gz` next to the existing `session.log`, inheriting the same "survives container teardown" durability tier. Raw (not parsed) so a future parser improvement can re-run over old data.
- **Index each transcript in a new Postgres `SessionTranscript` table.** Keyed by `taskId`, carrying the meta (model/cwd/startedAt/turn-count/isInterrupted), the archive path, a `capturedAt`, and a searchable content column (Postgres `tsvector`/FTS) so transcripts are queryable ACROSS history by content, not just openable per-task.
- **Repoint the read path to durable-first.** `GET /tasks/:id/session-history` reads the durable archive (DB index + volume) FIRST and returns it (permanent hit); only when the archive is absent does it FALL BACK to reading the container (current behavior), and on a successful fallback it **read-through backfills** the archive so already-stopped pre-feature containers get persisted on first view. **BREAKING** for any consumer that assumed the endpoint always reads from a live container — it now prefers the durable copy.
- **`expired` now means truly gone.** The honest `expired` empty state is returned only when NEITHER the durable archive NOR the container has the rollout — which, going forward, only happens for sessions that were reaped before this feature existed.
- **Container retention is UNTOUCHED.** `RetentionCleaner` keeps reaping stopped containers on the same 30-day + disk-pressure policy; the transcript now outlives the container, so reaping no longer loses content.

## Capabilities

### New Capabilities
- `session-transcript-persistence`: At task terminal, the codex rollout is captured (best-effort, non-blocking) out of the container, archived as raw gzipped JSONL on the durable workspace volume, and indexed in a Postgres `SessionTranscript` table (meta + archive path + FTS-searchable content), giving each task's conversation a permanent home decoupled from the container's retention window.

### Modified Capabilities
- `session-history-replay`: The "session-history endpoint reads the frozen rollout from the stopped container" requirement changes to **durable-first**: read the archived transcript (DB index + volume) first, fall back to the container only when the archive is absent, and read-through backfill on a successful fallback; the `expired`/aged-out empty state now occurs ONLY when neither source has the rollout (a pre-feature reaped session), not whenever the container is reaped.
- `guardrails`: The terminal teardown chokepoints `onTerminal` and `forceFail` gain a best-effort transcript-capture step that runs while the container is still present and never blocks or fails the teardown / slot-free path.

## Impact

- **Backend hot files:**
  - `apps/api/src/guardrails/guardrails.service.ts` — `onTerminal` (`:483`) and `forceFail` (`:589`) gain a best-effort capture call before the stop-only `teardownSandbox`.
  - `apps/api/src/tasks/session-history.controller.ts` — read path becomes durable-first → container-fallback → read-through-backfill.
  - **New** `apps/api/src/tasks/session-transcript.service.ts` (or `sandbox/`) — capture (reuse `readRolloutFromContainer`), gzip-archive to `workspaces/<id>/`, index/upsert the `SessionTranscript` row, and the durable read/backfill used by the controller.
  - `apps/api/prisma/schema.prisma` — new `SessionTranscript` model + a migration (FTS index on the searchable content column).
- **Reuse, no change:** `apps/api/src/sandbox/aio-sandbox.provider.ts` `readRolloutFromContainer` (`:362-391`); `apps/api/src/sandbox/rollout-parser.ts` `parseRollout`; the workspace-dir path that already roots `session.log`.
- **Contracts:** `packages/contracts/src/session-history.ts` — the discriminated `SessionHistory` union is largely unchanged; may gain an optional `source`/`archived` discriminator field. A lightweight cross-history transcript-search/list contract MAY be added if the search surface is exposed to the console (otherwise FTS stays a server-internal/index concern this change just enables).
- **Dependencies:** none new — `zlib` (gzip) is in Node stdlib; dockerode `getArchive` and Prisma already in use.
- **Frontend:** no structural change. The `capabilities.ts` `sessionHistory` flag (currently `false` = mock) is verified e2e against the now durable-first endpoint and flipped to `true`. A cross-history content-search UI is OUT OF SCOPE for this change (the DB index enables it as a follow-up).
- **Operational:** transcripts accumulate permanently but gzipped raw JSONL is small; "permanent" equals the `workspaces/` volume's durability — the volume MUST be in a backup policy (or a future secondary push to object storage) for true host-loss survival (design.md note).
- **Specs:** 1 new (`session-transcript-persistence`) + 2 modified (`session-history-replay`, `guardrails`). Container retention (`session-sandbox-retention`) and account settings are deliberately NOT modified.
