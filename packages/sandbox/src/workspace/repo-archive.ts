import { spawn } from 'node:child_process';

/**
 * Host-side tar producer for the `archive` workspace-source variant
 * (add-repo-content-store D4).
 *
 * The repo-store copy is a bare mirror that can be arbitrarily large, so the
 * archive is produced as a byte STREAM: `tar` writes to a pipe and the chunks
 * are handed to the provider transport as they arrive. Nothing buffers the
 * whole archive in the API process.
 *
 * The archive's single top-level entry is the copy directory itself
 * (`<repoId>.git`), so unpacking it at a staging directory inside the sandbox
 * reproduces the store layout the local clone expects.
 */
export interface RepoStoreArchiveStreamArgs {
  /** Absolute host path of the bare mirror, e.g. `/repo-store/<repoId>.git`. */
  readonly storePath: string;
  readonly signal?: AbortSignal;
}

/** Bounded tail of `tar` stderr retained for the failure message. */
const MAX_TAR_STDERR_CHARS = 500;

export class RepoStoreArchiveStreamError extends Error {
  constructor(
    readonly reason: 'spawn_failed' | 'aborted' | 'tar_failed',
    detail?: string,
  ) {
    super(
      `repo store archive stream ${reason}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'RepoStoreArchiveStreamError';
  }
}

export function splitRepoStorePath(storePath: string): {
  readonly directory: string;
  readonly name: string;
} {
  const normalized = storePath.replace(/\/+$/u, '');
  const index = normalized.lastIndexOf('/');
  const name = index < 0 ? normalized : normalized.slice(index + 1);
  const directory = index <= 0 ? '/' : normalized.slice(0, index);
  if (
    !normalized.startsWith('/') ||
    name.length === 0 ||
    name === '.' ||
    name === '..'
  ) {
    throw new RepoStoreArchiveStreamError(
      'tar_failed',
      'storePath must be an absolute path naming a repo copy directory',
    );
  }
  return { directory, name };
}

export function createRepoStoreArchiveStream(
  args: RepoStoreArchiveStreamArgs,
): AsyncIterable<Uint8Array> {
  const { directory, name } = splitRepoStorePath(args.storePath);
  return {
    [Symbol.asyncIterator]: () => streamTar(directory, name, args.signal),
  };
}

async function* streamTar(
  directory: string,
  name: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array, void, undefined> {
  if (signal?.aborted) throw new RepoStoreArchiveStreamError('aborted');
  let child;
  try {
    child = spawn('tar', ['-C', directory, '-cf', '-', name], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw new RepoStoreArchiveStreamError(
      'spawn_failed',
      error instanceof Error ? error.message : undefined,
    );
  }

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_TAR_STDERR_CHARS) {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(
        0,
        MAX_TAR_STDERR_CHARS,
      );
    }
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', (error: Error) =>
      reject(new RepoStoreArchiveStreamError('spawn_failed', error.message)),
    );
    child.once('close', (code: number | null) => resolve(code ?? -1));
  });

  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (!child.stdout) {
      throw new RepoStoreArchiveStreamError('spawn_failed', 'tar has no stdout');
    }
    for await (const chunk of child.stdout) {
      yield chunk as Uint8Array;
    }
    const exitCode = await exited;
    if (signal?.aborted) throw new RepoStoreArchiveStreamError('aborted');
    if (exitCode !== 0) {
      throw new RepoStoreArchiveStreamError(
        'tar_failed',
        `exit_code ${exitCode}${stderr.trim() ? ` - ${stderr.trim()}` : ''}`,
      );
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
}
