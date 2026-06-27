import type { Request } from 'express';
import {
  isAutoSameHostWebOrigin,
  parseWebOrigins,
  readSessionCookieDomain,
  readWebOrigin,
} from './auth-config';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  serializeCookie,
} from './session-token';

/**
 * Builds the `Set-Cookie` directive(s) for a freshly-minted session.
 * Shared by EVERY local login method that mints a session — email+password and
 * email-OTP — so their cookies behave identically:
 *  - httpOnly + Secure when a true cross-host/cross-site browser deploy needs
 *    SameSite=None (browsers reject non-Secure None cookies);
 *  - SameSite=Lax for same-host installs, even when web/api use different ports
 *    (for example http://100.101.167.99:3000 -> http://100.101.167.99:8080);
 *  - domain-scoped when `SESSION_COOKIE_DOMAIN` is set (cross-subdomain deploy),
 *    with a host-only clear emitted first so a stale host-only cookie can't shadow
 *    the canonical one.
 *
 * Centralised here (rather than copied per controller) so the cookie discipline
 * is defined in ONE place and the login methods can never drift apart.
 */
export function buildSessionCookies(req: Request, token: string): string[] {
  const webOrigin = resolveCookieWebOrigin(req);
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
 * True when the configured web origin differs from the request hostname. Same
 * hostname but different port is still a same-host browser deploy: it needs CORS
 * because origins differ, but it does NOT need SameSite=None; Secure.
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
    return new URL(webOrigin).hostname !== requestHostname(reqHost);
  } catch {
    return true;
  }
}

function resolveCookieWebOrigin(req: Request): string | null {
  const origin = headerValue(req.headers.origin);
  const host = headerValue(req.headers.host) ?? undefined;
  if (origin) {
    if (parseWebOrigins(process.env.WEB_ORIGIN).includes(origin)) {
      return origin;
    }
    if (isAutoSameHostWebOrigin(origin, host)) {
      return origin;
    }
  }
  return readWebOrigin();
}

function requestHostname(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.split(':')[0] ?? host;
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
