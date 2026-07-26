import {
  Controller,
  Get,
  Header,
  Param,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { open } from 'node:fs/promises';
import * as path from 'node:path';
import { CAST_CONTENT_TYPE } from '@cap/contracts';
import { resolveWorkspaceDir } from './session-transcript.service';
import { SESSION_CAST_FILENAME } from '../terminal/snapshot';
import {
  readTerminalRecordingPolicy,
  type TerminalRawArtifactPolicy,
} from '../terminal/terminal-recording-policy';
import { TasksService } from './tasks.service';

export const SESSION_CAST_DISABLED_ERROR = Object.freeze({
  code: 'terminal_raw_recording_disabled',
  status: 'disabled',
});

export const SESSION_CAST_UNAVAILABLE_ERROR = Object.freeze({
  code: 'terminal_raw_recording_unavailable',
  status: 'unavailable',
});

export interface SessionCastFileHandle {
  stat(): Promise<{ size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenSessionCastFile = (
  castPath: string,
) => Promise<SessionCastFileHandle>;

/**
 * Read-only asciicast endpoint (session-terminal-replay, Track 3).
 *
 * `GET /tasks/:id/cast` returns a finished task's `session.cast` (asciicast v2)
 * for the web timing-player. Mirrors {@link SessionHistoryController}: a
 * standalone read-only REST surface behind the global `APP_GUARD`, it resolves
 * the task first (404 when unknown via `findById`), then reads the cast off the
 * durable volume (co-located with `session.log`).
 *
 * Raw recording is disabled by default. Disabled and oversized artifacts return
 * explicit 503/413 errors; an enabled-but-missing artifact remains the existing
 * empty-body signal. The reader opens one handle, stats it before allocation,
 * and reads at most the configured production budget — never whole-file
 * `readFile`, so a legacy multi-gigabyte cast cannot OOM the API process.
 */
@Controller()
export class SessionCastController {
  constructor(private readonly tasksService: TasksService) {}

  @Get('tasks/:id/cast')
  @Header('Content-Type', CAST_CONTENT_TYPE)
  async get(@Param('id') id: string): Promise<string> {
    // 404 (NotFoundException) when the task does not exist — same as GET /tasks/:id.
    await this.tasksService.findById(id);

    const castPath = path.join(resolveWorkspaceDir(id), SESSION_CAST_FILENAME);
    return readBoundedSessionCast(
      castPath,
      readTerminalRecordingPolicy().sessionCast,
    );
  }
}

export async function readBoundedSessionCast(
  castPath: string,
  policy: TerminalRawArtifactPolicy,
  openFile: OpenSessionCastFile = async (target) => open(target, 'r'),
): Promise<string> {
  if (!policy.enabled) {
    throw new ServiceUnavailableException(SESSION_CAST_DISABLED_ERROR);
  }

  let handle: SessionCastFileHandle;
  try {
    handle = await openFile(castPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return '';
    throw new ServiceUnavailableException(SESSION_CAST_UNAVAILABLE_ERROR);
  }

  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < 0 || size > policy.maxBytes) {
      throw new PayloadTooLargeException({
        code: 'terminal_raw_recording_too_large',
        status: 'too_large',
        maxBytes: policy.maxBytes,
      });
    }
    if (size === 0) return '';

    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        size - offset,
        offset,
      );
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const text = buffer.subarray(0, offset).toString('utf8');
    return text.trim().length > 0 ? text : '';
  } catch (error) {
    if (error instanceof PayloadTooLargeException) throw error;
    throw new ServiceUnavailableException(SESSION_CAST_UNAVAILABLE_ERROR);
  } finally {
    try {
      await handle.close();
    } catch {
      // The bounded read result/error remains primary; close is best-effort.
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
