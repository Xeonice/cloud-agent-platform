<!-- Track-annotated tasks. Each numbered group is a parallel Track.
     Tasks within a track run serially; independent tracks run in parallel at apply time. -->

## 1. Track: persistence-schema (depends: none)

- [x] 1.1 Add a `SessionTranscript` model to `apps/api/prisma/schema.prisma`, keyed by `taskId` (unique, 1:1 with `Task`), with columns: meta (`model`, `cwd`, `startedAt`, `turnCount`, `isInterrupted`), `archivePath`, `capturedAt`, and a searchable content text column; relate it to `Task`.
- [x] 1.2 Generate the additive Prisma migration that creates the table and a Postgres GIN full-text index (`tsvector`) over the searchable content column; verify it is forward-only and drops cleanly on rollback.
- [x] 1.3 Run `prisma generate` and confirm the client types compile.

## 2. Track: persistence-service (depends: persistence-schema)

<!-- Touches ONLY the new service file + its sibling unit test. The Nest-module
     REGISTRATION/EXPORT of this provider was moved to the Integration track
     because `apps/api/src/tasks/tasks.module.ts` is a shared file: Track 4's
     read-path controller (same module) and Track 3's guardrails import both
     consume the provider, so its wiring must serialize after the parallel
     tracks land. This track does NOT edit any .module.ts. -->

- [x] 2.1 Create `apps/api/src/tasks/session-transcript.service.ts` (NestJS provider) injecting the sandbox provider, `PrismaService`, and the workspace-dir resolver that already roots `session.log`.
- [x] 2.2 Implement `capture(taskId)`: reuse `sandbox.readRolloutFromContainer(taskId)`, gzip the RAW JSONL (`zlib`), write `workspaces/<taskId>/transcript.jsonl.gz`; best-effort — log and swallow all errors, return a status flag, never throw.
- [x] 2.3 In `capture`, parse the rollout once via the existing `parseRollout` to derive meta + concatenated search text, then upsert the `SessionTranscript` row keyed by `taskId` (idempotent overwrite of the archive).
- [x] 2.4 Implement `readDurable(taskId)`: look up the index row, read + gunzip the archive, return the raw JSONL (or null on miss) for the controller to parse; keep the raw archive as source of truth.
- [x] 2.5 Implement `backfill(taskId, rawJsonl)`: persist archive + upsert index from a rollout already read elsewhere (used by the read-through fallback), reusing 2.2/2.3 internals.
- [x] 2.6 In `apps/api/src/tasks/session-transcript.service.test.mjs`, add unit tests covering capture success, capture failure (no rollout / write error → no throw, no row), upsert idempotency, and durable read hit/miss. (Module registration is the Integration track's I.1.)

## 3. Track: guardrails-capture (depends: persistence-service)

<!-- Touches ONLY `apps/api/src/guardrails/guardrails.service.ts` + its test
     (`guardrails-exit-roundtrip.test.mjs`). The CROSS-MODULE wiring that makes
     the transcript service injectable here — editing `guardrails.module.ts`
     (and the export side of `tasks.module.ts`) — is the Integration track's
     I.2, because `guardrails.module.ts`/`tasks.module.ts` are shared module
     files. This track writes the call sites in the service body, written
     against the injected provider that Integration wires. Do NOT edit any
     .module.ts in this track. -->

- [x] 3.1 Add the transcript-service constructor dependency to `apps/api/src/guardrails/guardrails.service.ts` (the field + capture call sites; the provider is wired into the module by Integration I.2).
- [x] 3.2 In `onTerminal` (`:483`), invoke `capture(taskId)` (best-effort, awaited-and-swallowed) BEFORE the stop-only `teardownSandbox`, leaving stop-only + slot-free semantics unchanged.
- [x] 3.3 In `forceFail` (`:589`), invoke the same best-effort capture before its stop-only `teardownSandbox`, for all abnormal causes.
- [x] 3.4 Add tests proving capture is invoked at both chokepoints and that a thrown capture error does NOT block the terminal transition, teardown, or slot release.

## 4. Track: read-path (depends: persistence-service)

<!-- Touches `apps/api/src/tasks/session-history.controller.ts` + its test
     (`session-history.controller.test.mjs`), and OPTIONALLY the contracts file
     `packages/contracts/src/session-history.ts` (4.3). None of these are shared
     with Tracks 2/3. The controller is REGISTERED in the shared
     `tasks.module.ts`, and injecting the transcript provider into it is the
     Integration track's I.1 — this track writes the controller body against the
     injected `transcripts` dependency. Do NOT edit `tasks.module.ts` here. -->

- [x] 4.1 Rewire `apps/api/src/tasks/session-history.controller.ts` to resolve DURABLE-FIRST: try `transcripts.readDurable(taskId)` → parse → return; on miss, fall back to `readRolloutFromContainer`; on a successful fallback call `transcripts.backfill(...)` before returning. (The `transcripts` provider is injected via Integration I.1.)
- [x] 4.2 Preserve the discriminated 5-state contract; ensure `expired`/empty is returned ONLY when BOTH the durable archive AND the container yield no rollout. Keep auth, no-credential-export, and off-live-pipeline guarantees intact.
- [x] 4.3 If the console needs provenance, add an OPTIONAL `source` field to `@cap/contracts` `SessionHistory`/`SessionHistoryResponse` and its Zod schema (otherwise leave the contract transparent — decide per design.md Open Question). DECISION: contract kept transparent — per design.md Open Question the lean is "keep it transparent; add the field only if the console needs to badge provenance," and there is no provenance-badge requirement (the console `sessionHistory` capability is still off). No contract change.
- [x] 4.4 Add controller/integration tests: durable hit (no container touch), container fallback + backfill (next read is a durable hit), and both-sources-gone → expired.

## I. Track: integration (depends: persistence-service, guardrails-capture, read-path)

<!-- Serial, after the parallel tracks. Owns the SHARED module files
     (`apps/api/src/tasks/tasks.module.ts`, `apps/api/src/guardrails/guardrails.module.ts`)
     so no two parallel tracks edit them concurrently. These wire the
     SessionTranscriptService provider that Tracks 2/3/4 wrote against. -->

- [x] I.1 In `apps/api/src/tasks/tasks.module.ts`, register `SessionTranscriptService` as a provider, inject it into `SessionHistoryController` (Track 4's read-path consumer), and add it to the module `exports` so guardrails can import it.
- [x] I.2 In `apps/api/src/guardrails/guardrails.module.ts`, supply `SessionTranscriptService` to the `GuardrailsService` factory (resolved from the already-imported `TasksModule` / via `ModuleRef`), so the Track-3 capture call sites get a live provider. Run the api build + the Track 2/3/4 test files to confirm the wiring resolves end-to-end.

## 5. Track: verify-and-flip (depends: integration)

- [ ] 5.1 Verify e2e against the live api with a retained sandbox: confirm a terminal task is archived durably, then reap its container and confirm `GET /tasks/:id/session-history` still returns the transcript from the archive.
- [x] 5.2 Flip `apps/web/src/lib/api/capabilities.ts` `sessionHistory` from `false` to `true` and confirm the console renders real durable-first transcripts.
- [x] 5.3 Document the operational requirement that the `workspaces/` durable volume MUST be in a backup policy for host-loss survival of transcripts (deploy/ops note).
