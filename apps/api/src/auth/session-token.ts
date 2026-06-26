/**
 * Opaque session-token + cookie primitives.
 *
 * All functions here are pure (crypto over their arguments; no env capture, no
 * I/O) so the verify phase can unit-test token minting, the store-only-the-HASH
 * property, expiry evaluation, and cookie serialisation/parsing in isolation.
 *
 * The opaque SESSION token is unguessable random bytes; the server persists
 *   only its SHA-256 HASH, so a database read can never recover a usable
 *   credential. The raw token is returned to the caller exactly once (to set the
 *   cookie) and never stored.
 */

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Opaque session token
// ---------------------------------------------------------------------------

/** Bytes of entropy in an opaque session token (256-bit). */
const SESSION_TOKEN_BYTES = 32;

/** A freshly minted session token: the raw secret (set once on the cookie) + its stored hash. */
export interface MintedSessionToken {
  /** The opaque, unguessable token handed to the client. NEVER persisted. */
  readonly token: string;
  /** SHA-256 hash of the token; this is the ONLY representation stored server-side. */
  readonly tokenHash: string;
}

/**
 * Mints a cryptographically-random opaque session token and its storage hash.
 * The caller sets `token` on the cookie and persists `tokenHash` only.
 */
export function mintSessionToken(): MintedSessionToken {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

/**
 * Hashes a presented session token into the value compared against the stored
 * `tokenHash`. A plain SHA-256 is sufficient because the input is high-entropy
 * random bytes (not a low-entropy password), so a slow KDF buys nothing.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * True when a session whose absolute expiry is `expiresAt` is expired relative to
 * `now`. Expiry is inclusive (`expiresAt <= now` is expired) so a session is not
 * accepted exactly at its boundary.
 */
export function isSessionExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Default session lifetime: 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Computes an absolute expiry `ttlMs` from `now`. */
export function sessionExpiryFrom(now: Date = new Date(), ttlMs: number = SESSION_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs);
}

// ---------------------------------------------------------------------------
// Cookie serialisation / parsing (node built-ins only — no cookie-parser dep)
// ---------------------------------------------------------------------------

/** Cookie name carrying the opaque session token. */
export const SESSION_COOKIE_NAME = 'cap_session';

export interface CookieOptions {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
  readonly path?: string;
  /**
   * Cookie `Domain` attribute. Omit (default) for a host-only cookie scoped to
   * the exact response host. Set to a registrable parent (e.g. `.example.com`)
   * so a cross-SUBDOMAIN deploy — web on `app.example.com`, api on
   * `api.example.com` — shares one session cookie across both the browser's
   * top-level requests AND the api's cross-origin reads. A leading dot is
   * optional in modern browsers (RFC 6265 treats `example.com` and
   * `.example.com` alike); we pass the value through verbatim.
   */
  readonly domain?: string;
  /** Max-Age in seconds. Use `0` to expire immediately (clear the cookie). */
  readonly maxAgeSeconds?: number;
}

/**
 * Serialises a `Set-Cookie` header value with the given attributes. Used for the
 * httpOnly session cookie; pure so the attribute string is verifiable in a test.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${value}`];
  segments.push(`Path=${options.path ?? '/'}`);
  if (options.domain) {
    segments.push(`Domain=${options.domain}`);
  }
  if (options.httpOnly) {
    segments.push('HttpOnly');
  }
  if (options.secure) {
    segments.push('Secure');
  }
  if (options.sameSite) {
    segments.push(`SameSite=${options.sameSite}`);
  }
  if (typeof options.maxAgeSeconds === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return segments.join('; ');
}

/**
 * Parses a raw `Cookie` request header into a name->value map. Returns the named
 * cookie's value, or `null` when the header is absent or the cookie missing.
 * Tolerant of surrounding whitespace; values are returned verbatim (the session
 * token is URL-safe, so no decoding is required).
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    if (key === name) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}
