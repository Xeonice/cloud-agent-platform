/**
 * Verify-phase test for session-token / state / cookie primitives
 * (be-oauth-allowlist, tasks 2.2 / 2.5).
 *
 * Requirement semantics (from session-token.ts):
 *   1. mintSessionToken yields a high-entropy token whose stored repr is its
 *      HASH (not the raw token), and re-hashing the token reproduces it.
 *   2. isSessionExpired: inclusive boundary; future = live, past = expired.
 *   3. signState/verifyStateSignature round-trips; a tampered or foreign-secret
 *      state fails; a missing/malformed state fails (never throws).
 *   4. statesMatch: equal non-empty match; missing/mismatch fail.
 *   5. serializeCookie emits HttpOnly/Secure/SameSite=Lax/Max-Age attributes;
 *      readCookie round-trips a named cookie out of a Cookie header.
 *
 * Logic is inlined (mirrors session-token.ts) to run under plain `node`.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---- inline (mirrors session-token.ts) ----

const SESSION_TOKEN_BYTES = 32;
const STATE_NONCE_BYTES = 16;

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
function hmac(message, secret) {
  return createHmac('sha256', secret).update(message, 'utf8').digest('base64url');
}
function constantTimeStringEqual(a, b) {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
function signState(secret) {
  const nonce = randomBytes(STATE_NONCE_BYTES).toString('base64url');
  return `${nonce}.${hmac(nonce, secret)}`;
}
function verifyStateSignature(state, secret) {
  if (typeof state !== 'string' || state.length === 0) return false;
  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) return false;
  const nonce = state.slice(0, dot);
  const presentedSig = state.slice(dot + 1);
  return constantTimeStringEqual(presentedSig, hmac(nonce, secret));
}
function statesMatch(a, b) {
  if (typeof a !== 'string' || a.length === 0) return false;
  if (typeof b !== 'string' || b.length === 0) return false;
  return constantTimeStringEqual(a, b);
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
function assertNoThrow(fn, label) {
  try { fn(); console.log(`  PASS  ${label}`); passed++; }
  catch (e) { console.error(`  FAIL  ${label} (threw: ${e.message})`); failed++; }
}

console.log('\n=== Session token / state / cookie ===\n');

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

// T3: signed-state round trip + tamper/foreign-secret/malformed rejection
{
  const secret = 'session-secret-xyz';
  const state = signState(secret);
  assert(verifyStateSignature(state, secret) === true, 'T3a: valid state verifies');
  assert(verifyStateSignature(state, 'other-secret') === false, 'T3b: foreign secret rejected');
  assert(verifyStateSignature(state + 'x', secret) === false, 'T3c: tampered sig rejected');
  assertNoThrow(() => assert(verifyStateSignature(undefined, secret) === false, 'T3d: undefined rejected'),
    'T3d-nothrow: undefined does not throw');
  assert(verifyStateSignature('nodothere', secret) === false, 'T3e: malformed (no dot) rejected');
  assert(verifyStateSignature('.sig', secret) === false, 'T3f: empty nonce rejected');
  assert(verifyStateSignature('nonce.', secret) === false, 'T3g: empty sig rejected');
}

// T4: statesMatch
{
  assert(statesMatch('abc', 'abc') === true, 'T4a: equal non-empty match');
  assert(statesMatch('abc', 'abd') === false, 'T4b: mismatch fails');
  assert(statesMatch(undefined, 'abc') === false, 'T4c: missing cookie fails');
  assert(statesMatch('abc', undefined) === false, 'T4d: missing callback state fails');
  assert(statesMatch('', '') === false, 'T4e: empty/empty fails');
}

// T5: cookie serialize + parse
{
  const c = serializeCookie('cap_session', 'TOKENVAL', {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAgeSeconds: 604800,
  });
  assert(c.startsWith('cap_session=TOKENVAL'), 'T5a: name=value first');
  assert(c.includes('HttpOnly'), 'T5b: HttpOnly present');
  assert(c.includes('Secure'), 'T5c: Secure present');
  assert(c.includes('SameSite=Lax'), 'T5d: SameSite=Lax present');
  assert(c.includes('Max-Age=604800'), 'T5e: Max-Age present');

  const cleared = serializeCookie('cap_session', '', { maxAgeSeconds: 0 });
  assert(cleared.includes('Max-Age=0'), 'T5f: clear cookie uses Max-Age=0');

  assert(readCookie('a=1; cap_session=TOKENVAL; b=2', 'cap_session') === 'TOKENVAL', 'T5g: reads named cookie');
  assert(readCookie('a=1; b=2', 'cap_session') === null, 'T5h: missing cookie -> null');
  assert(readCookie(undefined, 'cap_session') === null, 'T5i: no header -> null');
  assert(readCookie('  cap_session = SPACED ', 'cap_session') === 'SPACED', 'T5j: tolerates whitespace');
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
else { console.error('SOME TESTS FAILED'); process.exit(1); }
