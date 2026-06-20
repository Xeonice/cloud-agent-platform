import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  decryptSecret,
  encryptSecret,
  resolveEncryptionKey,
} from '../settings/settings-crypto';
import type {
  CodexAuthMaterial,
  CodexAuthSource,
} from './codex-auth-source.port';
import { EnvCodexAuthSource } from './env-codex-auth-source';

/** Env var carrying the AES-256-GCM server key used to decrypt the stored secret. */
const CODEX_CRED_ENC_KEY_ENV = 'CODEX_CRED_ENC_KEY';

/**
 * Settings-backed {@link CodexAuthSource}: resolves the per-task codex execution
 * credential the operator connected via the Settings page, in EITHER mode:
 *   - `official` → the ChatGPT login `~/.codex/auth.json`, stored ENCRYPTED at
 *     rest in `codex_credentials.auth_json_ciphertext`; decrypted here and
 *     returned as {@link OfficialCodexAuthMaterial} for the provider to write
 *     verbatim to `auth.json`.
 *   - `compatible` → an OpenAI-Responses-API-compatible provider. The API key is
 *     stored ENCRYPTED at rest in `codex_credentials.api_key_ciphertext`;
 *     decrypted here (reusing the same {@link decryptSecret} primitive as
 *     official) and returned as {@link CompatibleCodexAuthMaterial}
 *     (`baseUrl`/`apiKey`/`model`) for the provider to write into `config.toml`
 *     as a `[model_providers.*]` block (NO `auth.json`).
 * Either way the execution credential lives in the app (per-account, encrypted,
 * rotatable from the UI) instead of a deployment env var.
 *
 * OWNER-SCOPED resolution (design D3): the credential is resolved for the TASK's
 * OWNING account — the operator attributed on the task's `task.created` audit
 * event — NOT a global `findFirst({allowed:true})`. That global resolution would
 * let one task run against an arbitrary other allowlisted user's ChatGPT login or
 * compatible API key; scoping by the task owner means one operator's credential
 * is never used for another operator's tasks. When the task has no attributed
 * owner (system-created / no audit attribution) the credential cannot be
 * owner-scoped, so resolution degrades to the env/official fallback rather than
 * guessing an account.
 *
 * Falls back to {@link EnvCodexAuthSource} (the legacy `CODEX_CHATGPT_AUTH_JSON_B64`)
 * when no usable Settings credential is resolved for the owner, the server key is
 * unavailable, or the ciphertext fails to decrypt — keeping a deploy that hasn't
 * migrated to the Settings flow working, and keeping official/env-configured
 * deployments unaffected by the compatible path. The DB access lives here so
 * {@link AioSandboxProvider} stays a pure port consumer (mirrors
 * {@link PrismaProvisionLookup}).
 */
@Injectable()
export class PrismaCodexAuthSource implements CodexAuthSource {
  private readonly logger = new Logger(PrismaCodexAuthSource.name);
  private readonly envFallback = new EnvCodexAuthSource();

  constructor(private readonly prisma: PrismaService) {}

  async getCodexAuth(taskId: string): Promise<CodexAuthMaterial | null> {
    const settings = await this.resolveFromSettings(taskId);
    if (settings) return settings;
    // No usable Settings credential → legacy deployment env var (transition path).
    return this.envFallback.getCodexAuth(taskId);
  }

