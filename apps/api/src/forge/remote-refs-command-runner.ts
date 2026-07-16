import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';

export const MAX_REMOTE_REFS_OUTPUT_BYTES = 1024 * 1024;

export interface RemoteRefsCommandRequest {
  /** Arguments after the fixed `git` executable. Secret values are forbidden. */
  readonly args: readonly string[];
  readonly signal: AbortSignal;
}

export interface RemoteRefsCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RemoteRefsCommandRunnerFailureReason =
  | 'aborted'
  | 'spawn_failed'
  | 'output_limit';

export class RemoteRefsCommandRunnerError extends Error {
  constructor(readonly reason: RemoteRefsCommandRunnerFailureReason) {
    super(`remote refs command ${reason}`);
    this.name = 'RemoteRefsCommandRunnerError';
  }
}

/** Injectable seam so probe tests never need a real network or fixed sleeps. */
export abstract class RemoteRefsCommandRunner {
  /**
   * On cancellation this promise MUST settle only after the underlying command
   * has stopped and closed its stdio. Secret cleanup depends on that ordering.
   */
  abstract run(request: RemoteRefsCommandRequest): Promise<RemoteRefsCommandResult>;
}

/**
 * Build a deliberately small environment for host git.
 *
 * In particular, PAT variables, askpass programs, credential helpers, HOME and
 * proxy URLs are not inherited. System/global git config are disabled; the
 * probe's command-scoped include file is the only credential source.
 */
export function buildRemoteRefsGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    LC_ALL: 'C',
  };
  // Executable discovery and operator-managed trust stores are non-secret and
  // necessary on self-hosted installations. Nothing else is inherited.
  for (const key of ['PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export type RemoteRefsSpawn = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ReturnType<typeof spawn>;

const spawnRemoteRefsGit: RemoteRefsSpawn = (args, env) =>
  spawn('git', [...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });

/**
 * Testable process lifecycle core. The injected spawn seam receives no secret,
 * only already-sanitized argv and environment values.
 */
export function runRemoteRefsGitCommand(
  request: RemoteRefsCommandRequest,
  spawnGit: RemoteRefsSpawn = spawnRemoteRefsGit,
): Promise<RemoteRefsCommandResult> {
  return new Promise((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new RemoteRefsCommandRunnerError('aborted'));
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnGit(request.args, buildRemoteRefsGitEnvironment());
      } catch {
        reject(
          new RemoteRefsCommandRunnerError(
            request.signal.aborted ? 'aborted' : 'spawn_failed',
          ),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let pendingError: RemoteRefsCommandRunnerError | null = null;

      const stop = (error: RemoteRefsCommandRunnerError) => {
        if (settled || pendingError) return;
        pendingError = error;
        // SIGKILL makes cancellation ordering deterministic: `run` still waits
        // for `close`, and only then may the caller remove the config file.
        child.kill('SIGKILL');
      };
      const capture = (destination: Buffer[], chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        outputBytes += value.byteLength;
        if (outputBytes > MAX_REMOTE_REFS_OUTPUT_BYTES) {
          stop(new RemoteRefsCommandRunnerError('output_limit'));
          return;
        }
        destination.push(value);
      };

      const onAbort = () => stop(new RemoteRefsCommandRunnerError('aborted'));
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();

      child.stdout?.on('data', (chunk: Buffer | string) => capture(stdout, chunk));
      child.stderr?.on('data', (chunk: Buffer | string) => capture(stderr, chunk));
      child.once('error', () => {
        if (settled || pendingError) return;
        // A ChildProcess `error` means the executable did not start (most notably
        // ENOENT). Preserve that local spawn identity and wait for `close` before
        // settling, but never retain the raw Error/cause: it may contain a PATH,
        // command detail, or other deployment diagnostic unsuitable for callers.
        pendingError = new RemoteRefsCommandRunnerError(
          request.signal.aborted ? 'aborted' : 'spawn_failed',
        );
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        if (pendingError) {
          reject(pendingError);
          return;
        }
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
  });
}

/** No-shell bounded host-git executor. It never logs command or output. */
@Injectable()
export class NodeRemoteRefsCommandRunner extends RemoteRefsCommandRunner {
  run(request: RemoteRefsCommandRequest): Promise<RemoteRefsCommandResult> {
    return runRemoteRefsGitCommand(request);
  }
}
