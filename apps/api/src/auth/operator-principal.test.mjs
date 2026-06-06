/**
 * Verify-phase test for operator-principal resolution
 * (be-oauth-allowlist, tasks 2.6 / 2.7 / 2.8).
 *
 * Requirement semantics (from operator-principal.ts):
 *   1. A valid, still-allowlisted SESSION admits as a `'session'` principal
 *      (the session resolver RE-CONFIRMS allowlist, so a de-allowlisted user
 *      whose resolver now returns null is denied — task 2.6).
 *   2. An expired/revoked/unknown session (resolver -> null) does NOT admit on
 *      the session domain.
 *   3. The legacy `AUTH_TOKEN` bearer admits ONLY when AUTH_TOKEN_LEGACY_ENABLED
 *      is on AND AUTH_TOKEN is configured AND the constant-time comparison
 *      matches (task 2.8); with the legacy path disabled (default) it is denied.
 *   4. A runner TASK_TOKEN presented as the operator bearer is just a
 *      non-matching AUTH_TOKEN and is denied — no special case (task 2.8).
 *   5. Session-first: a valid session is authoritative; a non-resolving session
 *      still falls through to the gated legacy bearer (unifying REST + WS).
 *   6. Nothing presented / nothing matches -> fail closed (null).
 *
 * Logic is inlined (mirrors operator-principal.ts + the constant-time + legacy
 * helpers it composes) so the test runs under plain `node` with no transpile.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ---- inline (mirrors constant-time.ts) ----

function constantTimeEqual(presented, configured) {
  const da = createHash('sha256').update(presented, 'utf8').digest();
  const db = createHash('sha256').update(configured, 'utf8').digest();
  return timingSafeEqual(da, db);
}

// ---- inline (mirrors oauth-config.isLegacyTokenEnabled) ----

const ENV = { AUTH_TOKEN_LEGACY_ENABLED: 'AUTH_TOKEN_LEGACY_ENABLED', AUTH_TOKEN: 'AUTH_TOKEN' };

function isLegacyTokenEnabled(env) {
  const raw = env[ENV.AUTH_TOKEN_LEGACY_ENABLED];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

// ---- inline (mirrors operator-principal.resolveOperatorPrincipal) ----

async function resolveOperatorPrincipal(credentials, resolveSession, env) {
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolveSession(sessionToken);
    if (user !== null) {
      return { kind: 'session', user };
    }
  }
  const legacy = credentials.legacyBearerToken;
  if (typeof legacy === 'string' && legacy.length > 0 && isLegacyTokenEnabled(env)) {
    const configured = env[ENV.AUTH_TOKEN];
    if (typeof configured === 'string' && configured.length > 0) {
      if (constantTimeEqual(legacy, configured)) {
        return { kind: 'legacy-token', user: null };
      }
    }
  }
  return null;
}

// ---- helpers ----

const ALLOWED_USER = {
  githubId: 12345,
  login: 'op',
  name: 'Operator',
  avatarUrl: '',
  allowed: true,
};

/** A resolver that admits ONLY `liveToken`, returning null for everything else
 *  (models expired/revoked/unknown AND de-allowlisted: the real resolver returns
 *  null once the user falls off the allowlist). */
function resolverFor(liveToken) {
  return async (token) => (token === liveToken ? ALLOWED_USER : null);
}

const denyAll = async () => null;

// ---- harness ----

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const RUNNER_TASK_TOKEN = 'task-token-for-some-task-NOT-an-operator';
const OPERATOR_TOKEN = 'shared-operator-secret';

const run = async () => {
  console.log('\n=== Operator-principal resolution ===\n');

  // T1: valid still-allowlisted session admits as 'session'.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'live-session', legacyBearerToken: null },
      resolverFor('live-session'),
      {},
    );
    assert(p !== null && p.kind === 'session' && p.user.githubId === 12345,
      'T1: valid allowlisted session admits as session principal');
  }

  // T2: de-allowlisted / revoked / expired session (resolver -> null) denied.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'stale-session', legacyBearerToken: null },
      resolverFor('live-session'), // 'stale-session' resolves to null
      {},
    );
    assert(p === null, 'T2: non-resolving (revoked/expired/de-allowlisted) session denied');
  }

  // T3: legacy bearer admits when enabled + configured + matching.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'legacy-token' && p.user === null,
      'T3: legacy bearer admits when AUTH_TOKEN_LEGACY_ENABLED=true and matches');
  }

  // T4: legacy bearer DENIED when the legacy path is disabled (default false).
  {
    const pDefault = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN: OPERATOR_TOKEN }, // AUTH_TOKEN_LEGACY_ENABLED unset -> false
    );
    assert(pDefault === null, 'T4a: legacy bearer denied when AUTH_TOKEN_LEGACY_ENABLED unset (default false)');
    const pFalse = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'false', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(pFalse === null, 'T4b: legacy bearer denied when AUTH_TOKEN_LEGACY_ENABLED=false');
  }

  // T5: a runner TASK_TOKEN presented as the operator bearer is denied even when
  //     the legacy path is enabled — it is simply a non-matching AUTH_TOKEN.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: RUNNER_TASK_TOKEN },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p === null, 'T5: runner TASK_TOKEN never authenticates an operator (no special case)');
  }

  // T6: legacy bearer denied when AUTH_TOKEN itself is unset/empty (fail-closed),
  //     even with the legacy path enabled.
  {
    const pUnset = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'true' }, // AUTH_TOKEN unset
    );
    assert(pUnset === null, 'T6a: legacy bearer denied when AUTH_TOKEN unset');
    const pEmpty = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: '' },
    );
    assert(pEmpty === null, 'T6b: legacy bearer denied when AUTH_TOKEN empty');
  }

  // T7: session-first — a valid session wins even if a (mismatching) legacy bearer
  //     is also present; the legacy comparison is not needed.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'live-session', legacyBearerToken: 'wrong-token' },
      resolverFor('live-session'),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'session', 'T7: valid session is authoritative (session-first)');
  }

  // T8: WS single-credential case — the SAME string presented as both session and
  //     legacy candidates: a valid AUTH_TOKEN is accepted via the legacy fallback
  //     even though it is (correctly) rejected as a session token.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: OPERATOR_TOKEN, legacyBearerToken: OPERATOR_TOKEN },
      denyAll, // not a session token
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'legacy-token',
      'T8: WS single-credential legacy AUTH_TOKEN accepted via fallback after session miss');
    // ...and the same WS credential is denied when the legacy path is off.
    const pOff = await resolveOperatorPrincipal(
      { sessionToken: OPERATOR_TOKEN, legacyBearerToken: OPERATOR_TOKEN },
      denyAll,
      { AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(pOff === null, 'T8b: same WS credential denied when legacy path disabled');
  }

  // T9: nothing presented -> fail closed.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, legacyBearerToken: null },
      denyAll,
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p === null, 'T9: no credentials -> fail closed');
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
