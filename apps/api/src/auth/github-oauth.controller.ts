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
import type {
  AuthCapabilities,
  AuthSessionResponse,
  SessionUser,
} from '@cap/contracts';
import { GitHubOAuthService } from './github-oauth.service';
import { AuthSessionService } from './auth-session.service';
import {
  readOAuthAppConfig,
  readSessionSecret,
  readWebOrigin,
  readSessionCookieDomain,
  isPasswordAuthEnabled,
  isOtpAuthEnabled,
} from './oauth-config';
import {
  OAUTH_REDIRECT_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  readCookie,
  serializeCookie,
  signState,
  statesMatch,
  verifyStateSignature,
} from './session-token';
import { safeRedirectPath } from './redirect-target';

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
  /** Default post-login console target (auth-redirects-and-landing); a safe `redirect` overrides it. */
  private static readonly POST_LOGIN_PATH = '/dashboard';

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
  login(
    @Req() req: Request,
    @Res() res: Response,
    @Query('redirect') redirect?: string,
  ): void {
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
    const secure = GitHubOAuthController.isSecureRequest(req);
    // Short-lived (10 min), httpOnly, SameSite=Lax so they survive GitHub's
    // top-level redirect back. Secure unless explicitly on http (local dev).
    const cookies = [
      serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 600,
      }),
    ];
    // Carry an OPEN-REDIRECT-GUARDED deep-link target alongside (not inside) the
    // CSRF state, so the callback can return the operator to where the gate
    // bounced them from. Only set it when it passes `safeRedirectPath`; an unsafe
    // value is simply not carried (callback falls back to the default console).
    const safe = safeRedirectPath(redirect);
    if (safe !== null) {
      cookies.push(
        serializeCookie(OAUTH_REDIRECT_COOKIE_NAME, encodeURIComponent(safe), {
          httpOnly: true,
          secure,
          sameSite: 'Lax',
          path: '/',
          maxAgeSeconds: 600,
        }),
      );
    }
    res.setHeader('Set-Cookie', cookies);

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
    // Always clear the one-shot state + deep-link redirect cookies.
    const clearOneShot = (name: string): string =>
      serializeCookie(name, '', {
        httpOnly: true,
        secure: GitHubOAuthController.isSecureRequest(req),
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: 0,
      });
    const clearStateCookie = clearOneShot(OAUTH_STATE_COOKIE_NAME);
    const clearRedirectCookie = clearOneShot(OAUTH_REDIRECT_COOKIE_NAME);

    // Resolve the (open-redirect-guarded) deep-link target carried from /login,
    // re-validating at this trust boundary; falls back to the default console. The
    // decode is defensive (a tampered cookie could be malformed percent-encoding).
    const carriedRedirect = readCookie(req.headers.cookie, OAUTH_REDIRECT_COOKIE_NAME);
    let decodedRedirect: string | null = null;
    if (carriedRedirect !== null) {
      try {
        decodedRedirect = decodeURIComponent(carriedRedirect);
      } catch {
        decodedRedirect = null;
      }
    }
    const targetPath =
      safeRedirectPath(decodedRedirect) ?? GitHubOAuthController.POST_LOGIN_PATH;

    if (
      typeof state !== 'string' ||
      !verifyStateSignature(state, secret) ||
      !statesMatch(cookieState, state)
    ) {
      // Reject WITHOUT exchanging the code. No session established.
      res.setHeader('Set-Cookie', [clearStateCookie, clearRedirectCookie]);
      res
        .status(HttpStatus.BAD_REQUEST)
        .json({ error: 'Invalid or missing OAuth state; authorization rejected.' });
      return;
    }

    if (typeof code !== 'string' || code.length === 0) {
      res.setHeader('Set-Cookie', [clearStateCookie, clearRedirectCookie]);
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
      res.setHeader('Set-Cookie', [clearStateCookie, clearRedirectCookie]);
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
      res.setHeader('Set-Cookie', [clearStateCookie, clearRedirectCookie]);
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
    // A cross-SUBDOMAIN deploy (web `cap.douglasdong.com`, api
    // `cap-api.douglasdong.com`) sets SESSION_COOKIE_DOMAIN=.douglasdong.com so
    // the session cookie rides the browser's top-level requests to the web
    // origin too — letting the web app's SSR loader (which fetches the api
    // server-side) receive it. Unset (host-only) for same-origin / cross-site.
    const cookieDomain = readSessionCookieDomain() ?? undefined;
    // When the canonical cookie is DOMAIN-scoped (cross-subdomain deploy), also
    // emit a host-only clear FIRST: a stale host-only `cap_session` left by a
    // previous cookie-domain config would otherwise ride the browser's requests
    // to the api host ALONGSIDE the canonical cookie (two same-name cookies). The
    // server reads only the first occurrence, so a stale shadow makes every
    // browser->api call 401 even with a valid session. Clearing it here makes the
    // next login self-healing. (A host-only clear and a domain-scoped set target
    // different cookies, so they don't conflict.)
    const sessionCookies: string[] = [clearStateCookie, clearRedirectCookie];
    if (cookieDomain) {
      sessionCookies.push(GitHubOAuthController.clearedSessionCookie(req, undefined));
    }
    sessionCookies.push(
      serializeCookie(SESSION_COOKIE_NAME, session.token, {
        httpOnly: true,
        secure: crossOrigin ? true : GitHubOAuthController.isSecureRequest(req),
        sameSite: crossOrigin ? 'None' : 'Lax',
        path: '/',
        domain: cookieDomain,
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
      }),
    );
    res.setHeader('Set-Cookie', sessionCookies);
    res.redirect(HttpStatus.FOUND, GitHubOAuthController.postLoginUrl(webOrigin, targetPath));
  }

  /**
   * 2.5 — Current session. 200 `{ user, capabilities }` for a valid, non-expired
   * session that resolves to a still-`allowed` user; 401 otherwise (no
   * `user: null` body — an unauthenticated caller is rejected outright per the
   * task's "current SessionUser or 401").
   *
   * 2.8 / D11 — the response ALSO carries the auth `capabilities`
   * (`passwordAuthEnabled`, `otpAuthEnabled`) the frontend reads to decide which
   * login methods to render. The flags are surfaced on BOTH the 200 and the 401
   * body so the UNAUTHENTICATED login modal (which gets a 401) can still discover
   * the enabled methods without a separate round-trip.
   */
  @Get('session')
  async session(@Req() req: Request, @Res() res: Response): Promise<void> {
    const capabilities = GitHubOAuthController.authCapabilities();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    const user = await this.authSession.resolveSession(token);
    if (user === null) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ error: 'Not authenticated.', capabilities });
      return;
    }
    // `capabilities` rides on AuthSessionResponse (contract: optional) so the
    // login modal can read the enabled methods from the same payload.
    const body: AuthSessionResponse = { user, capabilities };
    res.status(HttpStatus.OK).json(body);
  }

  /**
   * The auth capability flags (2.8 / D11) the login modal reads:
   *   - `passwordAuthEnabled` — render the email+password method;
   *   - `otpAuthEnabled` — render the email-verification-code method (true only
   *     when SMTP is configured).
   * GitHub OAuth availability is reported separately by the existing
   * OAuth-config readiness; these two flags cover the NEW local methods.
   */
  private static authCapabilities(): AuthCapabilities {
    return {
      passwordAuthEnabled: isPasswordAuthEnabled(),
      otpAuthEnabled: isOtpAuthEnabled(),
      // GitHub OAuth is offerable only when the OAuth app credentials are
      // configured (otherwise the authorize endpoint fails closed); the login
      // modal hides the GitHub method when this is false.
      githubAuthEnabled: readOAuthAppConfig() !== null,
    };
  }

  /**
   * 2.5 — Logout. Invalidates the session server-side (so a stolen-but-logged-out
   * token cannot be replayed) and clears the cookie. Idempotent and always 204.
   */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
    await this.authSession.revokeSession(token);
    // Clear EVERY scope the session cookie could have been set under, or a stale
    // variant lingers and shadows future logins (duplicate same-name cookies =>
    // the api reads only the first => 401, and logout would leave a cookie
    // behind). Always clear the host-only variant; when a parent
    // SESSION_COOKIE_DOMAIN is configured, also clear that scope — a host-only
    // clear cannot match a domain-scoped cookie, and vice versa.
    const cookieDomain = readSessionCookieDomain() ?? undefined;
    const clears = [GitHubOAuthController.clearedSessionCookie(req, undefined)];
    if (cookieDomain) {
      clears.push(GitHubOAuthController.clearedSessionCookie(req, cookieDomain));
    }
    res.setHeader('Set-Cookie', clears);
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
   * A `Set-Cookie` directive that EXPIRES the session cookie for one scope
   * (`domain` undefined => the host-only variant; a value => that parent domain).
   * Browsers match a deletion on name+domain+path only, so this clears a cookie
   * regardless of its original SameSite/Secure. Used to purge stale shadow
   * cookies left by an earlier cookie-domain config, on both login and logout.
   */
  private static clearedSessionCookie(req: Request, domain: string | undefined): string {
    return serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: GitHubOAuthController.isSecureRequest(req),
      sameSite: 'Lax',
      path: '/',
      domain,
      maxAgeSeconds: 0,
    });
  }

  /**
   * The post-login redirect target for a resolved app path (default `/dashboard`,
   * or an open-redirect-guarded deep-link). When a web origin is configured
   * (cross-origin deploy) the browser is sent to the ABSOLUTE `${webOrigin}${path}`,
   * because a relative `302 Location` would be resolved by the browser against the
   * CURRENT (api) origin and 404. With no web origin (same-origin self-host) the
   * relative path is correct and is kept. `path` is always a guarded same-origin
   * relative path (`safeRedirectPath` / the `/dashboard` default), so concatenating
   * it onto `webOrigin` cannot escape the web origin.
   */
  private static postLoginUrl(webOrigin: string | null, path: string): string {
    return webOrigin === null ? path : `${webOrigin}${path}`;
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
