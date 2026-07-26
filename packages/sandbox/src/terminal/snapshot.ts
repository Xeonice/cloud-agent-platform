/**
 * Durable terminal recording helpers.
 *
 * Live browser reconnect no longer consumes a headless-xterm snapshot or a
 * `session.log` tail. The filenames and failure-tail reader remain shared here
 * because audit/static/finished-session consumers still depend on them.
 */
import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/** Fixed owner-output log filename within each task workspace. */
export const SESSION_LOG_FILENAME = 'session.log';

/** Fixed asciicast v2 filename used by finished-session rendering. */
export const SESSION_CAST_FILENAME = 'session.cast';

/** Bytes read from the end of `session.log` when sampling a failure tail. */
const SESSION_LOG_TAIL_BYTES = 4096;
/** Max non-empty lines kept from the sampled tail. */
const SESSION_LOG_TAIL_LINES = 20;
/** Hard cap on the stored tail excerpt (chars), applied after line selection. */
const SESSION_LOG_TAIL_MAX_CHARS = 2000;

/** Strip terminal escapes/control bytes from an audit-oriented text excerpt. */
export function stripAnsi(input: string): string {
  /* eslint-disable no-control-regex -- terminal audit sanitization matches ESC/C0. */
  return input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  /* eslint-enable no-control-regex */
}

/**
 * Best-effort plain-text failure excerpt from the API-side owner recording.
 * Missing/unreadable logs return an empty string and never affect teardown.
 */
export async function readSessionLogTail(workspaceDir: string): Promise<string> {
  const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
  try {
    const { size } = await stat(logPath);
    if (size === 0) return '';
    const start = Math.max(0, size - SESSION_LOG_TAIL_BYTES);
    const length = size - start;
    const handle = await open(logPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const lines = stripAnsi(buffer.toString('utf8'))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      const tail = lines.slice(-SESSION_LOG_TAIL_LINES).join('\n');
      return tail.length > SESSION_LOG_TAIL_MAX_CHARS
        ? tail.slice(-SESSION_LOG_TAIL_MAX_CHARS)
        : tail;
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}
