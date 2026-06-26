import { Controller, Get, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthCapabilities, AuthSessionResponse } from '@cap/contracts';
import { AuthSessionService } from './auth-session.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveDbSmtpConfig } from '../mail/smtp-config.service';
import {
  isOtpAuthEnabled,
  isPasswordAuthEnabled,
  readSessionCookieDomain,
} from './auth-config';
import {
  SESSION_COOKIE_NAME,
  readCookie,
  serializeCookie,
} from './session-token';
import { isSecureRequest } from './session-cookie';

/**
 * Session HTTP surface shared by all console login methods.
 *
 * Password and OTP endpoints mint the session cookie; this controller exposes the
 * current-session read and logout operations. Self-hosted installs authenticate
 * with local accounts, while repository access is configured separately through
 * forge PAT credentials.
 */
@Controller('auth')
export class AuthSessionController {
  constructor(
    private readonly authSession: AuthSessionService,
    // Prisma is global, but injecting it here lets the capability computation
    // include DB-stored SMTP config when advertising OTP availability.
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Current session. Returns 200 `{ user, capabilities }` for an authenticated,
   * still-enabled user, or 401 with `{ error, capabilities }` when logged out so
   * the login page can still discover which local methods are available.
   */
  @Get('session')
  async session(@Req() req: Request, @Res() res: Response): Promise<void> {
    const capabilities = await this.authCapabilities();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const user = await this.authSession.resolveSession(token);
    if (user === null) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ error: 'Not authenticated.', capabilities });
      return;
    }
    const body: AuthSessionResponse = { user, capabilities };
    res.status(HttpStatus.OK).json(body);
  }

  /** Logout revokes the server-side session row and clears every cookie scope. */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    await this.authSession.revokeSession(token);

    const cookieDomain = readSessionCookieDomain() ?? undefined;
    const clears = [AuthSessionController.clearedSessionCookie(req, undefined)];
    if (cookieDomain) {
      clears.push(AuthSessionController.clearedSessionCookie(req, cookieDomain));
    }
    res.setHeader('Set-Cookie', clears);
    res.status(HttpStatus.NO_CONTENT).send();
  }

  private async authCapabilities(): Promise<AuthCapabilities> {
    return {
      passwordAuthEnabled: isPasswordAuthEnabled(),
      otpAuthEnabled: await isOtpAuthEnabled(() => resolveDbSmtpConfig(this.prisma)),
    };
  }

  private static clearedSessionCookie(
    req: Request,
    domain: string | undefined,
  ): string {
    return serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'Lax',
      path: '/',
      domain,
      maxAgeSeconds: 0,
    });
  }
}
