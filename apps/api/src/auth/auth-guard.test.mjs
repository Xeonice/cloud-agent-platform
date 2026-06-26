/**
 * Verify-phase test for the operator session guard.
 *
 * Drives the REAL compiled AuthGuard (dist/auth/auth.guard.js) with a fake
 * AuthSessionService (a session resolver) and a fake Nest ExecutionContext built
 * around a plain request object, plus an explicit env via process.env mutation
 * around each gated-legacy assertion. It verifies the guard's composed admission
 * decision — the part that is NOT in any single pure helper:
 *
 *   1. A valid session (cap_session cookie) whose resolver returns a user is
 *      admitted and the principal is attached to the request.
 *   2. Missing/malformed credentials -> 401 (UnauthorizedException), fail-closed,
 *      NO state change (resolver may be consulted but no principal is attached).
 *   3. A disabled / expired / revoked session (resolver -> null) -> 401.
 *   4. The legacy AUTH_TOKEN bearer is admitted ONLY when AUTH_TOKEN_LEGACY_ENABLED
 *      is on (constant-time); rejected when the flag is unset/false.
 *   5. A runner TASK_TOKEN presented as the operator bearer never authenticates an
 *      operator (it is just a non-matching AUTH_TOKEN) — even with legacy enabled.
 *   6. The session/login entry points and /health are exempt (admitted without a
 *      principal) so an unauthenticated operator can reach login; an unknown
 *      protected path is NOT exempt.
 *
 * Requires `pnpm --filter @cap/api build` before running.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/auth');

const { AuthGuard } = require(path.join(DIST, 'auth.guard.js'));

// ---- fakes -----------------------------------------------------------------

const ALLOWED_USER = { githubId: 12345, login: 'op', name: 'Operator', avatarUrl: '', allowed: true };

/** Session service whose resolver admits ONLY `liveToken` (everything else -> null). */
function sessionServiceFor(liveToken) {
  return { resolveSession: async (token) => (token === liveToken ? ALLOWED_USER : null) };
}
const denyAllSessions = { resolveSession: async () => null };

/**
 * Build a fake Nest ExecutionContext around a plain Express-like request.
 * `path` defaults to a protected route; cookie/authorization headers are optional.
 */
