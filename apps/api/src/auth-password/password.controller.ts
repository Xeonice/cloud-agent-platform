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
  ChangePasswordRequestSchema,
  PasswordLoginRequestSchema,
  type AuthSessionResponse,
  type ChangePasswordRequest,
  type PasswordLoginRequest,
} from '@cap/contracts';
import { ZodValidationPipe } from '../repos/zod-validation.pipe';
import { buildSessionCookies } from '../auth/session-cookie';
import { readCookie, SESSION_COOKIE_NAME } from '../auth/session-token';
import { PasswordAuthService } from './password.service';

/**
 * Email + password login surface (add-private-account-identity, tasks 4.1 / 4.2),
 * mounted under `/auth`.
 *
 * Both routes are PUBLIC pre-auth members of the guard's `OAUTH_EXEMPT_PATHS`
 * (task 2.6) and sit behind the dedicated IP+email throttle tier (task 8.1) since
 * the principal throttler cannot key on an absent principal.
 *
 *  - `POST /auth/password` — resolve by email → verify argon2 → require `allowed`
 *    → mint the session cookie. EVERY rejection returns one UNIFORM 401 so neither
 *    account existence nor the failure reason leaks; it never auto-creates.
 *  - `POST /auth/change-password` — authenticated by the active session cookie
 *    (the forced first-login path: the operator just signed in with the temporary
 *    credential). Sets the new argon2 hash, clears `mustChangePassword`, and
 *    invalidates the prior credential. This route is reached WITH a session
 *    despite the guard's `mustChangePassword` chokepoint because it is exempt — it
 *    is the one action a must-change account is allowed to take.
 */
@Controller('auth')
export class PasswordController {
  constructor(private readonly passwordAuth: PasswordAuthService) {}

  /** `POST /auth/password` — exchange email+password for a session. */
  @Post('password')
  @UsePipes(new ZodValidationPipe(PasswordLoginRequestSchema))
  async login(
    @Body() body: PasswordLoginRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.passwordAuth.verifyAndMint(body.email, body.password);
    if (result === null) {
      // One uniform failure for unknown email / no password identity / wrong
      // password / disallowed account — discloses nothing.
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Invalid email or password.' });
      return;
    }
    res.setHeader('Set-Cookie', buildSessionCookies(req, result.token));
    const responseBody: AuthSessionResponse = { user: result.user };
    res.status(HttpStatus.OK).json(responseBody);
  }

  /** `POST /auth/change-password` — set a new password for the current session. */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ChangePasswordRequestSchema))
  async changePassword(
    @Body() body: ChangePasswordRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const user = await this.passwordAuth.changePassword(
      token,
      body.currentPassword,
      body.newPassword,
    );
    if (user === null) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ error: 'Could not change the password.' });
      return;
    }
    const responseBody: AuthSessionResponse = { user };
    res.status(HttpStatus.OK).json(responseBody);
  }
}
