import { Controller, Get, Header, Param } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { CAST_CONTENT_TYPE } from '@cap/contracts';
import { resolveWorkspaceDir } from './session-transcript.service';
import { SESSION_CAST_FILENAME } from '../terminal/snapshot';
import { TasksService } from './tasks.service';

/**
 * Read-only asciicast endpoint (session-terminal-replay, Track 3).
 *
 * `GET /tasks/:id/cast` returns a finished task's `session.cast` (asciicast v2)
 * for the web timing-player. Mirrors {@link SessionHistoryController}: a
 * standalone read-only REST surface behind the global `APP_GUARD`, it resolves
 * the task first (404 when unknown via `findById`), then reads the cast off the
 * durable volume (co-located with `session.log`).
 *
 * Empty-signal contract: a task with no recording (no PTY output, or a
 * pre-feature task) returns an EMPTY body (200) — the player renders the honest
 * empty face. A missing/unreadable file degrades to empty (never 500) so the tab
 * never breaks. The raw cast text is served as `text/plain` (asciicast JSONL).
 */
@Controller()
export class SessionCastController {
  constructor(private readonly tasksService: TasksService) {}

  @Get('tasks/:id/cast')
  @Header('Content-Type', CAST_CONTENT_TYPE)
  async get(@Param('id') id: string): Promise<string> {
    // 404 (NotFoundException) when the task does not exist — same as GET /tasks/:id.
    await this.tasksService.findById(id);

    // Read the cast off the durable volume. `resolveWorkspaceDir(id)` roots the
    // path (no manual join of unsanitized input → no path traversal). A missing/
    // unreadable/empty file degrades to the honest "nothing to replay" empty body.
    const castPath = path.join(resolveWorkspaceDir(id), SESSION_CAST_FILENAME);
    try {
      const text = await readFile(castPath, 'utf8');
      return text.trim().length > 0 ? text : '';
    } catch {
      return '';
    }
  }
}
