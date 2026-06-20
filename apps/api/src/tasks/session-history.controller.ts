import { Controller, Get, Inject, Param } from '@nestjs/common';
import { SessionHistorySchema, type SessionHistory } from '@cap/contracts';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { parseTranscript } from '../sandbox/parse-transcript';
import {
  transcriptFormatForRuntime,
  type RuntimeId,
  type TranscriptFormat,
} from '../agent-runtime/agent-runtime.port';
import { TasksService } from './tasks.service';

/**
 * Durable transcript store port (persist-session-transcripts, Track 4 read-path).
 *
 * The read endpoint depends on this NARROW shape — `readDurable` (durable-first
 * hit) and `backfill` (read-through on a container fallback) — rather than the
 * concrete `SessionTranscriptService`, so the controller compiles and unit-tests
 * standalone against a stub. The Integration track (I.1) binds
 * {@link TRANSCRIPT_STORE} to the real `SessionTranscriptService` in
 * `tasks.module.ts`; the service satisfies this interface structurally.
 */
export interface TranscriptStore {
  /**
   * The persisted RAW rollout JSONL for a task, or `null` on a miss (no index
   * row / unreadable archive). The endpoint parses it server-side; the raw
   * archive remains the source of truth.
   */
  readDurable(taskId: string): Promise<string | null>;
  /**
   * Read-through backfill: persist a rollout already read from the container
   * (archive + index upsert) so the next read is a durable hit. Best-effort —
   * implementations log and swallow; the read MUST proceed regardless.
   */
  backfill(taskId: string, rawJsonl: string): Promise<unknown>;
}

/** DI token for the durable {@link TranscriptStore}, bound by Integration I.1. */
export const TRANSCRIPT_STORE = Symbol('TRANSCRIPT_STORE');

/**
 * Read-only session-history replay endpoint (persist-session-transcripts,
 * Track 4 read-path). `GET /tasks/:id/session-history` returns the discriminated
 * {@link SessionHistory}: the parsed codex transcript of a FINISHED task, or an
 * honest empty/expired state — never a fabricated transcript, never an error for
 * the not-running / no-rollout / aged-out cases.
 *
 * Resolution is DURABLE-FIRST (design D4):
 *   1. `transcripts.readDurable(id)` hit → parse + return, NEVER touching the
 *      container (the permanent path; survives container reaping).
 *   2. miss → fall back to `sandbox.readRolloutFromContainer(id)` (the prior
 *      behavior); on success, read-through `transcripts.backfill(...)` so the
 *      next read is a durable hit, then return.
 *   3. neither source yields a rollout → the honest `empty`/`expired` state.
 * `expired` is returned ONLY when BOTH the durable archive AND the container are
 * gone — going forward that is limited to pre-feature reaped sessions.
 *
 * This is a STANDALONE REST surface. It parses the rollout server-side
 * ({@link parseRollout}) — it NEVER touches the live WebSocket / PTY / write-lease
 * path, and the raw rollout JSONL never leaves the api.
 *
 * Auth: behind the global `APP_GUARD` (auth.module) exactly like `/tasks/:id`
 * and `/metrics` — an unauthenticated / de-allowlisted request is rejected 401
 * before any archive or container is read, so no transcript is ever served
 * without a valid operator principal.
 */
@Controller()
export class SessionHistoryController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
  ) {}

  @Get('tasks/:id/session-history')
  async get(@Param('id') id: string): Promise<SessionHistory> {
    // 404 (NotFoundException) when the task does not exist — same as GET /tasks/:id.
    const task = await this.tasksService.findById(id);

    // The agent never started → no transcript ever existed. Honest empty state,
    // surfaced WITHOUT reading any archive or container (there is nothing to read).
    if (task.status === 'agent_failed_to_start') {
      return SessionHistorySchema.parse({
        status: 'empty',
        reason: 'agent-failed-to-start',
      });
    }

    // (1) DURABLE-FIRST: the persisted archive outlives the container, so prefer
    // it. A hit is returned WITHOUT reading (or depending on) the container.
    // The task's runtime decides where its transcript lands + how it parses
    // (add-headless-execution-track).
    const runtime = task.runtime as RuntimeId | null;
    const format = transcriptFormatForRuntime(runtime);

    const durable = await this.transcripts.readDurable(id);
    if (durable !== null) {
      return this.toAvailable(id, durable, task.status, format);
    }

    // (2) FALLBACK: no durable archive → read the rollout out of the retained
    // sandbox (null = none present). The provider never throws here and never
    // exports a credential file.
    const jsonl = await this.sandbox.readRolloutFromContainer(id, runtime);
    if (jsonl !== null) {
      // Read-through backfill so the NEXT read is a durable hit. Best-effort:
      // the persisted store logs + swallows its own failures; awaiting only
      // sequences the write before we respond and never blocks the read on it.
      await this.transcripts.backfill(id, jsonl);
      return this.toAvailable(id, jsonl, task.status, format);
    }

    // (3) Neither source yields a rollout. Distinguish a truly aged-out/reaped
    // session (`expired`) — now limited to pre-feature containers reaped before
    // a durable archive existed — from one whose sandbox is present but produced
    // no transcript (`empty` / no-rollout).
    const exists = await this.sandbox.sandboxExists(id);
    return SessionHistorySchema.parse(
      exists ? { status: 'empty', reason: 'no-rollout' } : { status: 'expired' },
    );
  }

  /** Parse a raw rollout (durable or container source) into the available state. */
  private toAvailable(
    id: string,
    jsonl: string,
    status: string,
    format: TranscriptFormat,
  ): SessionHistory {
    const { turns, meta } = parseTranscript(jsonl, format);
    return SessionHistorySchema.parse({
      status: 'available',
      turns,
      meta: { taskId: id, ...meta },
      // V.1 — carry the interrupted-terminal indication ON THE WIRE: an
      // operator-`cancelled` task ended mid-run (its terminal frame is a
      // half-painted interruption); a `completed`/`failed` task did not.
      isInterrupted: status === 'cancelled',
    });
  }
}
