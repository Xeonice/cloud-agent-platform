import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
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
import { TasksService } from '../tasks/tasks.service';
import {
  TRANSCRIPT_STORE,
  type TranscriptStore,
} from '../tasks/session-history.controller';
import { hasScope } from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/**
 * `/v1` transcript surface (public-v1-api, D1) — `GET /v1/tasks/:id/transcript`,
 * the durable session-history read exposed under the versioned prefix for machine
 * callers. It delegates to the SAME durable {@link TranscriptStore} +
 * {@link SandboxProvider} the console's `GET /tasks/:id/session-history` uses
 * (durable-first, container fallback, read-through backfill) — no new read path,
 * no live PTY/WebSocket exposure.
 *
 * Resolution (mirrors `SessionHistoryController`, design D4 of
 * persist-session-transcripts):
 *   1. `transcripts.readDurable(id)` hit → parse + return (never touches the
 *      container; survives container reaping).
 *   2. miss → `sandbox.readRolloutFromContainer(id)`; on success read-through
 *      `backfill(...)` so the next read is a durable hit, then return.
 *   3. neither → the honest `empty`/`expired` state (never a fabricated transcript).
 *
 * Auth: behind the global auth guard (401 unauthenticated); gated by `tasks:read`
 * on the guard-attached principal (a scopeless session/legacy principal is
 * allow-all; an api-key missing the scope is 403'd). Registered into the V1Module
 * in Integration (3.6).
 */
@Controller('v1/tasks')
export class V1TranscriptController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
  ) {}

  @Get(':id/transcript')
  async get(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SessionHistory> {
    this.requireReadScope(req);

    // 404 (NotFoundException) when the task does not exist — same as GET /v1/tasks/:id.
    const task = await this.tasksService.findById(id);

    // The agent never started → no transcript ever existed. Honest empty state,
    // surfaced WITHOUT reading any archive or container.
    if (task.status === 'agent_failed_to_start') {
      return SessionHistorySchema.parse({
        status: 'empty',
        reason: 'agent-failed-to-start',
      });
    }

    // The task's runtime decides where its transcript lands + how it parses
    // (add-headless-execution-track).
    const runtime = task.runtime as RuntimeId | null;
    const format = transcriptFormatForRuntime(runtime);

    // (1) DURABLE-FIRST: the persisted archive outlives the container.
    const durable = await this.transcripts.readDurable(id);
    if (durable !== null) {
      return this.toAvailable(id, durable, task.status, format);
    }

    // (2) FALLBACK: read the rollout out of the retained sandbox (null = none).
    const jsonl = await this.sandbox.readRolloutFromContainer(id, runtime);
    if (jsonl !== null) {
      // Read-through backfill so the NEXT read is a durable hit. Best-effort.
      await this.transcripts.backfill(id, jsonl);
      return this.toAvailable(id, jsonl, task.status, format);
    }

    // (3) Neither source yields a rollout: distinguish a truly aged-out/reaped
    // session (`expired`) from a present-but-transcriptless sandbox (`empty`).
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
      isInterrupted: status === 'cancelled',
    });
  }

  /**
   * Enforces `tasks:read` on the guard-attached principal (task 3.4). A scopeless
   * session/legacy principal is allow-all; a scoped principal missing the scope is
   * 403'd (distinct from the guard's 401 for an absent credential).
   */
  private requireReadScope(req: AuthenticatedRequest): void {
    const principal = req.operatorPrincipal;
    if (!principal) {
      throw new ForbiddenException('Missing operator principal');
    }
    if (!hasScope(principal, 'tasks:read')) {
      throw new ForbiddenException('Insufficient scope: tasks:read required');
    }
  }
}
