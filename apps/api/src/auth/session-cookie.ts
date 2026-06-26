import type { Request } from 'express';
import { readSessionCookieDomain, readWebOrigin } from './auth-config';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  serializeCookie,
} from './session-token';

/**
 * Builds the `Set-Cookie` directive(s) for a freshly-minted session.
 * Shared by EVERY local login method that mints a session — email+password and
 * email-OTP — so their cookies behave identically:
 *  - httpOnly + Secure (Secure forced when cross-origin, where SameSite=None is
 *    required and browsers reject a non-Secure None cookie);
 *  - SameSite=None for a cross-origin deploy (the web app reads `/auth/session`
 *    cross-site), else the tighter Lax;
 *  - domain-scoped when `SESSION_COOKIE_DOMAIN` is set (cross-subdomain deploy),
 *    with a host-only clear emitted first so a stale host-only cookie can't shadow
 *    the canonical one.
 *
 * Centralised here (rather than copied per controller) so the cookie discipline
 * is defined in ONE place and the login methods can never drift apart.
 */
export function buildSessionCookies(req: Request, token: string): string[] {
  const webOrigin = readWebOrigin();
  const crossOrigin = isCrossOrigin(req, webOrigin);
  const cookieDomain = readSessionCookieDomain() ?? undefined;
  const secure = crossOrigin ? true : isSecureRequest(req);

  const cookies: string[] = [];
  if (cookieDomain) {
    // Clear any stale host-only cookie first so it can't shadow the canonical one.
    cookies.push(
      serializeCookie(SESSION_COOKIE_NAME, '', {
        httpOnly: true,
        secure,
        sameSite: crossOrigin ? 'None' : 'Lax',
        path: '/',
        maxAgeSeconds: 0,
      }),
    );
  }
  cookies.push(
    serializeCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure,
      sameSite: crossOrigin ? 'None' : 'Lax',
      path: '/',
      domain: cookieDomain,
      maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
    }),
  );
  return cookies;
}

/** True unless the request arrived over plain http (local dev), per protocol / forwarded-proto. */
export function isSecureRequest(req: Request): boolean {
  const forwarded = headerValue(req.headers['x-forwarded-proto']);
  const proto = (forwarded ?? req.protocol ?? '').split(',')[0]?.trim().toLowerCase();
  return proto === 'https';
}

/**
 * True when the configured web origin differs from the request's own origin host
 * (a cross-origin deploy), so the session cookie must be SameSite=None; Secure.
 */
export function isCrossOrigin(req: Request, webOrigin: string | null): boolean {
  if (!webOrigin) {
    return false;
  }
  const reqHost = headerValue(req.headers.host);
  if (!reqHost) {
    return true;
  }
  try {
    return new URL(webOrigin).host !== reqHost;
  } catch {
    return true;
  }
}

/** First value of a possibly-array header, trimmed; `null` when absent. */
function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? null;
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return null;
}
