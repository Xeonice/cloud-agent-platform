import {
  Controller,
  Get,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthSessionResponse, SessionUser } from '@cap/contracts';
import { GitHubOAuthService } from './github-oauth.service';
import { AuthSessionService } from './auth-session.service';
import { readOAuthAppConfig, readSessionSecret } from './oauth-config';
import {
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  readCookie,
  serializeCookie,
  signState,
  statesMatch,
  verifyStateSignature,
} from './session-token';

/**
 * GitHub OAuth identity + session HTTP surface (be-oauth-allowlist, tasks
 * 2.2–2.5).
 *
 *   - `GET  /auth/github/login`    -> 302 to GitHub authorize (anti-CSRF state set).
 *   - `GET  /auth/github/callback` -> verify state, exchange code, gate on
 *                                     allowlist, mint session + cookie, redirect.
 *   - `GET  /auth/session`         -> 200 `{ user }` or 401 when unauthenticated.
 *   - `POST /auth/logout`          -> invalidate server-side + clear cookie.
 *
 * The flow FAILS CLOSED when its credentials/secret are unset (see
 * {@link readOAuthAppConfig} / {@link readSessionSecret}); it never falls back to
 * an unauthenticated or shared-token login. The OAuth `client_secret` and the raw
 * GitHub access token are confined to the server and never reach the browser.
 *
 * These routes are exempt from the operator-token guard (see `AuthGuard`) because
 * they are the entry points that ESTABLISH operator identity; the future session
 * guard (task 2.6) protects the rest of the REST surface.
 */
@Controller('auth')
export class GitHubOAuthController {
  /** Where the browser lands after the callback resolves (front-end gate routes from here). */
  private static readonly LOGIN_GATE_PATH = '/login';
  private static readonly POST_LOGIN_PATH = '/repositories';

  constructor(
    private readonly githubOAuth: GitHubOAuthService,
    private readonly authSession: AuthSessionService,
  ) {}

  /**
   * 2.2 — Initiate the authorization-code flow. Generates a signed anti-CSRF
   * `state`, persists it in a short-lived cookie, and 302-redirects to GitHub's
   * authorize URL. FAILS CLOSED with 500 when OAuth credentials or the session
   * secret are unset (never a fall-back login).
   */
  @Get('github/login')
  login(@Req() req: Request, @Res() res: Response): void {
    const config = readOAuthAppConfig();
    const secret = readSessionSecret();
    if (config === null || secret === null) {
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({
          error:
            'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID, ' +
            'GITHUB_CLIENT_SECRET and SESSION_SECRET to enable login. The flow ' +
            'fails closed rather than serving an unauthenticated or shared-token login.',
        });
      return;
    }

    const state = signState(secret);
    // Short-lived (10 min), httpOnly, SameSite=Lax so it survives GitHub's
    // top-level redirect back. Secure unless explicitly on http (local dev).
    res.setHeader(
      'Set-Cookie',
      serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
        httpOnly: true,
        secure: GitHubOAuthController.isSecureRequest(req),
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 600,
      }),
    );

    res.redirect(HttpStatus.FOUND, this.githubOAuth.buildAuthorizeUrl(config, state));
  }

  /**
   * 2.3–2.5 — Handle GitHub's redirect back. Verifies `state` (rejecting
   * mismatched/missing WITHOUT exchanging the code), exchanges code→token
   * server-side, fetches the GitHub identity, runs the allowlist gate, and on
   * admit upserts the user, mints a session, and sets the session cookie before
   * redirecting into the app. A non-allowlisted identity is returned to the login
   * gate with a denial marker (security denial, not a recoverable form error).
   */
  @Get('github/callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const config = readOAuthAppConfig();
    const secret = readSessionSecret();
    if (config === null || secret === null) {
      res
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'GitHub OAuth is not configured; the flow fails closed.' });
      return;
    }

    // --- anti-CSRF state verification BEFORE any code exchange ---
    const cookieState = readCookie(req.headers.cookie, OAUTH_STATE_COOKIE_NAME);
    // Always clear the one-shot state cookie.
    const clearStateCookie = serializeCookie(OAUTH_STATE_COOKIE_NAME, '', {
      httpOnly: true,
      secure: GitHubOAuthController.isSecureRequest(req),
      sameSite: 'Lax',
      path: '/',
      maxAgeSeconds: 0,
    });

    if (
      typeof state !== 'string' ||
      !verifyStateSignature(state, secret) ||
      !statesMatch(cookieState, state)
    ) {
      // Reject WITHOUT exchanging the code. No session established.
      res.setHeader('Set-Cookie', clearStateCookie);
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid or missing OAuth state; authorization rejected.' });
      return;
    }

    if (typeof code !== 'string' || code.length === 0) {
      res.setHeader('Set-Cookie', clearStateCookie);
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Missing authorization code.' });
      return;
    }

    // --- server-side code → token exchange + identity fetch ---
    let session: { token: string; user: SessionUser } | null;
    try {
      const accessToken = await this.githubOAuth.exchangeCodeForToken(config, code);
      const githubUser = await this.githubOAuth.fetchUser(accessToken);
      // --- single session-mint point: allowlist gate + gated upsert ---
      session = await this.authSession.establishSessionForGitHubUser(githubUser, accessToken);
    } catch {
      res.setHeader('Set-Cookie', clearStateCookie);
      res
        .status(HttpStatus.BAD_GATEWAY)
        .json({ error: 'GitHub authentication failed.' });
      return;
    }

    if (session === null) {
      // Non-allowlisted identity: NO session, returned to the login gate as a
      // security denial.
      res.setHeader('Set-Cookie', clearStateCookie);
      res.redirect(HttpStatus.FOUND, `${GitHubOAuthController.LOGIN_GATE_PATH}?denied=allowlist`);
      return;
    }

    // --- allowlisted: set httpOnly + Secure + SameSite=Lax session cookie ---
    res.setHeader('Set-Cookie', [
      clearStateCookie,
      serializeCookie(SESSION_COOKIE_NAME, session.token, {
        httpOnly: true,
        secure: GitHubOAuthController.isSecureRequest(req),
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      }),
    ]);
    res.redirect(HttpStatus.FOUND, GitHubOAuthController.POST_LOGIN_PATH);
  }

  /**
   * 2.5 — Current session. 200 `{ user }` for a valid, non-expired session that
   * resolves to a still-allowlisted user; 401 otherwise (no `user: null` body —
   * an unauthenticated caller is rejected outright per the task's "current
   * SessionUser or 401").
   */
  @Get('session')
  async session(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const user = await this.authSession.resolveSession(token);
    if (user === null) {
      res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Not authenticated.' });
      return;
    }
    const body: AuthSessionResponse = { user };
    res.status(HttpStatus.OK).json(body);
  }

  /**
   * 2.5 — Logout. Invalidates the session server-side (so a stolen-but-logged-out
   * token cannot be replayed) and clears the cookie. Idempotent and always 204.
   */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    await this.authSession.revokeSession(token);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        secure: GitHubOAuthController.isSecureRequest(req),
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 0,
      }),
    );
    res.status(HttpStatus.NO_CONTENT).send();
  }

  /**
   * Whether to mark cookies `Secure`. True unless the request arrived over plain
   * http (local dev), as inferred from the protocol / `X-Forwarded-Proto`. A
   * `Secure` cookie is dropped by browsers over http, which would break local
   * testing, so we only relax it for an observed http origin.
   */
  private static isSecureRequest(req: Request): boolean {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto =
      (typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : undefined) ??
      req.protocol;
    return proto !== 'http';
  }
}
