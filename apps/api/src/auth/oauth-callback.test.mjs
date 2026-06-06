/**
 * Verify-phase test for the GitHub-OAuth controller orchestration
 * (be-oauth-allowlist, tasks 2.2 / 2.3 / 2.5) — everything that does NOT require
 * a live GitHub App.
 *
 * Drives the REAL compiled GitHubOAuthController (dist/auth/github-oauth.controller.js)
 * with a fake GitHubOAuthService whose network methods are SPIES, a fake
 * AuthSessionService, and a fake Express req/res, plus explicit env via
 * process.env. It verifies the controller's composed security decisions that
 * sit ABOVE the pure state/cookie helpers:
 *
 *   1. REFUSE-TO-START: with GITHUB_CLIENT_ID/SECRET (or SESSION_SECRET) unset,
 *      both /auth/github/login and /auth/github/callback fail closed (HTTP 500)
 *      and NEVER build an authorize URL or exchange a code.
 *   2. OAuth-state anti-CSRF at the callback: a missing/mismatched/forged state is
 *      rejected with HTTP 400 WITHOUT exchanging the code (the exchange + fetch +
 *      session spies are never called) — no session established.
 *   3. A valid state whose identity is NOT allowlisted (session service -> null)
 *      redirects to the login gate with a denial marker and sets NO session cookie.
 *   4. A valid state + allowlisted identity sets an HttpOnly session cookie.
 *   5. /auth/session returns 401 when no session resolves (no user:null body).
 *   6. /auth/logout invalidates server-side (revokeSession called) and clears the
 *      cookie, idempotently (always 204).
 *
 * The real GitHub login->callback round-trip (live code exchange + /user fetch)
 * is NOT exercised here and is SKIPPED — pending a configured OAuth App.
 *
 * Requires `pnpm --filter @cap/api build` before running.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/auth');

const { GitHubOAuthController } = require(path.join(DIST, 'github-oauth.controller.js'));
const { signState, OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } =
  require(path.join(DIST, 'session-token.js'));

// ---- fakes -----------------------------------------------------------------

/** GitHub OAuth service double whose network calls are spies (never hit GitHub). */
function makeOAuthService() {
  const spy = { buildAuthorizeUrl: 0, exchangeCodeForToken: 0, fetchUser: 0 };
  return {
    spy,
    buildAuthorizeUrl: (_config, state) => { spy.buildAuthorizeUrl += 1; return `https://github.test/authorize?state=${state}`; },
    exchangeCodeForToken: async () => { spy.exchangeCodeForToken += 1; return 'gh-access-token'; },
    fetchUser: async () => { spy.fetchUser += 1; return { id: 12345, login: 'op', name: 'Operator', avatarUrl: '' }; },
  };
}

/**
 * Session service double. `establish` controls the establish result (a session,
 * or null to model a non-allowlisted identity). `resolveResult` controls
 * resolveSession. revokeSession is a spy.
 */
function makeSessionService({ establish = { token: 'minted-session', user: { githubId: 12345, login: 'op', name: 'n', avatarUrl: '', allowed: true } }, resolveResult = null } = {}) {
  const spy = { establish: 0, resolve: 0, revoke: 0, revokedToken: undefined };
  return {
    spy,
    establishSessionForGitHubUser: async () => { spy.establish += 1; return establish; },
    resolveSession: async (token) => { spy.resolve += 1; spy.resolveToken = token; return resolveResult; },
    revokeSession: async (token) => { spy.revoke += 1; spy.revokedToken = token; },
  };
}

/** Fake Express response capturing status / json / redirect / Set-Cookie. */
function makeRes() {
  const captured = { status: undefined, json: undefined, redirect: undefined, headers: {}, sent: false };
  const res = {
    status(code) { captured.status = code; return res; },
    json(body) { captured.json = body; captured.sent = true; return res; },
    redirect(code, location) { captured.status = code; captured.redirect = location; captured.sent = true; return res; },
    setHeader(name, value) { captured.headers[name] = value; return res; },
    send() { captured.sent = true; return res; },
  };
  return { res, captured };
}

