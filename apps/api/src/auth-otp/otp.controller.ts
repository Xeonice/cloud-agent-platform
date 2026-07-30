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
import {
  OtpRequestRequestSchema,
  OtpRequestResponseSchema,
  OtpVerifyRequestSchema,
  type AuthSessionResponse,
  type OtpRequestRequest,
  type OtpVerifyRequest,
} from '@cap-console/contracts';
import { ZodValidationPipe } from '@/http/zod-validation.pipe';
import { buildSessionCookies } from '@/auth/session-cookie';
import { EmailOtpService } from './email-otp.service';
import { MailService } from '@/mail/mail.service';

// The two request bodies used to be declared here as
// `{ email: z.string().min(1) }` and `{ email, code: z.string().min(1) }`, with a
// note that "the integration track may swap to the shared
// `@cap-console/contracts` schema (task 1.4)". This is that swap. The contract's
// versions are stricter in two ways and normalising in a third:
//
//   email  EmailSchema is `.trim().min(1).email(...)`, so a malformed address is
//          now a 400 rather than a silent no-op, and a stray leading/trailing
//          space is trimmed instead of failing the account lookup.
//   code   OtpCodeSchema is `/^\d{6}$/` against the previous `.min(1)`. The api
//          generates the code itself, so a real one always matched; only
//          garbage was ever accepted this far.
//
// Neither weakens the uniform-response property this surface depends on: a 400
// for a malformed address does not distinguish a known account from an unknown
// one, which is what "Request for an unknown email reveals nothing" protects.
// Used under the contract's own names: a local alias would be the private rename
// this package's spec forbids, and it would break the execution gate's ability to
// attribute the parse to the schema.

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
  @UsePipes(new ZodValidationPipe(OtpRequestRequestSchema))
  async request(@Body() body: OtpRequestRequest, @Res() res: Response): Promise<void> {
    if (!(await this.mail.isConfigured())) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'OTP login is not available.' });
      return;
    }
    await this.otp.requestCode(body.email);
    // Uniform, non-disclosing acknowledgement (same on success and unknown email),
    // parsed on the way out so the contract that declares it is executed rather
    // than merely written.
    res.status(HttpStatus.ACCEPTED).json(OtpRequestResponseSchema.parse({ ok: true }));
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
  @UsePipes(new ZodValidationPipe(OtpVerifyRequestSchema))
  async verify(
    @Body() body: OtpVerifyRequest,
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
