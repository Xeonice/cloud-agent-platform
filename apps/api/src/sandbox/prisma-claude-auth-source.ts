import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  decryptSecret,
  resolveEncryptionKey,
} from '../settings/settings-crypto';
import type {
  ClaudeAuthMaterial,
  ClaudeAuthSource,
} from './claude-auth-source.port';
import { EnvClaudeAuthSource } from './env-claude-auth-source';

/**
 * Server key used to decrypt the stored Claude secret. Reuses the SAME
 * AES-256-GCM key env as the codex credential (`CODEX_CRED_ENC_KEY`) so a
 * self-host configures one credential-encryption key for all stored model
 * secrets rather than a per-runtime key.
 */
const CLAUDE_CRED_ENC_KEY_ENV = 'CODEX_CRED_ENC_KEY';

/**
 * Settings-backed {@link ClaudeAuthSource}: resolves the Claude Code OAuth token
 * the operator connected via the Settings page (subscription mode — a
 * `claude setup-token` token stored ENCRYPTED at rest in
 * `claude_credentials.setup_token_ciphertext`), decrypted here and returned as
 * the runtime-consumed {@link ClaudeAuthMaterial} (`oauthToken`). The DB-backed
 * sibling of {@link PrismaCodexAuthSource} — the deferred "settings/DB-backed
 * source satisfies the SAME port" the {@link ClaudeAuthSource} doc anticipated —
 * so the Claude token lives in the app (encrypted, rotatable from the UI) rather
 * than only a deployment env var.
 *
 * Falls back to {@link EnvClaudeAuthSource} (the `CLAUDE_CODE_OAUTH_TOKEN` env)
 * when no usable Settings credential is stored, the server key is unavailable, or
 * the ciphertext fails to decrypt — keeping an env-configured deploy working.
 *
 * NOTE (follow-up, mirroring how codex evolved): the {@link ClaudeAuthSource}
 * port has NO `taskId`, so this resolution is NOT owner-scoped the way
 * {@link PrismaCodexAuthSource} is. For the single-operator self-host there is at
 * most one stored credential, so a `findFirst` is correct; multi-user
 * owner-scoping needs a `taskId` threaded onto the port (and its consumer) and is
 * deferred. The `api_key` mode is stored/masked by the settings layer but NOT
 * resolved here — the runtime injects only the OAuth token today and actively
 * unsets `ANTHROPIC_API_KEY`, so api-key INJECTION is a separate runtime change.
 */
@Injectable()
export class PrismaClaudeAuthSource implements ClaudeAuthSource {
  private readonly logger = new Logger(PrismaClaudeAuthSource.name);
  private readonly envFallback = new EnvClaudeAuthSource();

  constructor(private readonly prisma: PrismaService) {}

  async getClaudeAuth(): Promise<ClaudeAuthMaterial | null> {
    const stored = await this.resolveFromSettings();
    if (stored) return stored;
    // No usable Settings credential → legacy deployment env var (transition path).
    return this.envFallback.getClaudeAuth();
  }

  async configured(): Promise<boolean> {
    try {
      const cred = await this.prisma.claudeCredential.findFirst({
        where: { mode: 'subscription', setupTokenCiphertext: { not: null } },
        select: { id: true },
      });
      if (cred) return true;
    } catch (err) {
      this.logger.warn(
        `claude credential readiness lookup failed; falling back to env: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Boolean only — never observe the token value on the readiness path.
    return this.envFallback.configured();
  }

  /**
   * Resolve the stored subscription setup-token into {@link ClaudeAuthMaterial},
   * or null when none is stored / the key is unavailable / decryption fails
   * (degrade to env, never throw into provisioning).
   */
  private async resolveFromSettings(): Promise<ClaudeAuthMaterial | null> {
    let cred: { setupTokenCiphertext: string | null } | null;
    try {
      cred = await this.prisma.claudeCredential.findFirst({
        where: { mode: 'subscription', setupTokenCiphertext: { not: null } },
        select: { setupTokenCiphertext: true },
        orderBy: { id: 'asc' },
      });
    } catch (err) {
      this.logger.warn(
        `claude credential lookup failed; falling back to env: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!cred?.setupTokenCiphertext) return null;

    const token = this.decryptCiphertext(cred.setupTokenCiphertext, 'setup-token');
    if (token === null) return null;

    this.logger.debug('using settings-stored claude subscription token');
    return { oauthToken: token };
  }

  /**
   * Decrypt a stored `ciphertext.iv.authTag` envelope (the at-rest format the
   * settings layer writes) with the server key, or null when malformed / the key
   * is unavailable / authentication fails. The plaintext is NEVER logged.
   */
  private decryptCiphertext(stored: string, label: string): string | null {
    const parts = stored.split('.');
    if (parts.length !== 3) {
      this.logger.warn(
        `stored claude ${label} ciphertext is malformed; falling back to env`,
      );
      return null;
    }
    const [ciphertext, iv, authTag] = parts;
    try {
      const key = resolveEncryptionKey(process.env[CLAUDE_CRED_ENC_KEY_ENV]);
      return decryptSecret({ ciphertext, iv, authTag }, key);
    } catch (err) {
      this.logger.warn(
        `could not decrypt stored claude ${label} (${
          err instanceof Error ? err.name : 'error'
        }); falling back to env`,
      );
      return null;
    }
  }
}
