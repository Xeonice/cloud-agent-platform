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

type StoredClaudeAuthResolution =
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'ready'; readonly material: ClaudeAuthMaterial };

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
 * Every lookup is keyed by the explicit authenticated/task owner. Only the
 * absence of an owner row may use the deployment fallback. An unsupported,
 * incomplete, or undecryptable owner row blocks fallback so provisioning and
 * model discovery cannot silently switch the owner to a process-level account.
 */
@Injectable()
export class PrismaClaudeAuthSource implements ClaudeAuthSource {
  private readonly logger = new Logger(PrismaClaudeAuthSource.name);
  private readonly envFallback = new EnvClaudeAuthSource();

  constructor(private readonly prisma: PrismaService) {}

  async getClaudeAuth(ownerUserId: string): Promise<ClaudeAuthMaterial | null> {
    const stored = await this.resolveFromSettings(ownerUserId);
    if (stored.kind === 'ready') return stored.material;
    if (stored.kind === 'blocked') return null;
    // A genuinely missing Settings row may use the legacy deployment token.
    return this.envFallback.getClaudeAuth(ownerUserId);
  }

  async configured(ownerUserId: string): Promise<boolean> {
    const stored = await this.resolveFromSettings(ownerUserId);
    if (stored.kind === 'ready') return true;
    if (stored.kind === 'blocked') return false;
    return this.envFallback.configured(ownerUserId);
  }

  /**
   * Distinguish an absent owner row from a present-but-unexecutable credential.
   * Only the former is eligible for deployment fallback.
   */
  private async resolveFromSettings(
    ownerUserId: string,
  ): Promise<StoredClaudeAuthResolution> {
    let cred: { mode: string; setupTokenCiphertext: string | null } | null;
    try {
      cred = await this.prisma.claudeCredential.findUnique({
        where: { userId: ownerUserId },
        select: { mode: true, setupTokenCiphertext: true },
      });
    } catch {
      this.logger.warn('claude credential lookup failed; fallback is blocked');
      return { kind: 'blocked' };
    }
    if (!cred) return { kind: 'missing' };
    if (cred.mode !== 'subscription' || !cred.setupTokenCiphertext) {
      this.logger.warn(
        'stored claude credential is not executable as a subscription; fallback is blocked',
      );
      return { kind: 'blocked' };
    }

    const token = this.decryptCiphertext(cred.setupTokenCiphertext, 'setup-token');
    if (token === null || !token.trim()) return { kind: 'blocked' };

    this.logger.debug('using settings-stored claude subscription token');
    return { kind: 'ready', material: { oauthToken: token.trim() } };
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
        `stored claude ${label} ciphertext is malformed; fallback is blocked`,
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
        }); fallback is blocked`,
      );
      return null;
    }
  }
}