/** Fake Express request. https by default so Secure cookies are set. */
function makeReq({ cookie, code, state, proto = 'https' } = {}) {
  const headers = { 'x-forwarded-proto': proto };
  if (cookie !== undefined) headers.cookie = cookie;
  return { headers, protocol: proto, query: { code, state } };
}

function setCookieValues(captured) {
  const v = captured.headers['Set-Cookie'];
  return Array.isArray(v) ? v : v === undefined ? [] : [v];
}

// ---- harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const SESSION_SECRET = 'session-secret-for-tests';

function withOAuthEnv(fn) {
  const saved = { ...process.env };
  process.env.GITHUB_CLIENT_ID = 'client-id';
  process.env.GITHUB_CLIENT_SECRET = 'client-secret';
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.AUTH_ALLOWLIST = '12345';
  return Promise.resolve(fn()).finally(() => {
    process.env = saved;
  });
}

function withoutOAuthEnv(fn) {
  const saved = { ...process.env };
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
  delete process.env.SESSION_SECRET;
  return Promise.resolve(fn()).finally(() => {
    process.env = saved;
  });
}

const run = async () => {
  console.log('\n=== GitHubOAuthController: orchestration security (real compiled source) ===\n');

  // T1: refuse-to-start when OAuth credentials / session secret are unset.
  await withoutOAuthEnv(async () => {
    // login
    {
      const oauth = makeOAuthService();
      const sess = makeSessionService();
      const ctrl = new GitHubOAuthController(oauth, sess);
      const { res, captured } = makeRes();
      ctrl.login(makeReq(), res);
      assert(captured.status === 500 && oauth.spy.buildAuthorizeUrl === 0,
        'T1a: /login fails closed (500) and builds NO authorize URL when unconfigured');
    }
    // callback
    {
      const oauth = makeOAuthService();
      const sess = makeSessionService();
      const ctrl = new GitHubOAuthController(oauth, sess);
      const { res, captured } = makeRes();
      await ctrl.callback(makeReq({ code: 'c', state: 's' }), res, 'c', 's');
      assert(captured.status === 500 && oauth.spy.exchangeCodeForToken === 0,
        'T1b: /callback fails closed (500) and exchanges NO code when unconfigured');
    }
  });

  // T2: callback rejects a MISSING state WITHOUT exchanging the code.
  await withOAuthEnv(async () => {
    const oauth = makeOAuthService();
    const sess = makeSessionService();
    const ctrl = new GitHubOAuthController(oauth, sess);
    const { res, captured } = makeRes();
    // No state cookie, no state query.
    await ctrl.callback(makeReq({ code: 'the-code' }), res, 'the-code', undefined);
    assert(captured.status === 400, 'T2a: missing state -> 400');
    assert(oauth.spy.exchangeCodeForToken === 0 && oauth.spy.fetchUser === 0 && sess.spy.establish === 0,
      'T2b: missing state -> NO code exchange / fetch / session established');
  });

  // T3: callback rejects a MISMATCHED state (valid signature but != cookie) without exchange.
  await withOAuthEnv(async () => {
    const oauth = makeOAuthService();
    const sess = makeSessionService();
    const ctrl = new GitHubOAuthController(oauth, sess);
    const { res, captured } = makeRes();
    const cookieState = signState(SESSION_SECRET);
    const otherValidState = signState(SESSION_SECRET); // valid signature, different nonce
    await ctrl.callback(
      makeReq({ cookie: `${OAUTH_STATE_COOKIE_NAME}=${cookieState}`, code: 'the-code', state: otherValidState }),
      res, 'the-code', otherValidState,
    );
    assert(captured.status === 400, 'T3a: mismatched state -> 400');
    assert(oauth.spy.exchangeCodeForToken === 0 && sess.spy.establish === 0,
      'T3b: mismatched state -> NO code exchange (state checked before exchange)');
  });

  // T4: callback rejects a FORGED state (wrong secret signature) without exchange.
  await withOAuthEnv(async () => {
    const oauth = makeOAuthService();
    const sess = makeSessionService();
    const ctrl = new GitHubOAuthController(oauth, sess);
    const { res, captured } = makeRes();
    const forged = signState('attacker-secret'); // not signed by SESSION_SECRET
    await ctrl.callback(
      makeReq({ cookie: `${OAUTH_STATE_COOKIE_NAME}=${forged}`, code: 'the-code', state: forged }),
      res, 'the-code', forged,
    );
    assert(captured.status === 400 && oauth.spy.exchangeCodeForToken === 0,
      'T4: forged-state (foreign secret) rejected -> 400, no code exchange');
  });

  // T5: valid state but NON-allowlisted identity -> redirect to login gate w/ denial, no session cookie.
  await withOAuthEnv(async () => {
    const oauth = makeOAuthService();
    const sess = makeSessionService({ establish: null }); // models allowlist denial
    const ctrl = new GitHubOAuthController(oauth, sess);
    const { res, captured } = makeRes();
    const state = signState(SESSION_SECRET);
    await ctrl.callback(
      makeReq({ cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}`, code: 'the-code', state }),
      res, 'the-code', state,
    );
    assert(oauth.spy.exchangeCodeForToken === 1 && sess.spy.establish === 1,
      'T5a: valid state DOES exchange the code and consult the allowlist gate');
    assert(captured.status === 302 && String(captured.redirect).includes('denied=allowlist'),
      'T5b: non-allowlisted identity redirected to login gate with denial marker');
    const cookies = setCookieValues(captured);
    assert(!cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`) && !c.includes(`${SESSION_COOKIE_NAME}=;`)),
      'T5c: NO session cookie set for a denied identity');
  });

  // T6: valid state + allowlisted identity -> session cookie set (HttpOnly).
  await withOAuthEnv(async () => {
    const oauth = makeOAuthService();
    const sess = makeSessionService(); // default establish returns a session
    const ctrl = new GitHubOAuthController(oauth, sess);
    const { res, captured } = makeRes();
    const state = signState(SESSION_SECRET);
    await ctrl.callback(
      makeReq({ cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}`, code: 'the-code', state }),
      res, 'the-code', state,
    );
    assert(captured.status === 302, 'T6a: allowlisted identity redirected into the app');
    const cookies = setCookieValues(captured);
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=minted-session`));
    assert(sessionCookie !== undefined, 'T6b: session cookie set with the minted token');
    assert(sessionCookie?.includes('HttpOnly') && sessionCookie?.includes('SameSite=Lax'),
      'T6c: session cookie is HttpOnly + SameSite=Lax');
  });

  // T7: GET /auth/session returns 401 when no session resolves (no user:null body).
  await withOAuthEnv(async () => {
    const sess = makeSessionService({ resolveResult: null });
    const ctrl = new GitHubOAuthController(makeOAuthService(), sess);
    const { res, captured } = makeRes();
    await ctrl.session(makeReq({ cookie: `${SESSION_COOKIE_NAME}=whatever` }), res);
    assert(captured.status === 401 && captured.json?.user === undefined,
      'T7: /auth/session -> 401 (not a 200 user:null) when unauthenticated');
  });

  // T8: POST /auth/logout invalidates server-side + clears cookie, 204, idempotent.
  await withOAuthEnv(async () => {
    const sess = makeSessionService();
    const ctrl = new GitHubOAuthController(makeOAuthService(), sess);
    const { res, captured } = makeRes();
    await ctrl.logout(makeReq({ cookie: `${SESSION_COOKIE_NAME}=the-session-token` }), res);
    assert(captured.status === 204, 'T8a: logout returns 204');
    assert(sess.spy.revoke === 1 && sess.spy.revokedToken === 'the-session-token',
      'T8b: logout invalidates the presented session server-side (revokeSession called)');
    const cookies = setCookieValues(captured);
    assert(cookies.some((c) => c.startsWith(`${SESSION_COOKIE_NAME}=;`) || c.includes('Max-Age=0')),
      'T8c: logout clears the session cookie (Max-Age=0)');
  });

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('NOTE: live GitHub login->callback round-trip is SKIPPED (no OAuth App configured).');
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
