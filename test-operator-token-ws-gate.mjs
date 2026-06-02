/**
 * Minimal ground-truth test:
 *   "Operator token gates WebSocket connections"
 *
 * The requirement (track 11.4 in terminal.gateway.ts):
 *   At connect time, every OPERATOR connection is authenticated against the
 *   configured AUTH_TOKEN, extracted from the URL ?token= query parameter or
 *   the `bearer.<token>` Sec-WebSocket-Protocol subprotocol.
 *   A missing, wrong, or TASK_TOKEN-shaped token causes the connection to be
 *   closed immediately (code 1008) before the client can join any task stream.
 *   A runner connection (?role=runner) skips this gate and is NOT closed here.
 *
 * The two units under test are:
 *   1. extractWsOperatorToken  (packages/contracts/src/auth.ts)
 *      — determines which token a client presented at handshake time.
 *   2. authenticateOperator / handleConnection gate
 *      (apps/api/src/terminal/terminal.gateway.ts lines 190-231)
 *      — inlined here as a pure function so the test is self-contained.
 *
 * No network, no NestJS, no database.
 */

import assert from 'node:assert/strict';
import { createHash, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. Inline extractWsOperatorToken  (mirrors contracts/src/auth.ts)
// ---------------------------------------------------------------------------

const WS_AUTH_SUBPROTOCOL_PREFIX = 'bearer.';

function extractWsOperatorToken({ queryToken, subprotocols = [] }) {
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }
  for (const proto of subprotocols) {
    if (proto.startsWith(WS_AUTH_SUBPROTOCOL_PREFIX)) {
      const token = proto.slice(WS_AUTH_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Inline constant-time comparison (mirrors apps/api/src/auth/constant-time.ts)
// ---------------------------------------------------------------------------

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeEqual(presented, configured) {
  return timingSafeEqual(digest(presented), digest(configured));
}

// ---------------------------------------------------------------------------
// 3. Inline the connect-time gate (mirrors terminal.gateway.ts lines 401-406
//    and the isRunner/handleConnection logic)
// ---------------------------------------------------------------------------

/**
 * Returns true iff the presented operator token matches the configured
 * AUTH_TOKEN in constant time. Mirrors authenticateOperator() exactly.
 * Fail-closed: rejects null tokens AND an unset/empty AUTH_TOKEN env var.
 */
function authenticateOperator(presented, AUTH_TOKEN) {
  if (presented === null) return false;
  if (AUTH_TOKEN === undefined || AUTH_TOKEN.length === 0) return false;
  return constantTimeEqual(presented, AUTH_TOKEN);
}

/**
 * Simulates handleConnection() for the scenario under test:
 *  - Parses `?role=runner` to decide kind.
 *  - For operators: extracts and validates the token; closes if invalid.
 *  - Returns { authenticated, kind, closed }.
 */
function simulateConnect({ url, subprotocols = [], AUTH_TOKEN }) {
  const parsed = (() => {
    try { return new URL(url, 'http://localhost'); } catch { return null; }
  })();

  const isRunner = parsed?.searchParams.get('role') === 'runner';
  const kind = isRunner ? 'runner' : 'operator';

  let closed = false;
  let authenticated = false;

  if (kind === 'operator') {
    const presented = extractWsOperatorToken({
      queryToken: parsed?.searchParams.get('token') ?? null,
      subprotocols,
    });
    if (!authenticateOperator(presented, AUTH_TOKEN)) {
      closed = true;   // closeUnauthenticated() called
    } else {
      authenticated = true;
    }
  }
  // Runners are NOT closed at connect time; they defer to first-frame handshake.

  return { kind, authenticated, closed };
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'super-secret-operator-token';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

console.log('\nTest: Operator token gates WebSocket connections\n');

// ── extractWsOperatorToken unit tests ────────────────────────────────────────

test('returns null when neither query param nor subprotocol is present', () => {
  const result = extractWsOperatorToken({ queryToken: null, subprotocols: [] });
  assert.equal(result, null);
});

test('extracts token from ?token= query param', () => {
  const result = extractWsOperatorToken({ queryToken: 'my-token', subprotocols: [] });
  assert.equal(result, 'my-token');
});

test('extracts token from bearer.<token> subprotocol', () => {
  const result = extractWsOperatorToken({
    queryToken: null,
    subprotocols: ['bearer.my-proto-token'],
  });
  assert.equal(result, 'my-proto-token');
});

test('prefers query param over subprotocol when both are present', () => {
  const result = extractWsOperatorToken({
    queryToken: 'query-wins',
    subprotocols: ['bearer.proto-token'],
  });
  assert.equal(result, 'query-wins');
});

test('ignores malformed subprotocol without bearer. prefix', () => {
  const result = extractWsOperatorToken({
    queryToken: null,
    subprotocols: ['notbearer.tok', 'bearer.'],  // second has empty suffix
  });
  assert.equal(result, null);
});

// ── authenticateOperator unit tests ──────────────────────────────────────────

test('authenticateOperator: null token → false (no token at all)', () => {
  assert.equal(authenticateOperator(null, AUTH_TOKEN), false);
});

test('authenticateOperator: correct token → true', () => {
  assert.equal(authenticateOperator(AUTH_TOKEN, AUTH_TOKEN), true);
});

test('authenticateOperator: wrong token → false', () => {
  assert.equal(authenticateOperator('wrong-token', AUTH_TOKEN), false);
});

test('authenticateOperator: empty AUTH_TOKEN env var → false (fail-closed)', () => {
  assert.equal(authenticateOperator(AUTH_TOKEN, ''), false);
});

test('authenticateOperator: unset AUTH_TOKEN (undefined) → false (fail-closed)', () => {
  assert.equal(authenticateOperator(AUTH_TOKEN, undefined), false);
});

// ── handleConnection gate integration tests ───────────────────────────────────

test('operator with valid ?token= is authenticated and NOT closed', () => {
  const { kind, authenticated, closed } = simulateConnect({
    url: `/terminal?token=${AUTH_TOKEN}`,
    AUTH_TOKEN,
  });
  assert.equal(kind, 'operator');
  assert.equal(authenticated, true);
  assert.equal(closed, false);
});

test('operator with valid bearer.<token> subprotocol is authenticated', () => {
  const { kind, authenticated, closed } = simulateConnect({
    url: '/terminal',
    subprotocols: [`bearer.${AUTH_TOKEN}`],
    AUTH_TOKEN,
  });
  assert.equal(kind, 'operator');
  assert.equal(authenticated, true);
  assert.equal(closed, false);
});

test('operator with NO token is closed immediately (unauthenticated)', () => {
  const { kind, authenticated, closed } = simulateConnect({
    url: '/terminal',
    subprotocols: [],
    AUTH_TOKEN,
  });
  assert.equal(kind, 'operator');
  assert.equal(authenticated, false);
  assert.equal(closed, true);
});

test('operator with WRONG token is closed immediately', () => {
  const { kind, authenticated, closed } = simulateConnect({
    url: '/terminal?token=totally-wrong',
    AUTH_TOKEN,
  });
  assert.equal(kind, 'operator');
  assert.equal(authenticated, false);
  assert.equal(closed, true);
});

test('operator with TASK_TOKEN-shaped value (non-matching) is closed', () => {
  // A TASK_TOKEN issued by the orchestrator is just a different secret;
  // it will not match AUTH_TOKEN and must be rejected.
  const taskToken = 'bm90LWFuLW9wZXJhdG9yLXRva2Vu_task_scoped';
  const { kind, closed } = simulateConnect({
    url: `/terminal?token=${taskToken}`,
    AUTH_TOKEN,
  });
  assert.equal(kind, 'operator');
  assert.equal(closed, true, 'TASK_TOKEN presented as operator token must be rejected');
});

test('runner connection (?role=runner) is NOT closed at connect time', () => {
  // Runners skip the operator gate entirely; their first frame is the dial-back
  // handshake (8.2).  They must not be closed at connect time even with no token.
  const { kind, authenticated, closed } = simulateConnect({
    url: '/terminal?role=runner',
    AUTH_TOKEN,
  });
  assert.equal(kind, 'runner');
  assert.equal(closed, false, 'runner must not be closed at connect time');
  assert.equal(authenticated, false, 'runner is not authenticated at connect time');
});

test('unset AUTH_TOKEN env var causes every operator connection to be closed (fail-closed)', () => {
  const { closed } = simulateConnect({
    url: `/terminal?token=${AUTH_TOKEN}`,
    AUTH_TOKEN: undefined,   // misconfigured — no AUTH_TOKEN
  });
  assert.equal(closed, true, 'operator must be rejected when AUTH_TOKEN is unset');
});

test('empty AUTH_TOKEN env var causes every operator connection to be closed (fail-closed)', () => {
  const { closed } = simulateConnect({
    url: `/terminal?token=${AUTH_TOKEN}`,
    AUTH_TOKEN: '',
  });
  assert.equal(closed, true, 'operator must be rejected when AUTH_TOKEN is empty');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
