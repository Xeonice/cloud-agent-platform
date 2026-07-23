import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';

/**
 * Host-git primitives for the repo-store (add-repo-content-store).
 *
 * Content acquisition moved from the sandbox to the API host, so the token
 * hygiene the sandbox clone machinery relied on has to be reproduced here:
 * the credential never reaches argv, the clone URL, or any persisted git
 * config — it lives only in a mode-0600 temporary file whose HTTP subsection is
 * pinned to the source's exact scheme/host/port, referenced through
 * `GIT_CONFIG_GLOBAL` (env config is NOT copied into the new repository the way
 * `git clone -c ...` would be). Command output is never logged; it is reduced
 * to a bounded, redacted summary plus a stable reason code.
 */

/** Bounded tail of command output retained for the failure summary. */
export const MAX_REPO_STORE_OUTPUT_BYTES = 16 * 1024;

/** Maximum length of the redacted detail handed back to callers. */
export const MAX_REPO_STORE_DETAIL_CHARS = 2000;

/** Phases a caller can observe while a copy is being materialized. */
export type RepoStoreStage = 'preparing' | 'transferring' | 'finalizing';

/** A single bounded, secret-free progress observation. */
export interface RepoStoreProgressEvent {
  readonly stage: RepoStoreStage;
  /** 0-100 when git reported a percentage for the current phase. */
  readonly percent?: number;
  /** Redacted, single-line git progress text (e.g. `Receiving objects`). */
  readonly message: string;
}

export type RepoStoreProgressListener = (event: RepoStoreProgressEvent) => void;

/** Typed acquisition/refresh failure causes. */
export type RepoStoreFailureReason =
  /** Credential missing, rejected, or expired. */
  | 'authentication_failed'
  /** Authenticated but not permitted / repository not visible. */
  | 'access_denied'
  /** DNS, TCP, TLS, or transport timeout. */
  | 'network_unavailable'
  /** The recorded source is not a usable git source (bad URL/path/not a repo). */
  | 'source_invalid'
  /** Refresh was asked for a Repo whose copy is not in the store. */
  | 'copy_missing'
  /** The repo-store volume itself could not be written/renamed. */
  | 'store_unavailable'
  /** `git` is not installed / could not be spawned. */
  | 'platform_dependency_unavailable'
  /** The caller's signal aborted the operation. */
  | 'aborted';

export interface RepoStoreCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  /** Bounded tail, already redacted. */
  readonly stderr: string;
}

export type RepoStoreCommandFailureReason = 'aborted' | 'spawn_failed';

export class RepoStoreCommandError extends Error {
  constructor(readonly reason: RepoStoreCommandFailureReason) {
    super(`repo store command ${reason}`);
    this.name = 'RepoStoreCommandError';
  }
}

export interface RepoStoreCommandRequest {
  /** Arguments after the fixed `git` executable. Secret values are forbidden. */
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  /** Path to a mode-0600 git config carrying the credential, when authenticated. */
  readonly credentialConfigPath?: string;
  readonly stage: RepoStoreStage;
  readonly onProgress?: RepoStoreProgressListener;
}

/**
 * Deliberately small git environment: no PAT variables, askpass programs,
 * credential helpers, HOME, or proxy URLs are inherited. System config is
 * disabled and the global config is either `/dev/null` or the caller's
 * short-lived credential file — nothing else can introduce a credential.
 */
export function buildRepoStoreGitEnvironment(
  credentialConfigPath: string | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: credentialConfigPath ?? nullConfig,
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

/** Strips anything that could carry a credential out of command output. */
export function redactGitOutput(value: string): string {
  const redacted = value
    .replace(/authorization:[^\r\n]*/gi, 'authorization: [redacted]')
    .replace(/extraheader[^\r\n]*/gi, 'extraHeader [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@');
  return redacted.length > MAX_REPO_STORE_DETAIL_CHARS
    ? `${redacted.slice(-MAX_REPO_STORE_DETAIL_CHARS)}`
    : redacted;
}

export type RepoStoreSpawn = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => ReturnType<typeof spawn>;

const spawnRepoStoreGit: RepoStoreSpawn = (args, env) =>
  spawn('git', [...args], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  });

