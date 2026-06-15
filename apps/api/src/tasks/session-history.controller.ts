import { Controller, Get, Inject, Param } from '@nestjs/common';
import { SessionHistorySchema, type SessionHistory } from '@cap/contracts';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { parseRollout } from '../sandbox/rollout-parser';
import { TasksService } from './tasks.service';

/**
 * Read-only session-history replay endpoint (session-sandbox-retention,
 * Track 4). `GET /tasks/:id/session-history` returns the discriminated
 * {@link SessionHistory}: the parsed codex transcript of a FINISHED task, or an
 * honest empty/expired state — never a fabricated transcript, never an error for
 * the not-running / no-rollout / aged-out cases.
 *
 * This is a STANDALONE REST surface. It reads the rollout out of the settled,
 * retained sandbox via the {@link SandboxProvider} port and parses it server-side
 * ({@link parseRollout}) — it NEVER touches the live WebSocket / PTY / write-lease
 * path, and the raw rollout JSONL never leaves the api.
 *
 * Auth: behind the global `APP_GUARD` (auth.module) exactly like `/tasks/:id`
 * and `/metrics` — an unauthenticated / de-allowlisted request is rejected 401
 * before any container is read, so no transcript is ever served without a valid
 * operator principal.
 */
@Controller()
export class SessionHistoryController {
  constructor(
    private readonly tasksService: TasksService,
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
  ) {}

  @Get('tasks/:id/session-history')
  async get(@Param('id') id: string): Promise<SessionHistory> {
    // 404 (NotFoundException) when the task does not exist — same as GET /tasks/:id.
    const task = await this.tasksService.findById(id);

    // The agent never started → no transcript ever existed. Honest empty state,
    // surfaced WITHOUT reading any container (there is nothing to read).
    if (task.status === 'agent_failed_to_start') {
      return SessionHistorySchema.parse({
        status: 'empty',
        reason: 'agent-failed-to-start',
      });
    }

    // Read the rollout out of the retained sandbox (null = none present). The
    // provider never throws here and never exports a credential file.
    const jsonl = await this.sandbox.readRolloutFromContainer(id);
    if (jsonl !== null) {
      const { turns, meta } = parseRollout(jsonl);
      return SessionHistorySchema.parse({
        status: 'available',
        turns,
        meta: { taskId: id, ...meta },
        // V.1 — carry the interrupted-terminal indication ON THE WIRE: an
        // operator-`cancelled` task ended mid-run (its terminal frame is a
        // half-painted interruption); a `completed`/`failed` task did not.
        isInterrupted: task.status === 'cancelled',
      });
    }

    // No rollout: tell an aged-out/reaped session (`expired`) apart from one
    // whose sandbox exists but produced no transcript (`empty` / no-rollout).
    const exists = await this.sandbox.sandboxExists(id);
    return SessionHistorySchema.parse(
      exists ? { status: 'empty', reason: 'no-rollout' } : { status: 'expired' },
    );
  }
}
