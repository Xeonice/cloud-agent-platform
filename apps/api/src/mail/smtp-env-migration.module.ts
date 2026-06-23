import { Module } from '@nestjs/common';
import { SmtpConfigService } from './smtp-config.service';
import { SmtpEnvMigrationService } from './smtp-env-migration.service';

/**
 * One-time env→DB SMTP migration module (add-smtp-config-ui, track
 * backend-storage, task 2.3).
 *
 * Bundles the self-contained env→DB migration boot seed:
 *  - {@link SmtpEnvMigrationService} — the ONE order-independent boot hook
 *    (design D9) that, on first boot with the env SMTP configured and no DB
 *    config, copies the env values into the singleton DB config (encrypting the
 *    password) and stamps `SystemSettings.smtpEnvMigratedAt` so it runs AT MOST
 *    ONCE. Fail-closed (no key ⇒ skip) and idempotent (marker set ⇒ never
 *    re-seed).
 *  - {@link SmtpConfigService} — provided HERE so the migration is fully
 *    self-contained: its single boot hook resolves all its dependencies inside
 *    its own module rather than reaching into `mail.module.ts` (whose provider
 *    wiring is the integration track's, task 6.1). `PrismaService` resolves from
 *    the `@Global` `PrismaModule`. This deliberately mirrors `AdminSeedModule`'s
 *    self-contained, single-boot-hook discipline.
 *
 * Registration in `app.module.ts` mirrors `AdminSeedModule` exactly (one
 * order-independent `onApplicationBootstrap` hook that never throws into boot).
 */
@Module({
  providers: [SmtpEnvMigrationService, SmtpConfigService],
  exports: [SmtpEnvMigrationService],
})
export class SmtpEnvMigrationModule {}
