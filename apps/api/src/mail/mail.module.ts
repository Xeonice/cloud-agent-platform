import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Outbound-mail feature module (add-private-account-identity, task 5.1).
 *
 * Wraps {@link MailService} — the single SMTP path over `nodemailer` configured by
 * `SMTP_*` env — and EXPORTS it so the email-OTP module (task 5.2/5.3) can both
 * send the verification code and read the `isConfigured()` capability to gate the
 * OTP login method (fail closed when SMTP is unset).
 *
 * Module registration in `app.module.ts` is DEFERRED to the integration track
 * (task 10.1), which is the single writer of the module graph; keeping the wiring
 * out of here keeps this track file-disjoint from the other parallel tracks.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
