import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmtpConfigService } from './smtp-config.service';
import { SmtpController } from './smtp.controller';

/**
 * Outbound-mail feature module.
 *
 * Wraps {@link MailService} — the single SMTP path over `nodemailer` — and EXPORTS
 * it so the email-OTP module can both send the verification code and read the
 * `isConfigured()` capability to gate the OTP login method (fail closed when SMTP
 * is unset). `MailService` resolves its config DB-first/env-fallback; the
 * `PrismaService` it injects comes from the `@Global` `PrismaModule`, so no extra
 * provider wiring is required here for it.
 *
 * INTEGRATION (add-smtp-config-ui, task 6.1) — this module is the SINGLE writer of
 * the shared module graph for the SMTP-config feature. It is the only file the
 * parallel apply tracks both needed to touch, so it is edited exactly once, last:
 *  - {@link SmtpConfigService} (backend-storage, task 2.2) is registered as a
 *    PROVIDER and EXPORTED. The admin {@link SmtpController} injects it, and
 *    exporting it lets any other module that imports `MailModule` reuse the one
 *    config service. (The boot-seed `SmtpEnvMigrationModule` deliberately provides
 *    its OWN copy to stay self-contained, so it does not depend on this export.)
 *  - {@link SmtpController} (backend-api, task 4.1) is registered as a CONTROLLER,
 *    mounting the admin-gated `GET/PUT /settings/smtp` + `POST /settings/smtp/test`
 *    surface. It injects {@link SmtpConfigService} (above) and the global
 *    `PrismaService` (its admin gate), both of which resolve here.
 *
 * Module registration in `app.module.ts` (mounting `MailModule` + the separate
 * `SmtpEnvMigrationModule`) is owned by the backend-storage track's `app.module.ts`
 * edit (task 2.3); this file owns only the mail-feature provider/controller graph.
 */
@Module({
  controllers: [SmtpController],
  providers: [MailService, SmtpConfigService],
  exports: [MailService, SmtpConfigService],
})
export class MailModule {}
