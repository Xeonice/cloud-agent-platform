/**
 * Minimal test for requirement:
 *   "Single configured operator token with constant-time comparison"
 *
 * Requirement semantics (from constant-time.ts JSDoc):
 *   1. Matching token returns true.
 *   2. Wrong token returns false.
 *   3. Empty string presented against a non-empty configured token returns false.
 *   4. Tokens of different lengths still compare safely (no throw).
 *   5. Same value, different casing returns false (exact equality).
 *   6. Two distinct non-empty tokens that happen to share a prefix return false.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ---- inline the function (mirrors constant-time.ts, no transpile step needed) ----

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(presented, configured) {
  return timingSafeEqual(digest(presented), digest(configured));
}

// ---- assertion helpers ----

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertNoThrow(fn, label) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${label}  (unexpected throw: ${err.message})`);
    failed++;
  }
}

// ---- tests ----

console.log('\n=== Single operator token: constant-time comparison ===\n');

const TOKEN = 'super-secret-operator-token-xyz';

// T1: correct token is accepted
{
  const result = constantTimeEqual(TOKEN, TOKEN);
  assert(result === true, 'T1: correct token returns true');
}

// T2: wrong token is rejected
{
  const result = constantTimeEqual('wrong-token', TOKEN);
  assert(result === false, 'T2: wrong token returns false');
}

// T3: empty presented token is rejected (different length from non-empty configured)
{
  let result;
  assertNoThrow(() => { result = constantTimeEqual('', TOKEN); }, 'T3a: empty vs non-empty does not throw');
  assert(result === false, 'T3b: empty presented token returns false');
}

// T4: tokens of very different lengths do not throw (hash ensures equal-length buffers)
{
  const short = 'x';
  const long = 'a'.repeat(256);
  let r1, r2;
  assertNoThrow(() => { r1 = constantTimeEqual(short, long); }, 'T4a: short vs long does not throw');
  assertNoThrow(() => { r2 = constantTimeEqual(long, short); }, 'T4b: long vs short does not throw');
  assert(r1 === false, 'T4c: short vs long returns false');
  assert(r2 === false, 'T4d: long vs short returns false');
}

// T5: case-sensitive — same value in different case is rejected
{
  const upper = TOKEN.toUpperCase();
  const result = constantTimeEqual(upper, TOKEN);
  assert(result === false, 'T5: uppercase variant of configured token returns false');
}

// T6: tokens sharing a prefix are still rejected
{
  const prefixed = TOKEN + '-extra';
  const result = constantTimeEqual(prefixed, TOKEN);
  assert(result === false, 'T6: token with extra suffix returns false');
}

// T7: single-char token round-trip
{
  const tiny = 'a';
  assert(constantTimeEqual(tiny, tiny) === true, 'T7a: single-char token matches itself');
  assert(constantTimeEqual(tiny, 'b') === false, 'T7b: single-char token does not match different char');
}

// ---- summary ----

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
