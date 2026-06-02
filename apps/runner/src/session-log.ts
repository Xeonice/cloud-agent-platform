/**
 * @cap/runner — append-only session.log (Track 4, task 4.3).
 *
 * `workspaces/<id>/session.log` is the AUTHORITATIVE replay source for a task's
 * terminal output. Raw PTY bytes are appended in emission order and prior
 * content is NEVER overwritten — the file is open-append-only, so reconnect
 * snapshot + tail-replay (Track 5) can rely on it surviving across writes and
 * across an orchestrator restart (persistent volume, D5/D10).
 */
import { type WriteStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/** The fixed file name within each task workspace. */
export const SESSION_LOG_FILENAME = 'session.log';

/**
 * An append-only writer over a task's `session.log`.
 *
 * Bytes arriving from the PTY are written to the OS in emission order. The
 * stream is opened in `'a'` (append) mode so an existing log from a prior run is
 * extended, never truncated.
 */
export class SessionLog {
  /** Absolute path to this task's `session.log`. */
  public readonly path: string;

  private readonly handle: FileHandle;
  private readonly stream: WriteStream;
  private closed = false;

  private constructor(logPath: string, handle: FileHandle, stream: WriteStream) {
    this.path = logPath;
    this.handle = handle;
    this.stream = stream;
  }

  /**
   * Open (or create) the append-only `session.log` for a workspace directory.
   *
   * The file is opened in append mode (`'a'`): if it already exists, new bytes
   * are added to the end; the existing content is left intact. We pre-create the
   * file handle so the very first PTY byte cannot race directory creation.
   */
  static async open(workspaceDir: string): Promise<SessionLog> {
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    // Open in append mode (`'a'`) up-front so permission/path errors surface
    // eagerly rather than on the first PTY byte, and so an existing log is
    // extended, never truncated. The write stream is created from this handle.
    const handle = await open(logPath, 'a');
    const stream = handle.createWriteStream({ autoClose: false });
    return new SessionLog(logPath, handle, stream);
  }

  /**
   * Append raw PTY bytes in emission order. Accepts the UTF-8 string chunks
   * emitted by node-pty; they are written verbatim (no transformation) so the
   * log is a faithful byte record. No-ops after {@link close}.
   */
  append(bytes: string): void {
    if (this.closed) return;
    this.stream.write(bytes);
  }

  /** Flush and close the underlying stream and file handle. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: NodeJS.ErrnoException | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // `autoClose: false` leaves the handle open; close it explicitly. Tolerate
    // an already-closed handle so teardown is idempotent under races.
    await this.handle.close().catch(() => undefined);
  }
}
