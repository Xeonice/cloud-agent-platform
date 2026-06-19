/**
 * Verify-phase test for operator-principal resolution
 * (be-oauth-allowlist, tasks 2.6 / 2.7 / 2.8; extended by
 * api-key-machine-identity, tasks 4.2 / 4.3 / 4.5 / 4.6 / 4.7).
 *
 * Requirement semantics (from operator-principal.ts + main.ts):
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
 *   7. TOKEN-PREFIX DISPATCH is the FIRST step (task 4.3): a `cap_sk_…` bearer is
 *      tried ONLY against the api-key resolver and an `mcp_…` bearer ONLY against
 *      the reserved MCP resolver — NEITHER ever reaches the session lookup, on the
 *      REST header OR the WS channel (where the same token also fills the session
 *      slot). The api-key resolver re-confirms the owner's allowlist, so a
 *      de-allowlisted owner's key is denied on its next request.
 *   8. The reserved `mcp_…` slot DENIES until a resolver is bound (default deny).
 *   9. `hasScope` is allow-all for a scopeless principal and per-scope for a
 *      scoped (api-key) principal (task 4.5).
 *  10. The boot assertion (main.ts, task 4.6) refuses to boot when AUTH_TOKEN
 *      begins with a reserved prefix and boots otherwise.
 *
 * Logic is inlined (mirrors operator-principal.ts + main.ts + the constant-time +
 * legacy helpers it composes) so the test runs under plain `node` with no
 * transpile.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ---- inline (mirrors @cap/contracts credential-prefix constants, task 2.2) ----

const CREDENTIAL_PREFIX = { API_KEY: 'cap_sk_', MCP: 'mcp_' };
const RESERVED_CREDENTIAL_PREFIXES = [CREDENTIAL_PREFIX.API_KEY, CREDENTIAL_PREFIX.MCP];

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

// ---- inline (mirrors operator-principal.denyMcpResolver) ----

const denyMcpResolver = async () => null;

// ---- inline (mirrors operator-principal.resolveOperatorPrincipal, task 4.3) ----

async function resolveOperatorPrincipal(credentials, resolvers, env = {}) {
  const bearer = credentials.bearerToken;

  // 0. TOKEN-PREFIX DISPATCH — FIRST. A reserved-prefix bearer routes to exactly
  //    one domain and NEVER falls through to the session lookup.
  if (typeof bearer === 'string' && bearer.length > 0) {
    if (bearer.startsWith(CREDENTIAL_PREFIX.API_KEY)) {
      const resolved = await resolvers.resolveApiKey(bearer);
      if (resolved === null) return null;
      return { kind: 'api-key', user: resolved.user, scopes: resolved.scopes, keyId: resolved.keyId };
    }
    if (bearer.startsWith(CREDENTIAL_PREFIX.MCP)) {
      const resolveMcp = resolvers.resolveMcp ?? denyMcpResolver;
      return resolveMcp(bearer);
    }
  }

  // 1. Session-first (unprefixed).
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolvers.resolveSession(sessionToken);
    if (user !== null) return { kind: 'session', user };
  }

  // 2. Gated legacy bearer (unprefixed only).
  if (typeof bearer === 'string' && bearer.length > 0 && isLegacyTokenEnabled(env)) {
    const configured = env[ENV.AUTH_TOKEN];
    if (typeof configured === 'string' && configured.length > 0) {
      if (constantTimeEqual(bearer, configured)) return { kind: 'legacy-token', user: null };
    }
  }

  return null;
}

// ---- inline (mirrors operator-principal.hasScope, task 4.5) ----

function hasScope(principal, required) {
  if (principal.scopes === undefined) return true; // allow-all for session/legacy.
  return principal.scopes.includes(required);
}

// ---- inline (mirrors the main.ts reserved-prefix boot assertion, task 4.6) ----

/** Returns the colliding reserved prefix, or null when AUTH_TOKEN is safe/absent. */
function bootCollision(authToken) {
  if (typeof authToken !== 'string' || authToken.length === 0) return null;
  return RESERVED_CREDENTIAL_PREFIXES.find((p) => authToken.startsWith(p)) ?? null;
}