function ctx({ path: reqPath = '/tasks', cookie, authorization } = {}) {
  const headers = {};
  if (cookie !== undefined) headers.cookie = cookie;
  if (authorization !== undefined) headers.authorization = authorization;
  const request = { path: reqPath, url: reqPath, headers };
  return {
    request,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

async function activate(guard, context) {
  try {
    const ok = await guard.canActivate(context);
    return { ok, threw: false };
  } catch (e) {
    return { ok: false, threw: true, name: e?.constructor?.name, status: e?.getStatus?.() };
  }
}

// ---- harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const OPERATOR_TOKEN = 'shared-operator-secret-token';
const RUNNER_TASK_TOKEN = 'task-token-bound-to-some-task-NOT-an-operator';

const run = async () => {
  console.log('\n=== AuthGuard: operator session admission (real compiled source) ===\n');

  // Ensure a clean legacy-disabled baseline for the env-independent cases.
  delete process.env.AUTH_TOKEN_LEGACY_ENABLED;
  delete process.env.AUTH_TOKEN;

  // T1: valid session cookie admitted, principal attached.
  {
    const guard = new AuthGuard(sessionServiceFor('live-session'));
    const c = ctx({ cookie: 'cap_session=live-session' });
    const r = await activate(guard, c);
    assert(r.ok === true && r.threw === false, 'T1a: valid session cookie admitted');
    assert(c.request.operatorPrincipal?.kind === 'session' &&
           c.request.operatorPrincipal?.user?.githubId === 12345,
      'T1b: resolved session principal attached to request');
  }

  // T2: missing credentials -> 401, fail-closed, no principal attached.
  {
    const guard = new AuthGuard(denyAllSessions);
    const c = ctx({}); // no cookie, no authorization
    const r = await activate(guard, c);
    assert(r.threw === true && r.name === 'UnauthorizedException' && r.status === 401,
      'T2a: missing credentials -> 401 UnauthorizedException');
    assert(c.request.operatorPrincipal === undefined,
      'T2b: no principal attached on denial (no state change)');
  }

  // T3: disabled / expired / revoked session (resolver -> null) -> 401.
  {
    const guard = new AuthGuard(denyAllSessions);
    const r = await activate(guard, ctx({ cookie: 'cap_session=stale-or-disabled' }));
    assert(r.threw === true && r.status === 401,
      'T3: non-resolving session (expired/revoked/disabled) -> 401');
  }

  // T4: legacy AUTH_TOKEN bearer admitted ONLY when the legacy path is enabled.
  {
    const guard = new AuthGuard(denyAllSessions);

    // 4a: legacy disabled (flag unset) -> rejected even with a correct AUTH_TOKEN.
    delete process.env.AUTH_TOKEN_LEGACY_ENABLED;
    process.env.AUTH_TOKEN = OPERATOR_TOKEN;
    let r = await activate(guard, ctx({ authorization: `Bearer ${OPERATOR_TOKEN}` }));
    assert(r.threw === true && r.status === 401,
      'T4a: legacy bearer rejected when AUTH_TOKEN_LEGACY_ENABLED unset (default off)');

    // 4b: legacy explicitly false -> rejected.
    process.env.AUTH_TOKEN_LEGACY_ENABLED = 'false';
    r = await activate(guard, ctx({ authorization: `Bearer ${OPERATOR_TOKEN}` }));
    assert(r.threw === true && r.status === 401,
      'T4b: legacy bearer rejected when AUTH_TOKEN_LEGACY_ENABLED=false');

    // 4c: legacy enabled + matching AUTH_TOKEN -> admitted as legacy-token principal.
    process.env.AUTH_TOKEN_LEGACY_ENABLED = 'true';
    const c = ctx({ authorization: `Bearer ${OPERATOR_TOKEN}` });
    r = await activate(guard, c);
    assert(r.ok === true && c.request.operatorPrincipal?.kind === 'legacy-token',
      'T4c: legacy bearer admitted when enabled + matches (constant-time)');

    // 4d: legacy enabled but WRONG token -> rejected.
    r = await activate(guard, ctx({ authorization: 'Bearer not-the-operator-token' }));
    assert(r.threw === true && r.status === 401,
      'T4d: legacy bearer rejected when token mismatches even with legacy enabled');
  }

  // T5: a runner TASK_TOKEN presented as the operator bearer never authenticates,
  //     even with the legacy path enabled — it is simply a non-matching AUTH_TOKEN.
  {
    process.env.AUTH_TOKEN_LEGACY_ENABLED = 'true';
    process.env.AUTH_TOKEN = OPERATOR_TOKEN;
    const guard = new AuthGuard(denyAllSessions);
    const c = ctx({ authorization: `Bearer ${RUNNER_TASK_TOKEN}` });
    const r = await activate(guard, c);
    assert(r.threw === true && r.status === 401 && c.request.operatorPrincipal === undefined,
      'T5: runner TASK_TOKEN never authenticates an operator (no special case)');
  }

  // T6: exemptions — session/login entry points + /health admitted without a principal;
  //     an unknown protected path is still gated.
  {
    delete process.env.AUTH_TOKEN_LEGACY_ENABLED;
    delete process.env.AUTH_TOKEN;
    const guard = new AuthGuard(denyAllSessions);
    for (const p of [
      '/health',
      '/auth/session',
      '/auth/logout',
      '/auth/password',
      '/auth/otp/request',
      '/auth/otp/verify',
      '/Auth/Session?x=1',   // case + query normalised
      '/health/',            // trailing slash normalised
    ]) {
      const c = ctx({ path: p });
      const r = await activate(guard, c);
      assert(r.ok === true && r.threw === false && c.request.operatorPrincipal === undefined,
        `T6 exempt: ${p} admitted without an operator principal`);
    }
    // A non-exempt protected path with no credentials is still 401.
    const r = await activate(guard, ctx({ path: '/tasks' }));
    assert(r.threw === true && r.status === 401, 'T6 gated: unknown protected path -> 401');
  }

  // cleanup env we mutated
  delete process.env.AUTH_TOKEN_LEGACY_ENABLED;
  delete process.env.AUTH_TOKEN;

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
