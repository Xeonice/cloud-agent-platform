import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UsePipes,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthSessionResponse } from '@cap/contracts';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { buildSessionCookies } from '../auth/session-cookie';
import { EmailOtpService } from './email-otp.service';
import { MailService } from '../mail/mail.service';

/**
 * Request body for `POST /auth/otp/request` — just the email a code is requested
 * for. Defined locally so the mail-otp track stays buildable in isolation; the
 * integration track may swap to the shared `@cap/contracts` schema (task 1.4).
 */
const OtpRequestSchema = z.object({ email: z.string().min(1) });
type OtpRequestBody = z.infer<typeof OtpRequestSchema>;

/** Request body for `POST /auth/otp/verify` — the email plus the presented code. */
const OtpVerifySchema = z.object({ email: z.string().min(1), code: z.string().min(1) });
type OtpVerifyBody = z.infer<typeof OtpVerifySchema>;

/**
 * Email verification-code (OTP) login surface (add-private-account-identity,
 * task 5.3), mounted under `/auth/otp`.
 *
 * Both routes are PUBLIC (pre-auth): they are exact-match members of the guard's
 * `PUBLIC_AUTH_PATHS` (added in task 2.6) so they reach these handlers without a
 * resolved principal, and they live behind the dedicated IP+email throttle tier
 * (task 8.1) since the principal throttler cannot key on an absent principal.
 *
 * Capability gate: OTP is only offered when SMTP is configured (the capability
 * flag, task 2.8). Both handlers consult {@link MailService.isConfigured} and
 * fail closed (404) when SMTP is unset, matching the console hiding the method.
 *
 * Non-disclosure: `request` ALWAYS returns the same 202 body regardless of
 * whether the email maps to an allowed account (spec "Request for an unknown
 * email reveals nothing"), and `verify` returns a single uniform 401 for every
 * failure (unknown email, wrong/expired/consumed code) so neither endpoint leaks
 * account existence.
 */
@Controller('auth/otp')
export class OtpController {
  constructor(
    private readonly otp: EmailOtpService,
    private readonly mail: MailService,
  ) {}

  /**
   * `POST /auth/otp/request` — issue a verification code.
   *
   * Returns 404 when SMTP is unconfigured (OTP unavailable, fail closed). When
   * configured, ALWAYS returns the same 202 body: the service issues a code only
   * for an allowed account with a stored email and silently no-ops otherwise, so
   * the response is identical on the success and unknown-email paths.
   */
  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  @UsePipes(new ZodValidationPipe(OtpRequestSchema))
  async request(@Body() body: OtpRequestBody, @Res() res: Response): Promise<void> {
    if (!(await this.mail.isConfigured())) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'OTP login is not available.' });
      return;
    }
    await this.otp.requestCode(body.email);
    // Uniform, non-disclosing acknowledgement (same on success and unknown email).
    res.status(HttpStatus.ACCEPTED).json({ ok: true });
  }

  /**
   * `POST /auth/otp/verify` — exchange a code for a session.
   *
   * 404 when SMTP is unconfigured. On a matching, unexpired, unconsumed code for
   * an allowed account: mints a session, sets the standard httpOnly session cookie
   * used by local login methods, and returns 200 `{ user }`. EVERY failure path returns a
   * single uniform 401 so nothing about the account or code state leaks.
   */
  @Post('verify')
  @UsePipes(new ZodValidationPipe(OtpVerifySchema))
  async verify(
    @Body() body: OtpVerifyBody,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!(await this.mail.isConfigured())) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'OTP login is not available.' });
      return;
    }

    const result = await this.otp.verifyCode(body.email, body.code);
    if (result === null) {
      // One uniform failure for unknown email / wrong / expired / consumed code.
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Invalid or expired code.' });
      return;
    }

    res.setHeader('Set-Cookie', buildSessionCookies(req, result.token));
    const responseBody: AuthSessionResponse = { user: result.user };
    res.status(HttpStatus.OK).json(responseBody);
  }
}
