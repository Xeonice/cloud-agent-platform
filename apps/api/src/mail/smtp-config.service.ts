import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ResolvedSmtpConfig } from './mail.service';
import {
  decryptStored,
  encryptToStored,
  isEncryptionKeyConfigured,
} from '../settings/secret-storage';
import {
  EncryptionKeyUnavailableError,
  maskApiKeySuffix,
} from '../settings/settings-crypto';

/**
 * Persisted-DB SMTP configuration service (add-smtp-config-ui, track
 * backend-storage — task 2.2; spec `smtp-configuration`).
 *
 * Owns the SINGLETON deployment-level SMTP config row (design D1): one fixed-id
 * upsert, NOT keyed by `userId` (SMTP is one outbound server for the deployment,
 * unlike the per-user `CodexCredential`). It is the storage half of the
 * DB-first/env-fallback mail resolution (design D3): {@link resolveDbSmtpConfig}
 * is what `MailService` consults FIRST, falling back to the `SMTP_*` env when it
 * returns null.
 *
 * Secret discipline (design D2, mirrors `forge-credential` / the Codex
 * credential): the password is persisted ONLY as `passCiphertext` (the shared
 * `secret-storage` born-encrypted envelope — ciphertext only, NEVER plaintext)
 * alongside `passLast4`, a masked suffix for display. FAIL-CLOSED: with no
 * `CODEX_CRED_ENC_KEY` a save is rejected so a plaintext password can never be
 * stored. A read NEVER returns the plaintext password.
 *
 * This file does NOT edit `mail.module.ts` — its provider wiring is the
 * integration track's (task 6.1).
 */

/** The fixed singleton id of the shared `smtp_config` row (one row per deploy). */
export const SMTP_CONFIG_ROW_ID = 'smtp';

/**
 * The save payload: the non-secret host/port/user/from plus the password, which
 * is present ONLY on save (never on a read). Declared locally so this storage
 * service stays self-contained; the `@cap/contracts` `SaveSmtpConfigRequest`
 * (track contracts, task 1.1) is the wire shape the admin controller (task 4.1)
 * validates and adapts onto this.
 */
export interface SaveSmtpConfigInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly from: string;
  /**
   * The SMTP password (= the Resend API key). Optional on save: when omitted (or
   * blank) the existing stored password is KEPT (the dialog's "留空沿用"), so an
   * admin can edit the non-secret fields without re-entering the secret.
   */
  readonly pass?: string;
}

/**
 * The masked read projection (design D6): the non-secret host/port/user/from
 * plus a masked password indicator (`passLast4` + `hasPassword`). NEVER carries
 * the plaintext password. Mirrors `@cap/contracts` `SmtpConfigRead`. Null when
 * no DB config row exists.
 */
export interface SmtpConfigRead {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly from: string;
  /** Masked last-4 suffix of the stored password, or null when none is stored. */
  readonly passLast4: string | null;
  /** True when an (encrypted) password is stored. */
  readonly hasPassword: boolean;
}

/**
 * The fully-resolved DB SMTP transport config — the decrypted shape the mail
 * path consumes. Returned only when the row is complete (a password is stored
 * AND decrypts); otherwise {@link resolveDbSmtpConfig} returns null so the
 * caller falls back to the env (design D3).
 */
export interface ResolvedDbSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
}

/**
 * The minimal `SmtpConfig` row shape the service reads. Declared structurally so
 * the service does not hard-couple to the generated Prisma row type before the
 * client is regenerated, mirroring the admin-seed's structural `SeedUserRow`.
 */
interface SmtpConfigRow {
  host: string;
  port: number;
  user: string;
  from: string;
  passCiphertext: string | null;
  passLast4: string | null;
}

@Injectable()
export class SmtpConfigService {
  private readonly logger = new Logger(SmtpConfigService.name);

