import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { SessionHistory } from '@cap/contracts';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { TasksService } from './tasks.service';
import {
  AUDIT_TIMELINE_READER,
  TRANSCRIPT_STORE,
  readTaskTranscript,
  type AuditTimelineReader,
  type TranscriptStore,
} from './task-transcript-reader';

export {
  AUDIT_TIMELINE_READER,
  TRANSCRIPT_STORE,
  auditToSystemTurn,
  mergeSystemTurns,
  type AuditTimelineReader,
  type TranscriptStore,
} from './task-transcript-reader';

/**
 * Read-only session-history replay endpoint (persist-session-transcripts,
 * Track 4 read-path). `GET /tasks/:id/session-history` returns the discriminated
 * {@link SessionHistory}: the parsed codex transcript of a FINISHED task, or an
 * honest empty/expired state — never a fabricated transcript, never an error for
 * the not-running / no-rollout / aged-out cases.
 *
 * Resolution delegates to the canonical {@link readTaskTranscript} path shared
 * with `/v1` and MCP. Active tasks read the live sandbox rollout without
 * backfilling an incomplete snapshot. Terminal tasks are durable-first and use a
 * retained sandbox only as a read-through fallback.
 * `expired` is returned ONLY when BOTH the durable archive AND the container are
 * gone — going forward that is limited to pre-feature reaped sessions.
 *
 * This is a standalone REST surface. It parses rollout JSONL server-side, never
 * touches the live WebSocket / PTY / write-lease path, and never returns raw JSONL.
 *
 * Auth: behind the global `APP_GUARD` (auth.module) exactly like `/tasks/:id`
 * and `/metrics` — an unauthenticated / disabled request is rejected 401
 * before any archive or container is read, so no transcript is ever served
 * without a valid operator principal.
 */
@Controller()
export class SessionHistoryController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    @Inject(TRANSCRIPT_STORE) private readonly transcripts: TranscriptStore,
    @Inject(AUDIT_TIMELINE_READER) private readonly audit: AuditTimelineReader,
  ) {}

  @Get('tasks/:id/session-history')
  async get(@Param('id') id: string): Promise<SessionHistory> {
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
