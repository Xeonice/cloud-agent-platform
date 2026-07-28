import { isAutoSameHostWebOrigin, parseWebOrigins } from './auth-config';

/**
 * Which browser origins this deployment trusts to drive an authenticated,
 * state-changing request — the ONE computation, shared by the CORS delegate and
 * the request guard so the two can never disagree about what "the console" is.
 *
 * Why this is needed at all: in the cross-origin shape (console on one origin,
 * API on another) the session cookie is `SameSite=None`, which is exactly the
 * setting that lets a third-party page make the browser attach it. CORS does not
 * help — it governs whether a response may be READ, not whether a request is
 * SENT, and a state change needs no readable response.
 *
 * Trust has three sources, matching what the CORS delegate already composes:
 *   1. the request's OWN origin — a same-origin request is not cross-site by
 *      definition, and an unset `WEB_ORIGIN` *means* a same-origin deployment;
 *   2. the auto same-host origin, for self-host installs that put web and api on
 *      one hostname and different ports;
 *   3. the configured `WEB_ORIGIN` allow-list.
 */

/**
 * HTTP methods that cannot change state, and so are not subject to the origin
 * rule. What such a caller may READ is governed by response sharing (CORS),
 * which is a separate mechanism with its own configuration.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isStateChangingMethod(method: string | undefined): boolean {
  return !SAFE_METHODS.has((method ?? '').toUpperCase());
}

/** The `host` of an origin string (`scheme://host[:port]`), or null if unparseable. */
function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * True when `origin` is the request's own origin. Compared on host+port, which
 * is what distinguishes a site: a page on `https://api.example.com` calling its
 * own API is same-origin, and no third party can forge that header value.
 */
function isSameOrigin(origin: string, requestHost: string | undefined): boolean {
  if (!requestHost) return false;
  const host = originHost(origin);
  return host !== null && host === requestHost.trim();
}

/**
 * Whether this deployment trusts `origin` for a state-changing request.
 *
 * An absent or unparseable origin is NOT trusted: same-origin browsers send it
 * on unsafe methods, so treating absence as trusted would reopen the hole to any
 * client that simply omits the header.
 */
export function isTrustedRequestOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof origin !== 'string' || origin.trim().length === 0) {
    return false;
  }
  const candidate = origin.trim();
  if (originHost(candidate) === null) {
    return false;
  }
  if (isSameOrigin(candidate, requestHost)) {
    return true;
  }
  if (isAutoSameHostWebOrigin(candidate, requestHost, env)) {
    return true;
  }
  return parseWebOrigins(env.WEB_ORIGIN).includes(candidate);
}