  constructor(
    /**
     * Prisma client. Optional so a unit context can construct the service
     * without a database — reads then degrade to null and a save surfaces a
     * clear error rather than crashing.
     */
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * Read the singleton config as a MASKED projection (design D6): host/port/user/
   * from + `passLast4` + `hasPassword`, NEVER the plaintext password. Null when
   * no row exists.
   */
  async readConfig(): Promise<SmtpConfigRead | null> {
    const row = await this.findRow();
    if (!row) {
      return null;
    }
    return {
      host: row.host,
      port: row.port,
      user: row.user,
      from: row.from,
      passLast4: row.passLast4,
      hasPassword: typeof row.passCiphertext === 'string' && row.passCiphertext.length > 0,
    };
  }

  /**
   * Save (upsert) the singleton config, encrypting the password at rest (design
   * D2). FAIL-CLOSED: when a password is supplied but no `CODEX_CRED_ENC_KEY` is
   * configured the save is rejected so a plaintext password is NEVER persisted.
   * A blank/omitted password keeps the existing stored secret ("留空沿用").
   * Returns the masked read projection of the saved row.
   */
  async saveConfig(
    input: SaveSmtpConfigInput,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SmtpConfigRead> {
    if (!this.prisma) {
      throw new Error('SMTP config save unavailable: no prisma client wired');
    }

    const pass = typeof input.pass === 'string' ? input.pass.trim() : '';
    const settingPassword = pass.length > 0;

    // Fail closed: never store a plaintext password without a configured key.
    if (settingPassword && !isEncryptionKeyConfigured(env)) {
      throw new EncryptionKeyUnavailableError(
        'SMTP password cannot be saved: no at-rest encryption key is configured ' +
          `(set CODEX_CRED_ENC_KEY). No plaintext password was stored.`,
      );
    }

    const passCiphertext = settingPassword ? encryptToStored(pass, env) : undefined;
    const passLast4 = settingPassword ? maskApiKeySuffix(pass) : undefined;

    const nonSecret = {
      host: input.host,
      port: input.port,
      user: input.user,
      from: input.from,
    };

    // When a password is supplied, write its ciphertext + masked suffix; when it
    // is omitted, leave the stored secret untouched (the upsert simply does not
    // touch those columns on update; on create there is simply no password yet).
    const secretFields = settingPassword
      ? { passCiphertext, passLast4 }
      : {};

    const saved = (await this.prisma.smtpConfig.upsert({
      where: { id: SMTP_CONFIG_ROW_ID },
      create: {
        id: SMTP_CONFIG_ROW_ID,
        ...nonSecret,
        passCiphertext: settingPassword ? passCiphertext ?? null : null,
        passLast4: settingPassword ? passLast4 ?? null : null,
      },
      update: { ...nonSecret, ...secretFields },
    })) as SmtpConfigRow;

    return {
      host: saved.host,
      port: saved.port,
      user: saved.user,
      from: saved.from,
      passLast4: saved.passLast4,
      hasPassword: typeof saved.passCiphertext === 'string' && saved.passCiphertext.length > 0,
    };
  }

  /**
   * Resolve the DB SMTP config for the mail path (design D3): the DECRYPTED
   * transport tuple, or null when there is no usable DB config (no row, an
   * incomplete row, no password stored, or the password fails to decrypt — e.g.
   * the key is missing/rotated). A null return is the signal to fall back to the
   * env, so the deployment never breaks regardless of the DB state.
   */
  async resolveDbSmtpConfig(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ResolvedDbSmtpConfig | null> {
    const row = await this.findRow();
    if (!row) {
      return null;
    }
    const host = nonEmpty(row.host);
    const user = nonEmpty(row.user);
    const from = nonEmpty(row.from);
    if (!host || !user || !from) {
      return null;
    }
    if (!Number.isInteger(row.port) || row.port <= 0 || row.port > 65535) {
      return null;
    }
    const pass = decryptStored(row.passCiphertext, env);
    if (!pass) {
      // No password stored, or it could not be decrypted (key missing/rotated).
      return null;
    }
    return { host, port: row.port, user, pass, from };
  }

  /** Read the singleton row, or null when none exists / no client is wired. */
  private async findRow(): Promise<SmtpConfigRow | null> {
    if (!this.prisma) {
      return null;
    }
    const row = (await this.prisma.smtpConfig.findUnique({
      where: { id: SMTP_CONFIG_ROW_ID },
    })) as SmtpConfigRow | null;
    return row;
  }
}

/**
 * Free-function DB-config resolver bound to a Prisma instance + env (integration
 * task 6.1, reconciling the backend-storage and backend-mail-capability tracks).
 *
 * `MailService` consumes the DB-first path through THIS function — `resolveDbSmtpConfig(prisma, env)`
 * — rather than via DI on {@link SmtpConfigService}, so the mailer needs NO
 * `mail.module.ts` provider edit beyond the global `PrismaService` it already
 * injects. It adapts the service method's {@link ResolvedDbSmtpConfig} into the
 * `MailService`-side `ResolvedSmtpConfig` shape by stamping `source: 'db'` (the
 * diagnostic discriminator the routing/gating functions read), so the two tracks'
 * resolution shapes line up. Returns `null` (the env-fallback signal) when there
 * is no usable DB config — no row, an incomplete row, no stored password, or a
 * password that fails to decrypt (key missing/rotated).
 *
 * The `ResolvedSmtpConfig` return type is imported TYPE-ONLY from `mail.service`
 * (erased at compile time) so there is no runtime import cycle even though
 * `mail.service` imports this function at runtime.
 */
export async function resolveDbSmtpConfig(
  prisma: PrismaService,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSmtpConfig | null> {
  const resolved = await new SmtpConfigService(prisma).resolveDbSmtpConfig(env);
  if (!resolved) {
    return null;
  }
  return { ...resolved, source: 'db' };
}

/** Returns a trimmed non-empty string, or `null` for unset/blank values. */
function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
