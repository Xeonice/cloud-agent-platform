import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isEncryptionKeyConfigured } from '../settings/secret-storage';
import { resolveSmtpConfig } from './mail.service';
import { SmtpConfigService } from './smtp-config.service';

/**
 * One-time env→DB SMTP migration boot seed (add-smtp-config-ui, track
 * backend-storage — task 2.3; spec `smtp-configuration`, "One-time migration of
 * env SMTP config to the DB on boot").
 *
 * A deployment already running with env `SMTP_*` should see that config surface
 * in the console without a manual re-entry. On boot, when ALL of the following
 * hold, this seed copies the env values into the singleton DB config (encrypting
 * the password) and stamps the marker `SystemSettings.smtpEnvMigratedAt`:
 *   - no DB SMTP config exists ({@link SmtpConfigService.resolveDbSmtpConfig} is
 *     null), AND
 *   - the `SMTP_*` env is FULLY configured ({@link resolveSmtpConfig} non-null),
 *     AND
 *   - the marker is null (the migration has not yet run), AND
 *   - an encryption key is available (so the password can be born-encrypted).
 *
 * Idempotent + fail-closed (design D9, mirroring the admin-seed discipline):
 *   - NO KEY ⇒ skip (the env fallback continues to serve mail unchanged); the
 *     migration only makes the env config visible/editable, it is never required
 *     for correctness because resolution is already DB-first/env-fallback (D3).
 *   - MARKER SET ⇒ NEVER re-seed, so an admin who later edits or DELETES the DB
 *     config is not overwritten on a subsequent boot.
 *
 * Self-contained discipline: the whole concern lives behind THIS ONE service
 * with its OWN single boot hook ({@link onApplicationBootstrap}) in its OWN
 * module — deliberately NOT spread across other providers' bootstrap hooks. That
 * is load-bearing: a prior production outage was caused by a cross-provider
 * bootstrap whose ordering was not guaranteed between independent
 * `onApplicationBootstrap` participants. The hook NEVER throws into boot — a
 * migration failure is logged and swallowed.
 */

/** The fixed singleton id of the shared `SystemSettings` row (mirrors settings). */
export const SYSTEM_SETTINGS_ROW_ID = 'system';

@Injectable()
export class SmtpEnvMigrationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmtpEnvMigrationService.name);

  constructor(
    private readonly smtpConfig: SmtpConfigService,
    /**
     * Prisma client. Optional so a unit context can construct the service
     * without a database (the migration then no-ops); the boot path degrades to
     * a warning rather than crashing bootstrap on a missing client.
     */
    @Optional()
    private readonly prisma?: PrismaService,
  ) {}

  /**
   * The ONE order-independent boot path for the env→DB migration (design D9). It
   * NEVER throws into bootstrap: a failure is logged and swallowed so a single
   * misconfiguration cannot crash the whole API process.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.migrate();
    } catch (err) {
      this.logger.error(
        `SMTP env→DB migration failed (continuing boot): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Idempotently seed the env SMTP config into the DB AT MOST ONCE. Re-runnable
   * on every boot; the guards below make it a no-op after the first successful
   * run (or whenever a precondition is unmet).
   */
  async migrate(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!this.prisma) {
      this.logger.warn('SMTP env→DB migration skipped: no prisma client wired');
      return;
    }

    // Marker already set ⇒ NEVER re-seed (an admin may have since edited/deleted
    // the DB config; do not clobber it).
    if (await this.alreadyMigrated()) {
      return;
    }

    // No key ⇒ skip fail-closed (the env fallback keeps serving mail unchanged).
    if (!isEncryptionKeyConfigured(env)) {
      this.logger.warn(
        'SMTP env→DB migration skipped: no encryption key (CODEX_CRED_ENC_KEY) — ' +
          'env fallback remains in effect',
      );
      return;
    }

    // A DB config already exists ⇒ nothing to migrate (resolution is DB-first).
    const existing = await this.smtpConfig.resolveDbSmtpConfig(env);
    if (existing) {
      return;
    }

    // The env must be FULLY configured for there to be anything to migrate.
    const envConfig = resolveSmtpConfig(env);
    if (!envConfig) {
      return;
    }

    // Seed the env values into the DB (the password is born-encrypted by the
    // config service) and stamp the marker so this never runs again.
    await this.smtpConfig.saveConfig(
      {
        host: envConfig.host,
        port: envConfig.port,
        user: envConfig.user,
        from: envConfig.from,
        pass: envConfig.pass,
      },
      env,
    );
    await this.stampMigrated();
    this.logger.log('migrated env SMTP config into the DB (one-time) and stamped the marker');
  }

  /**
   * Whether the one-time migration has already run (persisted marker). A missing
   * `SystemSettings` row means "never migrated" (fresh deploy).
   */
  private async alreadyMigrated(): Promise<boolean> {
    const row = await this.prisma!.systemSettings.findUnique({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      select: { smtpEnvMigratedAt: true },
    });
    return row?.smtpEnvMigratedAt != null;
  }

  /**
   * Stamp the migration marker so the seed runs AT MOST ONCE. Upserts the
   * singleton `SystemSettings` row (it may not exist yet on a fresh deploy); the
   * `create` supplies the row's other required defaults.
   */
  private async stampMigrated(): Promise<void> {
    const now = new Date();
    await this.prisma!.systemSettings.upsert({
      where: { id: SYSTEM_SETTINGS_ROW_ID },
      create: { id: SYSTEM_SETTINGS_ROW_ID, maxConcurrentTasks: 5, smtpEnvMigratedAt: now },
      update: { smtpEnvMigratedAt: now },
    });
  }
}
