/**
 * Minimal test for requirement:
 *   "Operator token gates the REST API"
 *
 * Requirement semantics (from auth.guard.ts + auth.module.ts JSDoc):
 *   1. A request WITHOUT an Authorization header → 401 Unauthorized
 *   2. A request with a malformed Authorization (not "Bearer <token>") → 401
 *   3. A request with the wrong token → 401
 *   4. A request with the correct operator token → allowed through (guard returns true)
 *   5. The /health endpoint is EXEMPT from auth (liveness probes work without token)
 *   6. When AUTH_TOKEN env var is unset/empty → fail-closed (every request is 401)
 *   7. A TASK_TOKEN presented as operator token (non-matching value) is rejected with 401
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
 * Simulates canActivate: returns true (allowed) or throws an object with
 * status 401 and a message (rejected), matching the guard's behavior.
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

console.log('\n=== Operator token gates the REST API ===\n');

// T1: missing Authorization header → 401
assertThrows401(
  () => canActivate('/tasks', undefined, OPERATOR_TOKEN),
  'T1: No Authorization header → 401',
);

// T2: malformed Authorization (no "Bearer" scheme) → 401
assertThrows401(
  () => canActivate('/tasks', 'Basic dXNlcjpwYXNz', OPERATOR_TOKEN),
  'T2: Basic auth (wrong scheme) → 401',
);

// T3: Authorization header with no token after "Bearer" → 401
assertThrows401(
  () => canActivate('/tasks', 'Bearer', OPERATOR_TOKEN),
  'T3: "Bearer" with no token → 401',
);

// T4: wrong token → 401
assertThrows401(
  () => canActivate('/tasks', 'Bearer wrong-token', OPERATOR_TOKEN),
  'T4: Wrong token → 401',
);

// T5: correct token → allowed (returns true)
{
  let result;
  try {
    result = canActivate('/tasks', `Bearer ${OPERATOR_TOKEN}`, OPERATOR_TOKEN);
  } catch (err) {
    result = err;
  }
  assert(result === true, 'T5: Correct operator token → allowed through');
}

// T6: /health exempt from auth (no token needed)
{
  let result;
  try {
    result = canActivate('/health', undefined, OPERATOR_TOKEN);
  } catch (err) {
    result = err;
  }
  assert(result === true, 'T6: /health endpoint exempt from operator auth');
}

// T7: /health with trailing slash also exempt
{
  let result;
  try {
    result = canActivate('/health/', undefined, OPERATOR_TOKEN);
  } catch (err) {
    result = err;
  }
  assert(result === true, 'T7: /health/ (trailing slash) also exempt');
}

// T8: AUTH_TOKEN not configured → fail-closed (401 even with any token presented)
assertThrows401(
  () => canActivate('/tasks', 'Bearer some-token', undefined),
  'T8: AUTH_TOKEN unset → fail-closed, 401 even with presented token',
);

// T8b: AUTH_TOKEN empty string → fail-closed
assertThrows401(
  () => canActivate('/tasks', 'Bearer some-token', ''),
  'T8b: AUTH_TOKEN empty string → fail-closed, 401',
);

// T9: TASK_TOKEN presented as operator token → rejected (non-matching value)
{
  const taskToken = 'task-token-for-sandbox-dialback';
  assertThrows401(
    () => canActivate('/tasks', `Bearer ${taskToken}`, OPERATOR_TOKEN),
    'T9: TASK_TOKEN presented as operator token → 401 (distinct trust domain)',
  );
}

// T10: correct token on a non-health REST path (POST /repos/:id/tasks)
{
  let result;
  try {
    result = canActivate('/repos/123/tasks', `Bearer ${OPERATOR_TOKEN}`, OPERATOR_TOKEN);
  } catch (err) {
    result = err;
  }
  assert(result === true, 'T10: Correct token on POST /repos/:id/tasks → allowed');
}

// T11: Authorization header with extra segments (e.g. "Bearer tok extra") → 401
assertThrows401(
  () => canActivate('/tasks', `Bearer ${OPERATOR_TOKEN} extra`, OPERATOR_TOKEN),
  'T11: Authorization header with extra segments → 401',
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
