/**
 * Verify-phase test for session-token / cookie primitives.
 *
 * Requirement semantics (from session-token.ts):
 *   1. mintSessionToken yields a high-entropy token whose stored repr is its
 *      HASH (not the raw token), and re-hashing the token reproduces it.
 *   2. isSessionExpired: inclusive boundary; future = live, past = expired.
 *   3. serializeCookie emits HttpOnly/Secure/SameSite=Lax/Max-Age attributes;
 *      readCookie round-trips a named cookie out of a Cookie header.
 *
 * Logic is inlined (mirrors session-token.ts) to run under plain `node`.
 */

import { createHash, randomBytes } from 'node:crypto';

// ---- inline (mirrors session-token.ts) ----

const SESSION_TOKEN_BYTES = 32;

function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function mintSessionToken() {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}
function isSessionExpired(expiresAt, now = new Date()) {
  return expiresAt.getTime() <= now.getTime();
}
function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${value}`];
  segments.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly) segments.push('HttpOnly');
  if (options.secure) segments.push('Secure');
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`);
  if (typeof options.maxAgeSeconds === 'number') {
    segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return segments.join('; ');
}
function readCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

// ---- harness ----

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}
console.log('\n=== Session token / cookie ===\n');

// T1: minted token is opaque, stored as hash, never equal to the raw token
{
  const a = mintSessionToken();
  const b = mintSessionToken();
  assert(a.token.length >= 40, 'T1a: token has high entropy');
  assert(a.token !== a.tokenHash, 'T1b: stored value is the HASH, not the raw token');
  assert(a.tokenHash === hashSessionToken(a.token), 'T1c: re-hash reproduces stored hash');
  assert(a.token !== b.token && a.tokenHash !== b.tokenHash, 'T1d: tokens are unguessable/unique');
}

// T2: expiry boundary inclusive
{
  const now = new Date('2026-06-05T00:00:00Z');
  assert(isSessionExpired(new Date(now.getTime() + 1000), now) === false, 'T2a: future not expired');
  assert(isSessionExpired(new Date(now.getTime() - 1000), now) === true, 'T2b: past expired');
  assert(isSessionExpired(new Date(now.getTime()), now) === true, 'T2c: exact boundary expired (inclusive)');
}

// T3: cookie serialize + parse
{
  const c = serializeCookie('cap_session', 'TOKENVAL', {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 604800,
  });
  assert(c.startsWith('cap_session=TOKENVAL'), 'T3a: name=value first');
  assert(c.includes('HttpOnly'), 'T3b: HttpOnly present');
  assert(c.includes('Secure'), 'T3c: Secure present');
  assert(c.includes('SameSite=Lax'), 'T3d: SameSite=Lax present');
  assert(c.includes('Max-Age=604800'), 'T3e: Max-Age present');

  const cleared = serializeCookie('cap_session', '', { maxAgeSeconds: 0 });
  assert(cleared.includes('Max-Age=0'), 'T3f: clear cookie uses Max-Age=0');

  assert(readCookie('a=1; cap_session=TOKENVAL; b=2', 'cap_session') === 'TOKENVAL', 'T3g: reads named cookie');
  assert(readCookie('a=1; b=2', 'cap_session') === null, 'T3h: missing cookie -> null');
  assert(readCookie(undefined, 'cap_session') === null, 'T3i: no header -> null');
  assert(readCookie('  cap_session = SPACED ', 'cap_session') === 'SPACED', 'T3j: tolerates whitespace');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
else { console.error('SOME TESTS FAILED'); process.exit(1); }
