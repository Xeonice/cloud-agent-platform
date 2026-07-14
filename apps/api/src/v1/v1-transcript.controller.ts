import {
  Get,
  Inject,
  Req,
} from '@nestjs/common';
import { type SessionHistory } from '@cap/contracts';
import {
  PublicV1Controller,
  PublicV1Input,
  PublicV1Operation,
  requirePublicV1Principal,
} from '../public-surface/public-v1-operation';
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
import type { AuthenticatedRequest } from '../auth/auth.guard';

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
@PublicV1Controller('v1/tasks')
export class V1TranscriptController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
    @Inject(AUDIT_TIMELINE_READER) private readonly audit: AuditTimelineReader,
  ) {}

  @Get(':id/transcript')
  @PublicV1Operation('tasks.transcript')
  async get(
    @PublicV1Input('params', 'id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<SessionHistory> {
    requirePublicV1Principal(req, this.get);
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
}
