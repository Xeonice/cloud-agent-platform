import { Injectable, Logger } from '@nestjs/common';

import type {
  ClaudeAuthMaterial,
  ClaudeAuthSource,
} from './claude-auth-source.port';

/**
 * Deployment-level {@link ClaudeAuthSource}: reads the Claude OAuth subscription
 * token from the env var `CLAUDE_CODE_OAUTH_TOKEN` (minted on a workstation via
 * `claude setup-token`), mirroring {@link EnvCodexAuthSource}.
 *
 * Unlike codex's base64'd multi-line auth.json, the Claude token is a single
 * opaque string, so it is read RAW from the env (no base64 round-trip). Returns
 * `null` — the `claude-code` task then fails closed — when the var is unset or
 * blank.
 *
 * SINGLE-USER self-host: this carries the one operator's token, fed via the
 * gitignored `apps/api/.env` alongside the other deploy secrets. A multi-user
 * implementation would resolve a per-user token from settings — the same
 * {@link ClaudeAuthSource} port, a different source — with no change to the
 * runtime that consumes it.
 *
 * SECRET BOUNDARY: the token value is returned ONLY from {@link getClaudeAuth}
 * (consumed by `injectAuth`); {@link configured} exposes a BOOLEAN only, never the
 * token or a suffix, so the `/runtimes` readiness probe leaks nothing.
 */
@Injectable()
export class EnvClaudeAuthSource implements ClaudeAuthSource {
  private readonly logger = new Logger(EnvClaudeAuthSource.name);

  /** Env var carrying the operator's Claude OAuth subscription token. */
  static readonly ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

  async getClaudeAuth(_ownerUserId: string): Promise<ClaudeAuthMaterial | null> {
    const token = process.env[EnvClaudeAuthSource.ENV]?.trim();
    if (!token) {
      this.logger.warn(
        `${EnvClaudeAuthSource.ENV} is unset/blank; claude-code tasks will fail closed (runtime not configured)`,
      );
      return null;
    }
    return { oauthToken: token };
  }

  async configured(_ownerUserId: string): Promise<boolean> {
    // Boolean only — the readiness probe must never observe the token value.
    return Boolean(process.env[EnvClaudeAuthSource.ENV]?.trim());
  }
}
