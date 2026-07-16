import { Injectable } from '@nestjs/common';
import { GitBranchNameSchema } from '@cap/contracts';
import { DefaultForgeRegistry } from './forge-registry';
import type { ForgeTarget } from './forge.port';
import {
  RemoteRefsCommandRunner,
  RemoteRefsCommandRunnerError,
  type RemoteRefsCommandResult,
} from './remote-refs-command-runner';
import {
  RemoteRefsSecretStore,
  type RemoteRefsSecretLease,
} from './remote-refs-secret-store';

/** URL-import refs probing stays separate from the long workspace deadline. */
export const REMOTE_REFS_PROBE_TIMEOUT_MS = 15_000;

export type RemoteRefsProbeFailureReason =
  | 'authentication_failed'
  | 'access_denied'
  | 'network_unavailable'
  | 'default_branch_unresolved';

export type RemoteRefsProbeResult =
  | { readonly ok: true; readonly defaultBranch: string }
  | { readonly ok: false; readonly reason: RemoteRefsProbeFailureReason };

/** Structural DI port: callers and tests do not depend on implementation state. */
export abstract class RemoteRefsProbePort {
  abstract resolveDefaultBranch(
    target: ForgeTarget,
    signal?: AbortSignal,
  ): Promise<RemoteRefsProbeResult>;
}

/**
 * Authenticated `ls-remote --symref HEAD` probe for generic URL imports.
 *
 * The credential is written only to a mode-0600 temporary config whose HTTP
 * subsection is scoped to the clone URL's exact scheme/host/port. Git argv sees
 * only the path through `include.path`; the clean URL contains no userinfo, and
 * the runner exposes no environment field. Redirects and inherited credential
 * helpers are disabled so a different host cannot inherit this token. Raw
 * stdout/stderr remain inside this class and are reduced to stable reason codes.
 */
@Injectable()
export class GitRemoteRefsProbe extends RemoteRefsProbePort {
  constructor(
    private readonly registry: DefaultForgeRegistry,
    private readonly runner: RemoteRefsCommandRunner,
    private readonly secretStore: RemoteRefsSecretStore,
  ) {
    super();
  }

  async resolveDefaultBranch(
    target: ForgeTarget,
    signal: AbortSignal = AbortSignal.timeout(REMOTE_REFS_PROBE_TIMEOUT_MS),
  ): Promise<RemoteRefsProbeResult> {
    let secretLease: RemoteRefsSecretLease | null = null;
    let outcome: RemoteRefsProbeResult;
    try {
      const cleanUrl = this.cleanCloneUrl(target.cloneUrl);
      if (!cleanUrl) return { ok: false, reason: 'access_denied' };
      if (signal.aborted) return { ok: false, reason: 'network_unavailable' };

      const forge = this.registry.forKind(target.kind);
      const authHeader = forge.cloneAuthHeader(target);
      if (!this.safeHeader(authHeader)) {
        return { ok: false, reason: 'authentication_failed' };
      }

      secretLease = await this.secretStore.create(cleanUrl, authHeader);
      const result = await this.runner.run({
        args: [
          '-c',
          `include.path=${secretLease.configPath}`,
          'ls-remote',
          '--symref',
          '--exit-code',
          cleanUrl,
          'HEAD',
        ],
        signal,
      });
      outcome = this.interpretResult(result);
    } catch (error) {
      outcome = { ok: false, reason: this.classifyThrown(error) };
    }

    if (secretLease) {
      try {
        // The runner contract settles only after the command is stopped. Thus
        // cancellation cannot delete a file while git may still be reading it.
        await secretLease.cleanup();
      } catch {
        // Fail closed: even a successful HEAD probe is not reported as success
        // unless temporary credential removal is confirmed.
        outcome = { ok: false, reason: 'access_denied' };
      }
    }
    return outcome;
  }

  private cleanCloneUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username ||
        url.password ||
        !url.hostname
      ) {
        return null;
      }
      url.hash = '';
      url.search = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  private safeHeader(value: string): boolean {
    return (
      value.length > 0 &&
      value.length <= 16_384 &&
      !value.includes('\r') &&
      !value.includes('\n') &&
      !value.includes('\u0000')
    );
  }

  private interpretResult(result: RemoteRefsCommandResult): RemoteRefsProbeResult {
    if (result.exitCode === 0) {
      const defaultBranch = this.parseSymbolicHead(result.stdout);
      return defaultBranch
        ? { ok: true, defaultBranch }
        : { ok: false, reason: 'default_branch_unresolved' };
    }

    const diagnostic = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (
      /authentication failed|invalid (?:username|password)|could not read username|http basic: access denied|invalid credentials/u.test(
        diagnostic,
      )
    ) {
      return { ok: false, reason: 'authentication_failed' };
    }
    if (
      /repository not found|not found|permission denied|access denied|forbidden|\b403\b|does not exist|not authorized/u.test(
        diagnostic,
      )
    ) {
      return { ok: false, reason: 'access_denied' };
    }
    if (
      /could not resolve host|failed to connect|connection (?:timed out|reset|refused)|operation timed out|network is unreachable|ssl|tls|certificate/u.test(
        diagnostic,
      )
    ) {
      return { ok: false, reason: 'network_unavailable' };
    }
    if (result.exitCode === 2 && result.stdout.trim().length === 0) {
      return { ok: false, reason: 'default_branch_unresolved' };
    }
    // The remote was not safely validated. Do not guess that a credential is
    // invalid from unknown git text; report the broader access failure.
    return { ok: false, reason: 'access_denied' };
  }

  private parseSymbolicHead(stdout: string): string | null {
    for (const line of stdout.split(/\r?\n/u)) {
      const match = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/u.exec(line);
      if (!match) continue;
      const branch = GitBranchNameSchema.safeParse(match[1]);
      return branch.success ? branch.data : null;
    }
    return null;
  }

  private classifyThrown(error: unknown): RemoteRefsProbeFailureReason {
    if (
      error instanceof RemoteRefsCommandRunnerError &&
      (error.reason === 'aborted' || error.reason === 'spawn_failed')
    ) {
      return 'network_unavailable';
    }
    if (error instanceof RemoteRefsCommandRunnerError && error.reason === 'output_limit') {
      return 'access_denied';
    }
    // Local secure-file setup/cleanup errors never become raw public details.
    return 'access_denied';
  }
}
