import { Injectable, Logger } from '@nestjs/common';

import type {
  CodexAuthMaterial,
  CodexAuthSource,
} from './codex-auth-source.port';

/**
 * Deployment-level {@link CodexAuthSource}: reads the ChatGPT(official)
 * `~/.codex/auth.json` from the env var `CODEX_CHATGPT_AUTH_JSON_B64`, whose
 * value is the BASE64 of that auth.json file.
 *
 * base64 (not raw JSON) so the multi-line document survives the `.env`/process
 * env round-trip with no quoting/newline pain, and so the secret never appears
 * as readable JSON in `docker inspect`/process listings. Returns `null` (the
 * provider then skips injection) when the var is unset/blank, not valid base64,
 * or the decoded value is not a codex auth document.
 *
 * SINGLE-USER self-host: this carries the one operator's login state, fed via
 * the gitignored `apps/api/.env` alongside the other deploy secrets. A
 * multi-user implementation would instead resolve per-user login state from
 * settings — the same {@link CodexAuthSource} port, a different source — with no
 * change to the provider that consumes it.
 */
@Injectable()
export class EnvCodexAuthSource implements CodexAuthSource {
  private readonly logger = new Logger(EnvCodexAuthSource.name);

  /** Env var carrying the base64 of the operator's `~/.codex/auth.json`. */
  static readonly ENV = 'CODEX_CHATGPT_AUTH_JSON_B64';

  async getCodexAuth(): Promise<CodexAuthMaterial | null> {
    const b64 = process.env[EnvCodexAuthSource.ENV]?.trim();
    if (!b64) return null;

    let authJson: string;
    try {
      authJson = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      this.logger.warn(
        `${EnvCodexAuthSource.ENV} is set but not valid base64; skipping codex auth injection`,
      );
      return null;
    }

    // Sanity-check the decoded value is a codex auth document before handing it
    // off to be written into the sandbox — a malformed value would silently
    // leave codex unauthenticated, so fail to null (skip) loudly instead.
    try {
      const parsed = JSON.parse(authJson) as {
        auth_mode?: unknown;
        tokens?: unknown;
        OPENAI_API_KEY?: unknown;
      };
      if (
        parsed.auth_mode === undefined &&
        parsed.tokens === undefined &&
        parsed.OPENAI_API_KEY === undefined
      ) {
        this.logger.warn(
          `${EnvCodexAuthSource.ENV} decoded JSON lacks auth_mode/tokens/OPENAI_API_KEY; skipping codex auth injection`,
        );
        return null;
      }
    } catch {
      this.logger.warn(
        `${EnvCodexAuthSource.ENV} decoded value is not JSON; skipping codex auth injection`,
      );
      return null;
    }

    return { authJson };
  }
}
