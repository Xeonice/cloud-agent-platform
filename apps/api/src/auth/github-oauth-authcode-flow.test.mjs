/**
 * Minimal test: GitHub OAuth authorization-code flow
 *
 * Requirement: "GitHub OAuth authorization-code flow" of add-private-account-identity.
 *
 * This test exercises the full callback path:
 *   1. A valid signed anti-CSRF state (matching cookie + query param)
 *   2. A valid authorization code is presented
 *   3. The service exchanges code -> access token (mocked, no real GitHub call)
 *   4. The service fetches the GitHub user (mocked)
 *   5. The session service admits the allowlisted identity
 *   6. The controller mints a session cookie and redirects into the app
 *
 * Runs against the compiled dist (requires `pnpm --filter @cap/api build` already done).
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

// ---- minimal fakes ---------------------------------------------------------

const SESSION_SECRET = 'test-session-secret-32-chars-ok!';
const FAKE_ACCESS_TOKEN = 'ghs_fakeAccessToken';
const FAKE_GITHUB_USER = { id: 99001, login: 'testop', name: 'Test Operator', avatarUrl: '', email: 'testop@example.com' };
const FAKE_SESSION = { token: 'minted-tok', user: { githubId: 99001, login: 'testop', name: 'Test Operator', avatarUrl: '', allowed: true } };

function makeOAuthService() {
  const calls = { exchange: 0, fetchUser: 0 };
  return {
    calls,
    buildAuthorizeUrl: (_cfg, state) => `https://github.test/login/oauth/authorize?state=${state}`,
    exchangeCodeForToken: async (_cfg, code) => {
      calls.exchange++;
      if (typeof code !== 'string' || code.length === 0) throw new Error('no code');
      return FAKE_ACCESS_TOKEN;
    },
    fetchUser: async (token) => {
      calls.fetchUser++;
      if (token !== FAKE_ACCESS_TOKEN) throw new Error('unexpected token');
      return FAKE_GITHUB_USER;
    },
  };
}

function makeSessionService({ establish = FAKE_SESSION } = {}) {
  const calls = { establish: 0, revoke: 0 };
  return {
    calls,
    establishSessionForGitHubUser: async (user, token) => {
      calls.establish++;
      return establish;
    },
    resolveSession: async () => null,
    revokeSession: async () => { calls.revoke++; },
  };
}

function makeRes() {
  const out = { status: undefined, json: undefined, redirect: undefined, headers: {}, sent: false };
  const res = {
    status(code) { out.status = code; return res; },
    json(body) { out.json = body; out.sent = true; return res; },
    redirect(code, loc) { out.status = code; out.redirect = loc; out.sent = true; return res; },
    setHeader(name, value) { out.headers[name] = value; return res; },
    send() { out.sent = true; return res; },
  };
  return { res, out };
}

function makeReq({ cookie, proto = 'https' } = {}) {
  const headers = { 'x-forwarded-proto': proto };
  if (cookie) headers.cookie = cookie;
  return { headers, protocol: proto };
}

function withEnv(fn) {
  const saved = { ...process.env };
  process.env.GITHUB_CLIENT_ID = 'client-id';
  process.env.GITHUB_CLIENT_SECRET = 'client-secret';
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.AUTH_ALLOWLIST = String(FAKE_GITHUB_USER.id);
  delete process.env.WEB_ORIGIN;
  return Promise.resolve(fn()).finally(() => { Object.assign(process.env, saved); });
}

// ---- assertions ------------------------------------------------------------

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

// ---- test ------------------------------------------------------------------

const run = async () => {
  console.log('\n=== GitHub OAuth authorization-code flow (minimal) ===\n');

  await withEnv(async () => {
    const oauth = makeOAuthService();
    const sess  = makeSessionService();
    const ctrl  = new GitHubOAuthController(oauth, sess);

    // Build a valid signed state and put it in the cookie (simulating /login)
    const state = signState(SESSION_SECRET);
    const cookie = `${OAUTH_STATE_COOKIE_NAME}=${state}`;

    const { res, out } = makeRes();
    await ctrl.callback(makeReq({ cookie }), res, 'auth-code-from-github', state);

    // 1. Code was exchanged with GitHub
    ok(oauth.calls.exchange === 1, 'Step 1: code->token exchange called once');

    // 2. User was fetched from GitHub
    ok(oauth.calls.fetchUser === 1, 'Step 2: GitHub /user fetch called once');

    // 3. Session was established for the admitted identity
    ok(sess.calls.establish === 1, 'Step 3: session established for allowlisted identity');

    // 4. Controller redirects (302) into the app after admission
    ok(out.status === 302, 'Step 4: callback responds with 302 redirect');
    ok(typeof out.redirect === 'string' && out.redirect.length > 0,
      'Step 5: redirect location is set');

    // 5. An httpOnly session cookie carrying the minted token is set
    const cookies = Array.isArray(out.headers['Set-Cookie'])
      ? out.headers['Set-Cookie']
      : [out.headers['Set-Cookie'] ?? ''];
    const sessionCookie = cookies.find(c => c.startsWith(`${SESSION_COOKIE_NAME}=minted-tok`));
    ok(sessionCookie !== undefined, 'Step 6: session cookie set with minted token');
    ok(sessionCookie?.includes('HttpOnly'), 'Step 7: session cookie is HttpOnly');
  });

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