  /**
   * Persist codex's refreshed `auth.json` back to the task OWNER's stored OFFICIAL credential
   * (fix-codex-headless-subscription-auth). Owner-scoped (SAME resolution as `getCodexAuth`), so a
   * task can write only its own owner's row. No-op when: the owner is unattributed (the env
   * fallback supplied the credential — env is not writable), the stored credential is COMPATIBLE
   * (no `auth.json` to refresh), or the captured document is not a valid auth.json with a
   * `refresh_token` (so a capture-vs-trim race never overwrites a good credential with garbage).
   * NEVER throws — a failed persist just means the next task may re-refresh.
   */
  async persistRefreshedAuth(taskId: string, authJson: string): Promise<void> {
    if (!PrismaCodexAuthSource.isValidAuthJson(authJson)) return;
    const ownerId = await this.resolveTaskOwnerId(taskId);
    if (!ownerId) return;
    try {
      const cred = await this.prisma.codexCredential.findUnique({
        where: { userId: ownerId },
        select: { mode: true },
      });
      // Only an OFFICIAL stored credential carries an auth.json to refresh; a missing row means
      // the env fallback was used (not writable), and 'compatible' has no auth.json.
      if (!cred || cred.mode !== 'official') return;
      const ciphertext = this.encryptToStored(authJson);
      if (!ciphertext) return; // key unavailable → keep the prior stored value
      await this.prisma.codexCredential.update({
        where: { userId: ownerId },
        data: { authJsonCiphertext: ciphertext },
      });
      this.logger.debug(`persisted refreshed codex auth.json for owner ${ownerId}`);
    } catch (err) {
      this.logger.warn(
        `failed to persist refreshed codex auth.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** True only for a parseable auth.json carrying a non-empty `tokens.refresh_token`. */
  private static isValidAuthJson(authJson: string): boolean {
    try {
      const p = JSON.parse(authJson) as { tokens?: { refresh_token?: unknown } };
      const rt = p?.tokens?.refresh_token;
      return typeof rt === 'string' && rt.length > 0;
    } catch {
      return false;
    }
  }

  /** Encrypt + serialize to the stored `ciphertext.iv.authTag` form, or null if the key is unavailable. */
  private encryptToStored(plaintext: string): string | null {
    try {
      const key = resolveEncryptionKey(process.env[CODEX_CRED_ENC_KEY_ENV]);
      const { ciphertext, iv, authTag } = encryptSecret(plaintext, key);
      return `${ciphertext}.${iv}.${authTag}`;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the task OWNER's stored codex credential (official auth.json OR a
   * compatible provider), or null when none is stored / the owner is unknown /
   * the key is unavailable / decryption fails — never throws, so a settings
   * problem degrades to the env fallback rather than failing provisioning.
   */
  private async resolveFromSettings(
    taskId: string,
  ): Promise<CodexAuthMaterial | null> {
    let cred: {
      mode: string;
      authJsonCiphertext: string | null;
      apiKeyCiphertext: string | null;
      baseUrl: string | null;
      defaultModel: string | null;
    } | null;
    try {
      // OWNER-SCOPE: resolve the account that OWNS this task — the operator
      // attributed on its `task.created` audit event — rather than a global
      // findFirst over every credential, which would let one task run against an
      // arbitrary other allowlisted user's credential. No attributed owner (e.g.
      // a system-created task) → no owner-scoped credential; degrade to env.
      const ownerId = await this.resolveTaskOwnerId(taskId);
      if (!ownerId) return null;
      cred = await this.prisma.codexCredential.findUnique({
        where: { userId: ownerId },
        select: {
          mode: true,
          authJsonCiphertext: true,
          apiKeyCiphertext: true,
          baseUrl: true,
          defaultModel: true,
        },
      });
    } catch (err) {
      this.logger.warn(
        `codex credential lookup failed; falling back to env: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    if (!cred) return null;

    if (cred.mode === 'compatible') {
      return this.resolveCompatible(cred);
    }
    if (cred.mode === 'official') {
      return this.resolveOfficial(cred.authJsonCiphertext);
    }
    // Unknown / not-connected mode → nothing to inject from settings.
    return null;
  }

  /**
   * The owning account of `taskId`: the GitHub-identity operator attributed on
   * the task's `task.created` audit event (the only lifecycle event that records
   * the creating operator). Returns null when the task has no created-event
   * attribution — the task model itself has no owner FK, so this audit linkage is
   * the per-task owner of record. Never throws into the resolver (the caller's
   * try/catch degrades a DB error to the env fallback).
   */
  private async resolveTaskOwnerId(taskId: string): Promise<string | null> {
    const created = await this.prisma.auditEvent.findFirst({
      where: { taskId, type: 'task.created', userId: { not: null } },
      orderBy: { timestamp: 'asc' },
      select: { userId: true },
    });
    return created?.userId ?? null;
  }

  /**
   * Decrypt a compatible-provider credential into {@link CompatibleCodexAuthMaterial}.
   * Requires a Base URL, a stored API-key ciphertext, AND a default model — any
   * missing field makes the credential unusable for execution, so we return null
   * (degrade to env) rather than inject a half-configured provider that would burn
   * a run slot failing inside the sandbox.
   */
  private resolveCompatible(cred: {
    apiKeyCiphertext: string | null;
    baseUrl: string | null;
    defaultModel: string | null;
  }): CodexAuthMaterial | null {
    const { baseUrl, defaultModel } = cred;
    if (!baseUrl || !cred.apiKeyCiphertext || !defaultModel) {
      this.logger.warn(
        'compatible codex credential is missing baseUrl/apiKey/defaultModel; falling back to env',
      );
      return null;
    }
    const apiKey = this.decryptCiphertext(cred.apiKeyCiphertext, 'compatible API key');
    if (apiKey === null) return null;
    this.logger.debug('using settings-stored compatible codex provider credential');
    return { kind: 'compatible', baseUrl, apiKey, model: defaultModel };
  }

  /**
   * Decrypt + validate the official ChatGPT auth.json into
   * {@link OfficialCodexAuthMaterial}, or null when none is stored / the key is
   * unavailable / decryption fails / the decrypted value is not a codex auth
   * document (degrade to env, never throw).
   */
  private resolveOfficial(
    authJsonCiphertext: string | null,
  ): CodexAuthMaterial | null {
    if (!authJsonCiphertext) return null;
    const authJson = this.decryptCiphertext(authJsonCiphertext, 'auth.json');
    if (authJson === null) return null;

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
    return { kind: 'official', authJson };
  }

  /**
   * Decrypt a stored `ciphertext.iv.authTag` envelope (the at-rest format the
   * settings layer writes for BOTH official auth.json and the compatible API key)
   * with the server key, or null when the stored value is malformed, the key is
   * unavailable, or authentication fails. `label` only sharpens the warning; the
   * decrypted plaintext is NEVER logged.
   */
  private decryptCiphertext(stored: string, label: string): string | null {
    // Stored as `ciphertext.iv.authTag` (base64 parts; base64 never contains '.').
    const parts = stored.split('.');
    if (parts.length !== 3) {
      this.logger.warn(`stored codex ${label} ciphertext is malformed; falling back to env`);
      return null;
    }
    const [ciphertext, iv, authTag] = parts;
    try {
      const key = resolveEncryptionKey(process.env[CODEX_CRED_ENC_KEY_ENV]);
      return decryptSecret({ ciphertext, iv, authTag }, key);
    } catch (err) {
      // EncryptionKeyUnavailableError / DecryptionFailedError → degrade to env.
      this.logger.warn(
        `could not decrypt stored codex ${label} (${
          err instanceof Error ? err.name : 'error'
        }); falling back to env`,
      );
      return null;
    }
  }
}
