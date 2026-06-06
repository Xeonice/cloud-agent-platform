/**
 * Opaque session-token + anti-CSRF-state + cookie primitives
 * (be-oauth-allowlist, tasks 2.2 / 2.5).
 *
 * All functions here are pure (crypto over their arguments; no env capture, no
 * I/O) so the verify phase can unit-test token minting, the store-only-the-HASH
 * property, expiry evaluation, signed-state round-tripping, and cookie
 * serialisation/parsing in isolation.
 *
 * Two distinct secrets-handling rules are enforced by construction:
 * - The opaque SESSION token is unguessable random bytes; the server persists
 *   only its SHA-256 HASH, so a database read can never recover a usable
 *   credential. The raw token is returned to the caller exactly once (to set the
 *   cookie) and never stored.
 * - The anti-CSRF STATE is HMAC-signed with `SESSION_SECRET` and carried in a
 *   cookie for the OAuth round trip; the signature is verified in constant time
 *   so a forged/tampered state cannot pass the callback check.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
// Anti-CSRF signed state
// ---------------------------------------------------------------------------

/** Bytes of entropy in the random nonce inside an anti-CSRF state value. */
const STATE_NONCE_BYTES = 16;

/**
 * Generates a signed anti-CSRF `state` of the form `<nonce>.<hmac>`, where the
 * HMAC is over the nonce keyed by `secret`. The signature lets the callback
 * confirm the state was minted by this server (defence-in-depth alongside the
 * persisted-cookie comparison) and was not tampered with.
 */
export function signState(secret: string): string {
  const nonce = randomBytes(STATE_NONCE_BYTES).toString('base64url');
  const sig = hmac(nonce, secret);
  return `${nonce}.${sig}`;
}

/**
 * Verifies that `state` is a well-formed `<nonce>.<hmac>` whose signature matches
 * `secret`, comparing the signature in constant time. Returns `false` for any
 * missing/malformed/tampered value — never throws — so a bad state is a quiet
 * rejection at the callback.
 */
export function verifyStateSignature(state: string | undefined | null, secret: string): boolean {
  if (typeof state !== 'string' || state.length === 0) {
    return false;
  }
  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) {
    return false;
  }
  const nonce = state.slice(0, dot);
  const presentedSig = state.slice(dot + 1);
  const expectedSig = hmac(nonce, secret);
  return constantTimeStringEqual(presentedSig, expectedSig);
}

/**
 * Constant-time check that the persisted state cookie equals the state returned
 * by GitHub. Both must be present and equal; comparison is timing-safe to avoid
 * leaking the persisted state byte-by-byte.
 */
export function statesMatch(
  cookieState: string | undefined | null,
  callbackState: string | undefined | null,
): boolean {
  if (typeof cookieState !== 'string' || cookieState.length === 0) {
    return false;
  }
  if (typeof callbackState !== 'string' || callbackState.length === 0) {
    return false;
  }
  return constantTimeStringEqual(cookieState, callbackState);
}

// ---------------------------------------------------------------------------
// Cookie serialisation / parsing (node built-ins only — no cookie-parser dep)
// ---------------------------------------------------------------------------

/** Cookie name carrying the opaque session token. */
export const SESSION_COOKIE_NAME = 'cap_session';
/** Cookie name carrying the signed anti-CSRF state for the OAuth round trip. */
export const OAUTH_STATE_COOKIE_NAME = 'cap_oauth_state';

export interface CookieOptions {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: 'Lax' | 'Strict' | 'None';
  readonly path?: string;
  /** Max-Age in seconds. Use `0` to expire immediately (clear the cookie). */
  readonly maxAgeSeconds?: number;
}

/**
 * Serialises a `Set-Cookie` header value with the given attributes. Used for the
 * httpOnly + Secure + SameSite=Lax session cookie and the short-lived state
 * cookie; pure so the attribute string is verifiable in a test.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${value}`];
  segments.push(`Path=${options.path ?? '/'}`);
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
 * token and signed state are URL-safe, so no decoding is required).
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

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function hmac(message: string, secret: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}

/**
 * Constant-time string equality. Hashes both inputs to a fixed-width digest so
 * `timingSafeEqual`'s equal-length precondition holds and no length/prefix timing
 * leaks (mirrors the operator-token comparison in `constant-time.ts`).
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
