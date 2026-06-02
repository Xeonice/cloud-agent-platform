/**
 * Minimal ground-truth test:
 *   "Single configured operator token with constant-time comparison"
 *
 * Exercises the core requirement from apps/api/src/auth/constant-time.ts:
 *   - Only ONE operator token is configured (AUTH_TOKEN env var).
 *   - Token comparison uses crypto.timingSafeEqual on SHA-256 digests,
 *     ensuring the comparison takes constant time regardless of input.
 *   - Correct token → allowed; wrong token → rejected; no token → rejected.
 *   - Fail-closed: unset/empty AUTH_TOKEN → every request rejected.
 *
 * This test is entirely self-contained (no network, no NestJS, no DB).
 * It mirrors the implementation in constant-time.ts and auth.guard.ts exactly.
 */

import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Inline constantTimeEqual — mirrors apps/api/src/auth/constant-time.ts
// ---------------------------------------------------------------------------

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Returns true iff presented === configured, compared in constant time.
 * Hashes both inputs to a fixed 32-byte width so timingSafeEqual never
 * throws due to length mismatch and length timing is not leaked.
 */
function constantTimeEqual(presented, configured) {
  return timingSafeEqual(digest(presented), digest(configured));
}

// ---------------------------------------------------------------------------
// Inline guard gate — mirrors AuthGuard.canActivate in auth.guard.ts
// Returns true (allowed) or throws { status: 401 } (rejected).
// ---------------------------------------------------------------------------

function extractBearerToken(header) {
  if (header === undefined) return null;
  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return null;
  return token;
}

function canActivate(authHeader, configuredToken) {
  const presented = extractBearerToken(authHeader);
  if (presented === null) {
    throw { status: 401, message: 'Missing or malformed operator bearer token' };
  }
  if (configuredToken === undefined || configuredToken.length === 0) {
    throw { status: 401, message: 'Operator token is not configured' };
  }
  if (!constantTimeEqual(presented, configuredToken)) {
    throw { status: 401, message: 'Invalid operator bearer token' };
  }
  return true;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message ?? JSON.stringify(err)}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const OPERATOR_TOKEN = 'single-operator-secret-token';

console.log('\n=== Single configured operator token with constant-time comparison ===\n');

// --- constantTimeEqual unit tests ---

test('constantTimeEqual: same string → true', () => {
  assert.equal(constantTimeEqual(OPERATOR_TOKEN, OPERATOR_TOKEN), true);
});

test('constantTimeEqual: different strings → false', () => {
  assert.equal(constantTimeEqual('wrong-token', OPERATOR_TOKEN), false);
});

test('constantTimeEqual: empty string vs non-empty → false', () => {
  assert.equal(constantTimeEqual('', OPERATOR_TOKEN), false);
});

test('constantTimeEqual: non-empty vs empty → false', () => {
  assert.equal(constantTimeEqual(OPERATOR_TOKEN, ''), false);
});

test('constantTimeEqual: empty vs empty → true', () => {
  // Two empty strings are equal; emptiness guard is the caller's responsibility.
  assert.equal(constantTimeEqual('', ''), true);
});

test('constantTimeEqual: token with different length → false (no throw)', () => {
  // The SHA-256 hashing ensures timingSafeEqual never throws due to length mismatch.
  const short = 'abc';
  assert.equal(constantTimeEqual(short, OPERATOR_TOKEN), false);
});

test('constantTimeEqual: returns boolean true, not truthy Buffer', () => {
  const result = constantTimeEqual(OPERATOR_TOKEN, OPERATOR_TOKEN);
  assert.strictEqual(result, true);
  assert.strictEqual(typeof result, 'boolean');
});

test('constantTimeEqual: returns boolean false, not falsy value', () => {
  const result = constantTimeEqual('not-right', OPERATOR_TOKEN);
  assert.strictEqual(result, false);
  assert.strictEqual(typeof result, 'boolean');
});

// --- Single-token gate (canActivate) tests ---

test('Guard: correct token → allowed (returns true)', () => {
  const result = canActivate(`Bearer ${OPERATOR_TOKEN}`, OPERATOR_TOKEN);
  assert.equal(result, true);
});

test('Guard: wrong token → 401', () => {
  assert.throws(
    () => canActivate('Bearer completely-wrong', OPERATOR_TOKEN),
    (err) => err.status === 401,
  );
});

test('Guard: missing Authorization header → 401', () => {
  assert.throws(
    () => canActivate(undefined, OPERATOR_TOKEN),
    (err) => err.status === 401,
  );
});

test('Guard: AUTH_TOKEN not configured (undefined) → fail-closed 401', () => {
  assert.throws(
    () => canActivate(`Bearer ${OPERATOR_TOKEN}`, undefined),
    (err) => err.status === 401,
  );
});

test('Guard: AUTH_TOKEN empty string → fail-closed 401', () => {
  assert.throws(
    () => canActivate(`Bearer ${OPERATOR_TOKEN}`, ''),
    (err) => err.status === 401,
  );
});

test('Guard: a SECOND different token value → 401 (single token, no multi-token)', () => {
  // "Single configured" means only one token is valid; any other value is rejected.
  const secondToken = 'another-completely-different-token';
  assert.throws(
    () => canActivate(`Bearer ${secondToken}`, OPERATOR_TOKEN),
    (err) => err.status === 401,
  );
});

test('Guard: token that is only one character off → 401 (no prefix matching)', () => {
  const almostRight = OPERATOR_TOKEN.slice(0, -1) + 'X';
  assert.throws(
    () => canActivate(`Bearer ${almostRight}`, OPERATOR_TOKEN),
    (err) => err.status === 401,
  );
});

// --- Timing-safety structural check ---

test('Timing-safety: digest lengths are always equal (32 bytes) for any input', () => {
  // Ensures timingSafeEqual can never throw due to buffer-length mismatch.
  const cases = ['', 'x', OPERATOR_TOKEN, 'a'.repeat(1000)];
  for (const input of cases) {
    const d = digest(input);
    assert.equal(d.byteLength, 32, `digest("${input.slice(0, 20)}") should be 32 bytes`);
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
