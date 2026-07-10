import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
import {
  PublicV1IdParamsSchema,
  type SessionHistory,
} from '@cap/contracts';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { TasksService } from '../tasks/tasks.service';
import {
  TRANSCRIPT_STORE,
  type TranscriptStore,
  AUDIT_TIMELINE_READER,
  type AuditTimelineReader,
} from '../tasks/session-history.controller';
import { readTaskTranscript } from '../tasks/task-transcript-reader';
import { hasScope } from '../auth/operator-principal';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { zodParam } from '../repos/zod-validation.pipe';

/**
 * `/v1` transcript surface (public-v1-api, D1) — `GET /v1/tasks/:id/transcript`,
 * the structured session-history read exposed under the versioned prefix for
 * machine callers. It delegates to the SAME canonical reader as the console and
 * MCP: active tasks use the live sandbox rollout; terminal tasks use the durable
 * archive with retained-sandbox fallback. It never exposes live PTY/WebSocket
 * bytes or raw rollout JSONL.
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
    @Inject(AUDIT_TIMELINE_READER) private readonly audit: AuditTimelineReader,
  ) {}

  @Get(':id/transcript')
  async get(
    @Param('id', zodParam(PublicV1IdParamsSchema.shape.id)) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SessionHistory> {
    this.requireReadScope(req);
    return readTaskTranscript(
      {
        tasks: this.tasksService,
        sandbox: this.sandbox,
        transcripts: this.transcripts,
        audit: this.audit,
      },
      id,
    );
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