// ---- helpers ----

const ALLOWED_USER = {
  githubId: 12345,
  login: 'op',
  name: 'Operator',
  avatarUrl: '',
  allowed: true,
};

const KEY_OWNER = {
  githubId: 67890,
  login: 'machine-owner',
  name: 'Key Owner',
  avatarUrl: '',
  allowed: true,
};

/** A session resolver that admits ONLY `liveToken`, returning null otherwise. */
function resolverFor(liveToken) {
  return async (token) => (token === liveToken ? ALLOWED_USER : null);
}

/** A session resolver that RECORDS every call (to prove prefixed tokens skip it). */
function spySessionResolver() {
  const calls = [];
  const fn = async (token) => {
    calls.push(token);
    return null;
  };
  fn.calls = calls;
  return fn;
}

/** An api-key resolver that admits ONLY `liveKey` (and re-confirms allowlist by
 *  returning null for `deAllowlistedKey`, modelling the owner falling off the
 *  list at resolution time). */
function apiKeyResolverFor(liveKey) {
  return async (raw) =>
    raw === liveKey ? { user: KEY_OWNER, scopes: ['tasks:read'], keyId: 'key-1' } : null;
}

const denyAllSession = async () => null;
const denyAllApiKey = async () => null;

const baseResolvers = (overrides = {}) => ({
  resolveSession: denyAllSession,
  resolveApiKey: denyAllApiKey,
  ...overrides,
});

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
      { sessionToken: 'live-session', bearerToken: null },
      baseResolvers({ resolveSession: resolverFor('live-session') }),
      {},
    );
    assert(p !== null && p.kind === 'session' && p.user.githubId === 12345,
      'T1: valid allowlisted session admits as session principal');
  }

  // T2: de-allowlisted / revoked / expired session (resolver -> null) denied.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'stale-session', bearerToken: null },
      baseResolvers({ resolveSession: resolverFor('live-session') }),
      {},
    );
    assert(p === null, 'T2: non-resolving (revoked/expired/de-allowlisted) session denied');
  }

  // T3: legacy bearer admits when enabled + configured + matching.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'legacy-token' && p.user === null,
      'T3: legacy bearer admits when AUTH_TOKEN_LEGACY_ENABLED=true and matches');
  }

  // T4: legacy bearer DENIED when the legacy path is disabled (default false).
  {
    const pDefault = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN: OPERATOR_TOKEN }, // AUTH_TOKEN_LEGACY_ENABLED unset -> false
    );
    assert(pDefault === null, 'T4a: legacy bearer denied when AUTH_TOKEN_LEGACY_ENABLED unset (default false)');
    const pFalse = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'false', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(pFalse === null, 'T4b: legacy bearer denied when AUTH_TOKEN_LEGACY_ENABLED=false');
  }

  // T5: a runner TASK_TOKEN presented as the operator bearer is denied even when
  //     the legacy path is enabled — it is simply a non-matching AUTH_TOKEN.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: RUNNER_TASK_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p === null, 'T5: runner TASK_TOKEN never authenticates an operator (no special case)');
  }

  // T6: legacy bearer denied when AUTH_TOKEN itself is unset/empty (fail-closed),
  //     even with the legacy path enabled.
  {
    const pUnset = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true' }, // AUTH_TOKEN unset
    );
    assert(pUnset === null, 'T6a: legacy bearer denied when AUTH_TOKEN unset');
    const pEmpty = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: '' },
    );
    assert(pEmpty === null, 'T6b: legacy bearer denied when AUTH_TOKEN empty');
  }

  // T7: session-first — a valid session wins even if a (mismatching) legacy bearer
  //     is also present; the legacy comparison is not needed.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'live-session', bearerToken: 'wrong-token' },
      baseResolvers({ resolveSession: resolverFor('live-session') }),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'session', 'T7: valid session is authoritative (session-first)');
  }

  // T8: WS single-credential case — the SAME string presented as both session and
  //     legacy candidates: a valid AUTH_TOKEN is accepted via the legacy fallback
  //     even though it is (correctly) rejected as a session token.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: OPERATOR_TOKEN, bearerToken: OPERATOR_TOKEN },
      baseResolvers(), // not a session token
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p !== null && p.kind === 'legacy-token',
      'T8: WS single-credential legacy AUTH_TOKEN accepted via fallback after session miss');
    // ...and the same WS credential is denied when the legacy path is off.
    const pOff = await resolveOperatorPrincipal(
      { sessionToken: OPERATOR_TOKEN, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(pOff === null, 'T8b: same WS credential denied when legacy path disabled');
  }

  // T9: nothing presented -> fail closed.
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: null },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(p === null, 'T9: no credentials -> fail closed');
  }

  console.log('\n--- token-prefix dispatch (api-key-machine-identity, task 4.3/4.7) ---\n');

  const LIVE_KEY = 'cap_sk_live-machine-key-high-entropy';

  // T10: a cap_sk_ key on the REST bearer header resolves to api-key WITHOUT any
  //      session lookup.
  {
    const spy = spySessionResolver();
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      baseResolvers({ resolveSession: spy, resolveApiKey: apiKeyResolverFor(LIVE_KEY) }),
      {},
    );
    assert(p !== null && p.kind === 'api-key' && p.user.githubId === KEY_OWNER.githubId,
      'T10: cap_sk_ key on REST bearer resolves to api-key principal with owner');
    assert(JSON.stringify(p?.scopes) === JSON.stringify(['tasks:read']) && p?.keyId === 'key-1',
      'T10b: api-key principal carries the key scopes + keyId');
    assert(spy.calls.length === 0, 'T10c: cap_sk_ key NEVER produces a Session lookup (REST)');
  }

  // T11: the SAME cap_sk_ key on the WS channel (same token in BOTH slots) still
  //      never hits the session lookup — dispatch is the first step.
  {
    const spy = spySessionResolver();
    const p = await resolveOperatorPrincipal(
      { sessionToken: LIVE_KEY, bearerToken: LIVE_KEY },
      baseResolvers({ resolveSession: spy, resolveApiKey: apiKeyResolverFor(LIVE_KEY) }),
      {},
    );
    assert(p !== null && p.kind === 'api-key',
      'T11: cap_sk_ key on WS channel (both slots) resolves to api-key');
    assert(spy.calls.length === 0, 'T11b: cap_sk_ key on WS NEVER produces a Session lookup');
  }

  // T12: an UNKNOWN / revoked / expired / de-allowlisted-owner cap_sk_ key is
  //      denied (the api-key resolver returns null) and does NOT fall through to a
  //      session lookup or the legacy compare.
  {
    const spy = spySessionResolver();
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'cap_sk_someones-cookie', bearerToken: 'cap_sk_de-allowlisted-owner' },
      baseResolvers({ resolveSession: spy, resolveApiKey: apiKeyResolverFor(LIVE_KEY) }),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: 'cap_sk_de-allowlisted-owner' },
    );
    assert(p === null, 'T12: de-allowlisted/unknown cap_sk_ key denied (resolver -> null)');
    assert(spy.calls.length === 0, 'T12b: a denied cap_sk_ key does NOT fall through to a Session lookup');
  }

  // T13: a reserved mcp_ credential is DENIED by default (no resolver bound) and
  //      never hits the session lookup, on REST and WS.
  {
    const spyRest = spySessionResolver();
    const pRest = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: 'mcp_some-machine-token' },
      baseResolvers({ resolveSession: spyRest }),
      {},
    );
    assert(pRest === null, 'T13: mcp_ credential denied by default (unbound resolver)');
    assert(spyRest.calls.length === 0, 'T13b: mcp_ credential NEVER produces a Session lookup (REST)');

    const spyWs = spySessionResolver();
    const pWs = await resolveOperatorPrincipal(
      { sessionToken: 'mcp_some-machine-token', bearerToken: 'mcp_some-machine-token' },
      baseResolvers({ resolveSession: spyWs }),
      {},
    );
    assert(pWs === null, 'T13c: mcp_ credential on WS channel denied by default');
    assert(spyWs.calls.length === 0, 'T13d: mcp_ credential on WS NEVER produces a Session lookup');
  }

  // T14: a BOUND mcp_ resolver is honoured (proves the slot is reserved, not
  //      hard-wired to deny) — and is still the ONLY resolver tried.
  {
    const spy = spySessionResolver();
    const boundMcp = async (raw) =>
      raw === 'mcp_bound' ? { kind: 'mcp', user: null, scopes: ['tasks:read'] } : null;
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: 'mcp_bound' },
      baseResolvers({ resolveSession: spy, resolveMcp: boundMcp }),
      {},
    );
    assert(p !== null && p.kind === 'mcp', 'T14: a bound mcp_ resolver resolves the reserved slot');
    assert(spy.calls.length === 0, 'T14b: a bound mcp_ credential still never hits the session lookup');
  }

  // T15: UNPREFIXED credentials behave EXACTLY as before — the api-key resolver is
  //      never consulted for a plain operator/session token.
  {
    let apiKeyCalled = false;
    const trackingApiKey = async () => { apiKeyCalled = true; return null; };
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'live-session', bearerToken: 'wrong' },
      baseResolvers({ resolveSession: resolverFor('live-session'), resolveApiKey: trackingApiKey }),
      {},
    );
    assert(p !== null && p.kind === 'session', 'T15: unprefixed session unchanged (still admits)');
    assert(apiKeyCalled === false, 'T15b: unprefixed credential never consults the api-key resolver');
  }

  // T16: constant-time legacy compare preserved for an unprefixed bearer.
  {
    const pMatch = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: OPERATOR_TOKEN },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    const pMiss = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: `${OPERATOR_TOKEN}-tampered` },
      baseResolvers(),
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: OPERATOR_TOKEN },
    );
    assert(pMatch !== null && pMatch.kind === 'legacy-token' && pMiss === null,
      'T16: constant-time legacy compare preserved (match admits, mismatch denies)');
  }

  console.log('\n--- hasScope (task 4.5) ---\n');

  // T17: a scopeless principal (session / legacy) is allow-all.
  {
    const session = { kind: 'session', user: ALLOWED_USER };
    const legacy = { kind: 'legacy-token', user: null };
    assert(hasScope(session, 'tasks:write') && hasScope(session, 'repos:read'),
      'T17: scopeless session principal passes every scope gate (allow-all)');
    assert(hasScope(legacy, 'tasks:write'), 'T17b: scopeless legacy principal passes every scope gate');
  }

  // T18: a scoped api-key principal passes only its granted scopes.
  {
    const key = { kind: 'api-key', user: KEY_OWNER, scopes: ['tasks:read'], keyId: 'k' };
    assert(hasScope(key, 'tasks:read'), 'T18: tasks:read key passes a tasks:read gate');
    assert(!hasScope(key, 'tasks:write'), 'T18b: tasks:read-only key is denied a tasks:write gate (-> 403)');
    const empty = { kind: 'api-key', user: KEY_OWNER, scopes: [], keyId: 'k' };
    assert(!hasScope(empty, 'tasks:read'), 'T18c: an empty-scope key passes nothing (deny-all, distinct from undefined)');
  }

  console.log('\n--- AUTH_TOKEN reserved-prefix boot assertion (main.ts, task 4.6) ---\n');

  // T19: boot REFUSED when AUTH_TOKEN collides with a reserved prefix.
  {
    assert(bootCollision('cap_sk_operator-chose-this') === 'cap_sk_',
      'T19: boot refused when AUTH_TOKEN starts with cap_sk_');
    assert(bootCollision('mcp_operator-chose-this') === 'mcp_',
      'T19b: boot refused when AUTH_TOKEN starts with mcp_');
  }

  // T20: boot ALLOWED for a non-colliding / absent AUTH_TOKEN.
  {
    assert(bootCollision('shared-operator-secret') === null,
      'T20: non-colliding AUTH_TOKEN boots normally');
    assert(bootCollision('') === null && bootCollision(undefined) === null,
      'T20b: absent/empty AUTH_TOKEN does not trip the assertion');
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
