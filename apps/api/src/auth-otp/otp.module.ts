import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { EmailOtpService } from './email-otp.service';
import { OtpController } from './otp.controller';

/**
 * Email verification-code (OTP) login module (add-private-account-identity,
 * tasks 5.2 / 5.3).
 *
 * Wires:
 *  - {@link OtpController} (`/auth/otp/request`, `/auth/otp/verify`) — public
 *    pre-auth endpoints (added to the guard's `OAUTH_EXEMPT_PATHS` in task 2.6);
 *  - {@link EmailOtpService} — issue/verify with hash-at-rest codes, TTL, resend
 *    cooldown, single-use, and attempt cap; mints a session on a valid code.
 *
 * Imports {@link MailModule} for the SMTP send path AND the `isConfigured()`
 * capability the controller gates on (OTP unavailable / fail closed when SMTP is
 * unset). Relies on the global `PrismaModule` for DB access.
 *
 * Registration in `app.module.ts` is DEFERRED to the integration track (task
 * 10.1), the single writer of the module graph, so this track stays file-disjoint
 * from the other parallel tracks.
 */
@Module({
  imports: [MailModule],
  controllers: [OtpController],
  providers: [EmailOtpService],
  exports: [EmailOtpService],
})
export class OtpModule {}
