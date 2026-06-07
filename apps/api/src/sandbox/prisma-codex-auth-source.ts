import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  decryptSecret,
  resolveEncryptionKey,
} from '../settings/settings-crypto';
import type {
  CodexAuthMaterial,
  CodexAuthSource,
} from './codex-auth-source.port';
import { EnvCodexAuthSource } from './env-codex-auth-source';

/** Env var carrying the AES-256-GCM server key used to decrypt the stored auth.json. */
const CODEX_CRED_ENC_KEY_ENV = 'CODEX_CRED_ENC_KEY';

/**
 * Settings-backed {@link CodexAuthSource}: resolves the OFFICIAL-mode ChatGPT
 * login (`~/.codex/auth.json`) that the operator connected via the Settings page
 * ("official subscription" entry). The login is stored ENCRYPTED at rest in
 * `codex_credentials.auth_json_ciphertext`; this source decrypts it with the
 * server key (`CODEX_CRED_ENC_KEY`) and returns it for the provider to inject —
 * so the execution credential lives in the app (per-account, encrypted, rotatable
 * from the UI) instead of a deployment env var.
 *
 * Operator scoping: the credential is resolved for the CANONICAL operator — the
 * earliest allowed user — EXACTLY as {@link PrismaProvisionLookup} resolves the
 * clone token, so the codex login and the GitHub token both come from one
 * deterministic operator and a task never executes against an arbitrary other
 * allowlisted user's ChatGPT subscription. (The execution layer is single-
 * operator today: ProvisionContext carries only a taskId and the Task model has
 * no owner FK, so true per-task-owner credential scoping is a tracked follow-up.)
 *
 * Falls back to {@link EnvCodexAuthSource} (the legacy `CODEX_CHATGPT_AUTH_JSON_B64`)
 * when no official login is stored, the server key is unavailable, or the
 * ciphertext fails to decrypt — keeping a deploy that hasn't migrated to the
 * Settings flow working. The DB access lives here so {@link AioSandboxProvider}
 * stays a pure port consumer (mirrors {@link PrismaProvisionLookup}).
 */
@Injectable()
export class PrismaCodexAuthSource implements CodexAuthSource {
  private readonly logger = new Logger(PrismaCodexAuthSource.name);
  private readonly envFallback = new EnvCodexAuthSource();

  constructor(private readonly prisma: PrismaService) {}

  async getCodexAuth(): Promise<CodexAuthMaterial | null> {
    const settings = await this.resolveFromSettings();
    if (settings) return settings;
    // No usable Settings credential → legacy deployment env var (transition path).
    return this.envFallback.getCodexAuth();
  }

  /**
   * Decrypt the operator's official ChatGPT auth.json from the settings store, or
   * null when none is stored / the key is unavailable / decryption fails — never
   * throws, so a settings problem degrades to the env fallback rather than failing
   * provisioning.
   */
  private async resolveFromSettings(): Promise<CodexAuthMaterial | null> {
    let stored: string | null;
    try {
      // Resolve the CANONICAL operator deterministically (earliest allowed user),
      // mirroring PrismaProvisionLookup.resolveGitHubToken — NOT a global
      // findFirst over every official credential, which would let one task run
      // against an arbitrary other allowlisted user's ChatGPT login. The codex
      // login is then this canonical operator's stored official credential.
      const operator = await this.prisma.user.findFirst({
        where: { allowed: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!operator) return null;
      const cred = await this.prisma.codexCredential.findUnique({
        where: { userId: operator.id },
      });
      stored = cred?.mode === 'official' ? (cred.authJsonCiphertext ?? null) : null;
    } catch (err) {
      this.logger.warn(
        `codex credential lookup failed; falling back to env: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!stored) return null;

    // Stored as `ciphertext.iv.authTag` (base64 parts; base64 never contains '.').
    const parts = stored.split('.');
    if (parts.length !== 3) {
      this.logger.warn('stored codex auth.json ciphertext is malformed; falling back to env');
      return null;
    }
    const [ciphertext, iv, authTag] = parts;

    let authJson: string;
    try {
      const key = resolveEncryptionKey(process.env[CODEX_CRED_ENC_KEY_ENV]);
      authJson = decryptSecret({ ciphertext, iv, authTag }, key);
    } catch (err) {
      // EncryptionKeyUnavailableError / DecryptionFailedError → degrade to env.
      this.logger.warn(
        `could not decrypt stored codex auth.json (${
          err instanceof Error ? err.name : 'error'
        }); falling back to env`,
      );
      return null;
    }

    // Sanity-check the decrypted value is a codex auth document before injecting.
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
          'decrypted codex auth.json lacks auth_mode/tokens/OPENAI_API_KEY; falling back to env',
        );
        return null;
      }
    } catch {
      this.logger.warn('decrypted codex auth.json is not JSON; falling back to env');
      return null;
    }

    this.logger.debug('using settings-stored official codex auth.json');
    return { authJson };
  }
}
