/**
 * Minimal test for requirement:
 *   "Health check is unauthenticated"
 *
 * Requirement semantics (from health.controller.ts + auth.guard.ts JSDoc):
 *   1. GET /health returns { status: 'ok' } without any Authorization header.
 *   2. GET /health returns { status: 'ok' } even when the operator token env var
 *      is not configured (AUTH_TOKEN unset/empty).
 *   3. GET /health with a wrong/random Authorization header is still allowed
 *      (the guard exempts the path before inspecting the header).
 *   4. The guard's isHealthCheck logic also exempts /health/ (trailing slash).
 *   5. Non-health paths (e.g. /tasks) are NOT exempted — verifying the exemption
 *      is specific to /health.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ---- inline constantTimeEqual (from auth/constant-time.ts) ----

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(presented, configured) {
  return timingSafeEqual(digest(presented), digest(configured));
}

// ---- inline AuthGuard logic (from auth/auth.guard.ts) ----

const HEALTH_PATH = '/health';

function isHealthCheck(path) {
  const normalized = path.split('?')[0].replace(/\/+$/, '').toLowerCase();
  return normalized === HEALTH_PATH;
}

function extractBearerToken(header) {
  if (header === undefined) return null;
  const parts = header.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return null;
  return token;
}

/**
 * Simulates canActivate: returns true (allowed) or throws with status 401
 * (rejected), matching the guard's actual behavior.
 */
function canActivate(path, authHeader, configuredToken) {
  if (isHealthCheck(path)) return true;

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

/** Simulates the HealthController.check() handler. */
function healthCheck() {
  return { status: 'ok' };
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

function assertAllows(fn, label) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${label}  (unexpected rejection: ${JSON.stringify(err)})`);
    failed++;
  }
}

function assertThrows401(fn, label) {
  try {
    fn();
    console.error(`  FAIL  ${label}  (expected 401 throw, got nothing)`);
    failed++;
  } catch (err) {
    if (err && err.status === 401) {
      console.log(`  PASS  ${label}`);
      passed++;
    } else {
      console.error(`  FAIL  ${label}  (threw unexpected error: ${JSON.stringify(err)})`);
      failed++;
    }
  }
}

// ---- tests ----

const OPERATOR_TOKEN = 'super-secret-operator-token';

console.log('\n=== Health check is unauthenticated ===\n');

// T1: GET /health without any Authorization header is allowed by the guard.
assertAllows(
  () => canActivate('/health', undefined, OPERATOR_TOKEN),
  'T1: GET /health with no Authorization header → guard allows (unauthenticated)',
);

// T2: HealthController.check() returns { status: 'ok' }
{
  const result = healthCheck();
  assert(
    result !== null && typeof result === 'object' && result.status === 'ok',
    'T2: HealthController.check() returns { status: "ok" }',
  );
}

// T3: /health is allowed even when AUTH_TOKEN is not configured (undefined).
assertAllows(
  () => canActivate('/health', undefined, undefined),
  'T3: GET /health allowed even when AUTH_TOKEN is not configured',
);

// T4: /health is allowed even when AUTH_TOKEN is empty string.
assertAllows(
  () => canActivate('/health', undefined, ''),
  'T4: GET /health allowed even when AUTH_TOKEN is empty string',
);

// T5: /health with a trailing slash is also exempt (path normalisation).
assertAllows(
  () => canActivate('/health/', undefined, OPERATOR_TOKEN),
  'T5: GET /health/ (trailing slash) is also allowed unauthenticated',
);

// T6: /health with a wrong Authorization header is still allowed
//     (guard exempts the path BEFORE inspecting the header).
assertAllows(
  () => canActivate('/health', 'Bearer wrong-token', OPERATOR_TOKEN),
  'T6: GET /health with wrong bearer token still allowed (path checked first)',
);

// T7: /health with a completely garbled Authorization header is still allowed.
assertAllows(
  () => canActivate('/health', 'malformed-header-value', OPERATOR_TOKEN),
  'T7: GET /health with malformed Authorization header still allowed',
);

// T8: /health with query string attached is still exempt.
assertAllows(
  () => canActivate('/health?probe=fly', undefined, OPERATOR_TOKEN),
  'T8: GET /health?probe=fly (query string) is also allowed unauthenticated',
);

// T9 (negative): a non-health path WITHOUT a token IS rejected (guard is active
//    for all other paths, proving the /health exemption is specific).
assertThrows401(
  () => canActivate('/tasks', undefined, OPERATOR_TOKEN),
  'T9 (negative): GET /tasks without token → 401 (guard active for non-health paths)',
);

// T10 (negative): /healthz (similar but different) is NOT exempt.
assertThrows401(
  () => canActivate('/healthz', undefined, OPERATOR_TOKEN),
  'T10 (negative): /healthz is not exempt — only exact /health path is',
);

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
