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
import { readOAuthAppConfig, readSessionSecret, readWebOrigin } from './oauth-config';
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

    // The web app may live on a DIFFERENT origin from the api (web on Vercel /
    // :3000, api on Fly/compose / :8080). Compute the configured web origin once;
    // it drives BOTH the redirect target (must be an absolute URL on the web
    // origin, not a relative path the browser would resolve against the api
    // origin) AND the session-cookie SameSite policy below. `null` => same-origin
    // self-host deploy, where relative paths + the default Lax cookie are correct.
    const webOrigin = readWebOrigin();

    if (session === null) {
      // Non-allowlisted identity: NO session, returned to the login gate as a
      // security denial.
      res.setHeader('Set-Cookie', clearStateCookie);
      res.redirect(HttpStatus.FOUND, GitHubOAuthController.loginGateUrl(webOrigin));
      return;
    }

    // --- allowlisted: set httpOnly session cookie with a cross-origin-aware policy ---
    //
    // The STATE cookie above stays SameSite=Lax: GitHub redirects back here via a
    // TOP-LEVEL navigation, on which the browser DOES send Lax cookies, so Lax is
    // the correct (tighter) choice for the one-shot state.
    //
    // The SESSION cookie is different: the FRONT-END reads it via a CROSS-ORIGIN
    // `fetch(..., { credentials: "include" })` (e.g. GET /auth/session), and the
    // browser does NOT attach a Lax cookie on cross-site sub-resource requests.
    // So when the deployment is cross-origin we must set SameSite=None; Secure
    // (the cross-site cookie contract — browsers require Secure for None). On
    // localhost http this is still accepted because browsers treat
    // http://localhost as a secure context. When same-origin (no WEB_ORIGIN) we
    // keep the tighter Lax + the observed-protocol Secure logic.
    const crossOrigin = GitHubOAuthController.isCrossOrigin(req, webOrigin);
    res.setHeader('Set-Cookie', [
      clearStateCookie,
      serializeCookie(SESSION_COOKIE_NAME, session.token, {
        httpOnly: true,
        secure: crossOrigin ? true : GitHubOAuthController.isSecureRequest(req),
        sameSite: crossOrigin ? 'None' : 'Lax',
        path: '/',
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      }),
    ]);
    res.redirect(HttpStatus.FOUND, GitHubOAuthController.postLoginUrl(webOrigin));
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

  /**
   * The post-login redirect target. When a web origin is configured (cross-origin
   * deploy) the browser is sent to the ABSOLUTE `${webOrigin}/repositories`,
   * because a relative `302 Location` would be resolved by the browser against
   * the CURRENT (api) origin and 404. With no web origin (same-origin self-host)
   * the relative path is correct and is kept.
   */
  private static postLoginUrl(webOrigin: string | null): string {
    return webOrigin === null
      ? GitHubOAuthController.POST_LOGIN_PATH
      : `${webOrigin}${GitHubOAuthController.POST_LOGIN_PATH}`;
  }

  /**
   * The allowlist-denial redirect target, mirroring {@link postLoginUrl}: the
   * absolute `${webOrigin}/login?denied=allowlist` cross-origin, else the relative
   * path same-origin. (The `?denied=allowlist` marker, not the origin, is what the
   * front-end gate reads.)
   */
  private static loginGateUrl(webOrigin: string | null): string {
    const path = `${GitHubOAuthController.LOGIN_GATE_PATH}?denied=allowlist`;
    return webOrigin === null ? path : `${webOrigin}${path}`;
  }

  /**
   * Whether this deployment is CROSS-ORIGIN for cookie purposes: a web origin is
   * configured AND it differs from the api's own request origin. When they are the
   * same origin (or no web origin is configured) the session cookie stays the
   * tighter `SameSite=Lax`; only a genuine cross-site front-end needs
   * `SameSite=None; Secure` to have its `credentials:"include"` fetches carry the
   * cookie. The api origin is derived from the observed protocol + `Host` header.
   */
  private static isCrossOrigin(req: Request, webOrigin: string | null): boolean {
    if (webOrigin === null) {
      return false;
    }
    const apiOrigin = GitHubOAuthController.apiOrigin(req);
    if (apiOrigin === null) {
      // No reliable Host: treat as cross-origin (fail toward the policy that lets
      // the configured cross-origin front-end work) rather than silently breaking
      // login for the deployment that bothered to set WEB_ORIGIN.
      return true;
    }
    return apiOrigin !== webOrigin;
  }

  /**
   * The api's own origin (`<scheme>://<host>`) as the browser saw it, derived from
   * the observed protocol (honouring `X-Forwarded-Proto`) and the `Host` header,
   * or `null` when no `Host` is present.
   */
  private static apiOrigin(req: Request): string | null {
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0) {
      return null;
    }
    const scheme = GitHubOAuthController.isSecureRequest(req) ? 'https' : 'http';
    return `${scheme}://${host}`;
  }
}