/** `Receiving objects:  42% (…)` / `Resolving deltas:   7% (…)`. */
const GIT_PROGRESS_LINE = /^([A-Za-z][A-Za-z .]*?):\s+(\d{1,3})%/u;

/**
 * Runs one host-git command, streaming bounded progress and retaining only the
 * tail of the output. Cancellation settles only after the child has closed its
 * stdio, so the caller may safely delete the credential file afterwards.
 */
export function runRepoStoreGitCommand(
  request: RepoStoreCommandRequest,
  spawnGit: RepoStoreSpawn = spawnRepoStoreGit,
): Promise<RepoStoreCommandResult> {
  return new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new RepoStoreCommandError('aborted'));
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnGit(
        request.args,
        buildRepoStoreGitEnvironment(request.credentialConfigPath),
      );
    } catch {
      reject(
        new RepoStoreCommandError(
          request.signal.aborted ? 'aborted' : 'spawn_failed',
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let pendingError: RepoStoreCommandError | null = null;
    let progressCarry = '';
    let lastProgress = '';

    const trimTail = (buffers: Buffer[], bytes: number): number => {
      // Retain only the tail: clone/fetch progress is unbounded by design.
      let total = bytes;
      while (total > MAX_REPO_STORE_OUTPUT_BYTES && buffers.length > 1) {
        const dropped = buffers.shift();
        total -= dropped ? dropped.byteLength : 0;
      }
      return total;
    };

    const emitProgress = (line: string) => {
      if (!request.onProgress) return;
      const text = redactGitOutput(line).trim();
      if (!text || text === lastProgress) return;
      lastProgress = text;
      const match = GIT_PROGRESS_LINE.exec(text);
      const percent = match ? Math.min(100, Number(match[2])) : undefined;
      request.onProgress({
        stage: request.stage,
        ...(percent === undefined ? {} : { percent }),
        message: text.slice(0, 200),
      });
    };

    const consumeProgress = (chunk: Buffer) => {
      if (!request.onProgress) return;
      progressCarry += chunk.toString('utf8');
      // git separates progress updates with \r and finishes phases with \n.
      const parts = progressCarry.split(/[\r\n]/u);
      progressCarry = parts.pop() ?? '';
      for (const part of parts) emitProgress(part);
      if (progressCarry.length > 4096) progressCarry = '';
    };

    const onAbort = () => {
      if (settled || pendingError) return;
      pendingError = new RepoStoreCommandError('aborted');
      // SIGKILL keeps cancellation ordering deterministic: `close` still fires,
      // and only then may the caller remove the credential file.
      child.kill('SIGKILL');
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout.push(value);
      stdoutBytes = trimTail(stdout, stdoutBytes + value.byteLength);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr.push(value);
      stderrBytes = trimTail(stderr, stderrBytes + value.byteLength);
      consumeProgress(value);
    });
    child.once('error', () => {
      if (settled || pendingError) return;
      // A ChildProcess `error` means the executable did not start (ENOENT most
      // notably). Keep that local identity, but never retain the raw Error: it
      // may carry PATH or other deployment detail unsuitable for callers.
      pendingError = new RepoStoreCommandError(
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
        stdout: redactGitOutput(Buffer.concat(stdout).toString('utf8')),
        stderr: redactGitOutput(Buffer.concat(stderr).toString('utf8')),
      });
    });
  });
}

/** Injectable seam so service tests can drive git without a network. */
export abstract class RepoStoreCommandRunner {
  /**
   * On cancellation this promise MUST settle only after the underlying command
   * has stopped and closed its stdio. Credential cleanup depends on that.
   */
  abstract run(request: RepoStoreCommandRequest): Promise<RepoStoreCommandResult>;
}

/** No-shell bounded host-git executor. It never logs command or output. */
@Injectable()
export class NodeRepoStoreCommandRunner extends RepoStoreCommandRunner {
  run(request: RepoStoreCommandRequest): Promise<RepoStoreCommandResult> {
    return runRepoStoreGitCommand(request);
  }
}

