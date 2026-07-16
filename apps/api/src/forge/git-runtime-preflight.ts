import {
  NodeRemoteRefsCommandRunner,
  type RemoteRefsCommandRunner,
} from './remote-refs-command-runner';

/** Startup must not wait indefinitely for a broken local executable. */
export const GIT_RUNTIME_PREFLIGHT_TIMEOUT_MS = 5_000;

/** Test/custom adapters may shorten the deadline but may never make it unbounded. */
export const GIT_RUNTIME_PREFLIGHT_MAX_TIMEOUT_MS = 30_000;

/** The only startup diagnostic emitted for this gate; no argv/output/cause is logged. */
export const GIT_RUNTIME_PREFLIGHT_FATAL_MESSAGE =
  'FATAL: platform_dependency_unavailable: required executable git could not be verified.';

export class GitRuntimePreflightError extends Error {
  readonly reason = 'platform_dependency_unavailable' as const;
  readonly dependency = 'git' as const;

  constructor() {
    super('Required platform dependency is unavailable: git');
    this.name = 'GitRuntimePreflightError';
  }
}

export interface GitRuntimePreflightOptions {
  /** Injectable command seam for deterministic tests; production uses host Git. */
  readonly runner?: Pick<RemoteRefsCommandRunner, 'run'>;
  /** Bounded override for tests/custom startup harnesses. */
  readonly timeoutMs?: number;
}

/**
 * Prove that the API process can start the Git executable it later uses for
 * authenticated remote-ref resolution.
 *
 * The shared runner fixes the executable to `git`, disables shell execution,
 * bounds captured output, and supplies the same minimal credential-free
 * environment as the remote-ref path. This function accepts no command or
 * environment input and discards stdout, stderr, spawn causes, and abort causes
 * on every failure path.
 */
export async function assertGitRuntimeAvailable(
  options: GitRuntimePreflightOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? GIT_RUNTIME_PREFLIGHT_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > GIT_RUNTIME_PREFLIGHT_MAX_TIMEOUT_MS
  ) {
    throw new GitRuntimePreflightError();
  }

  const runner = options.runner ?? new NodeRemoteRefsCommandRunner();
  const controller = new AbortController();
  // Unlike AbortSignal.timeout(), this ordinary timer keeps a just-starting API
  // process alive until the gate has conclusively passed or failed.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await runner.run({
      args: ['--version'],
      signal: controller.signal,
    });
    if (result.exitCode !== 0 || !isGitVersionOutput(result.stdout)) {
      throw new GitRuntimePreflightError();
    }
  } catch {
    // Never attach the raw cause. In particular, an ENOENT path, stderr, a
    // command-runner error, or an AbortSignal reason must not cross this gate.
    throw new GitRuntimePreflightError();
  } finally {
    clearTimeout(timeout);
  }
}

function isGitVersionOutput(stdout: string): boolean {
  return /^git version \S+(?:\s.*)?$/u.test(stdout.trim());
}