export interface RepoStoreCredentialLease {
  /** Safe to reference from env; secret content never appears in this value. */
  readonly configPath: string;
  /** Resolves only after recursive removal is confirmed by the filesystem API. */
  cleanup(): Promise<void>;
}

export class RepoStoreCredentialError extends Error {
  constructor(readonly reason: 'setup_failed' | 'cleanup_failed') {
    super(`repo store credential ${reason}`);
    this.name = 'RepoStoreCredentialError';
  }
}

/** Structured seam for a short-lived exact-host git credential file. */
export abstract class RepoStoreCredentialStore {
  abstract create(
    cleanUrl: string,
    authHeader: string,
  ): Promise<RepoStoreCredentialLease>;
}

/** Host filesystem implementation; no secret/path value is ever logged. */
@Injectable()
export class NodeRepoStoreCredentialStore extends RepoStoreCredentialStore {
  async create(
    cleanUrl: string,
    authHeader: string,
  ): Promise<RepoStoreCredentialLease> {
    let directory: string | null = null;
    try {
      directory = await mkdtemp(join(tmpdir(), 'cap-repo-store-'));
      await chmod(directory, 0o700);
      const configPath = join(directory, 'gitconfig');
      await writeFile(configPath, exactHostConfig(cleanUrl, authHeader), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(configPath, 0o600);
      if (((await stat(configPath)).mode & 0o777) !== 0o600) {
        throw new RepoStoreCredentialError('setup_failed');
      }

      const created = directory;
      let cleaned = false;
      return {
        configPath,
        async cleanup(): Promise<void> {
          if (cleaned) return;
          try {
            await rm(created, { recursive: true, force: true });
            cleaned = true;
          } catch {
            throw new RepoStoreCredentialError('cleanup_failed');
          }
        },
      };
    } catch (error) {
      if (directory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          throw new RepoStoreCredentialError('cleanup_failed');
        }
      }
      if (error instanceof RepoStoreCredentialError) throw error;
      throw new RepoStoreCredentialError('setup_failed');
    }
  }
}

/**
 * Credential config pinned to the source's exact origin, with inherited helpers
 * and redirects disabled so no other host can ever inherit this token.
 */
export function exactHostConfig(cleanUrl: string, authHeader: string): string {
  const url = new URL(cleanUrl);
  const origin = `${url.protocol}//${url.host}/`;
  const quotedOrigin = origin.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return (
    `[credential]\n` +
    `\thelper =\n` +
    `\tinteractive = never\n` +
    `[http]\n` +
    `\tfollowRedirects = false\n` +
    `[http "${quotedOrigin}"]\n` +
    `\textraHeader = ${authHeader}\n`
  );
}

/** Rejects header values that could smuggle extra config lines. */
export function isSafeAuthHeader(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 16_384 &&
    !value.includes('\r') &&
    !value.includes('\n') &&
    !value.includes(' ')
  );
}

/**
 * Maps git's exit text onto the typed cause vocabulary. Unknown text is never
 * guessed into `authentication_failed`; it degrades to the broader
 * `access_denied` so operators are not sent chasing a credential that works.
 */
export function classifyGitFailure(
  result: RepoStoreCommandResult,
): RepoStoreFailureReason {
  const diagnostic = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /authentication failed|invalid (?:username|password)|could not read username|http basic: access denied|invalid credentials|terminal prompts disabled/u.test(
      diagnostic,
    )
  ) {
    return 'authentication_failed';
  }
  if (
    /could not resolve host|failed to connect|connection (?:timed out|reset|refused)|operation timed out|network is unreachable|early eof|rpc failed|ssl|tls|certificate/u.test(
      diagnostic,
    )
  ) {
    return 'network_unavailable';
  }
  if (
    /does not appear to be a git repository|not a git repository|repository not found|repository [^\n]*does not exist|no such file or directory|unable to find remote helper|unable to access|invalid refspec|remote branch .* not found/u.test(
      diagnostic,
    )
  ) {
    return 'source_invalid';
  }
  if (
    /permission denied|access denied|forbidden|\b403\b|does not exist|not authorized/u.test(
      diagnostic,
    )
  ) {
    return 'access_denied';
  }
  return 'access_denied';
}
