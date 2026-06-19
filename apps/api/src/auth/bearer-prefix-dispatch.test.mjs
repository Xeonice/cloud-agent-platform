/**
 * Minimal test: "Bearer credentials are routed by token prefix before session resolution"
 * (api-key-machine-identity, requirement D1 / task 4.3)
 *
 * The invariant: when a bearer token begins with a reserved prefix (cap_sk_ or mcp_),
 * resolveOperatorPrincipal routes it to the matching domain resolver BEFORE it ever
 * tries the session lookup — even on the WS channel where the same token fills both
 * the sessionToken and bearerToken slots.
 *
 * Runs under plain `node` — no transpile required.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// --- inlined copies of the two constants and the function under test ---

const CREDENTIAL_PREFIX = { API_KEY: 'cap_sk_', MCP: 'mcp_' };

function constantTimeEqual(a, b) {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

const denyMcpResolver = async () => null;

async function resolveOperatorPrincipal(credentials, resolvers, env = {}) {
  const bearer = credentials.bearerToken;

  // Step 0 — TOKEN-PREFIX DISPATCH (must be first)
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

  // Step 1 — session (only for unprefixed credentials)
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolvers.resolveSession(sessionToken);
    if (user !== null) return { kind: 'session', user };
  }

  // Step 2 — legacy bearer (only for unprefixed credentials)
  if (typeof bearer === 'string' && bearer.length > 0) {
    const legacyEnabled =
      (env['AUTH_TOKEN_LEGACY_ENABLED'] ?? '').trim().toLowerCase();
    if (['true', '1', 'yes'].includes(legacyEnabled)) {
      const configured = env['AUTH_TOKEN'];
      if (typeof configured === 'string' && configured.length > 0) {
        if (constantTimeEqual(bearer, configured)) return { kind: 'legacy-token', user: null };
      }
    }
  }

  return null;
}

// --- test harness ---

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else       { console.error(`  FAIL  ${label}`); failed++; }
}

// A spy that records every token it receives so we can assert it was NEVER called.
function spySession() {
  const calls = [];
  const fn = async (t) => { calls.push(t); return null; };
  fn.calls = calls;
  return fn;
}

const KEY_USER   = { githubId: 1, login: 'owner', name: '', avatarUrl: '', allowed: true };
const VALID_KEY  = 'cap_sk_high-entropy-machine-key';
const VALID_MCP  = 'mcp_machine-token';
const UNRELATED  = 'plain-session-token';

function apiKeyResolver(liveKey) {
  return async (raw) =>
    raw === liveKey ? { user: KEY_USER, scopes: ['tasks:read'], keyId: 'k1' } : null;
}

void (async () => {
  console.log('\n=== Bearer credentials are routed by token prefix before session resolution ===\n');

  // Scenario A — cap_sk_ bearer on REST:
  //   Resolves to api-key; session lookup never called.
  {
    const spy = spySession();
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: VALID_KEY },
      { resolveSession: spy, resolveApiKey: apiKeyResolver(VALID_KEY) },
    );
    assert(p?.kind === 'api-key' && p.user.githubId === 1,
      'A: cap_sk_ bearer resolves to api-key principal (REST)');
    assert(spy.calls.length === 0,
      'A: session resolver NOT called for a cap_sk_ bearer (REST)');
  }

  // Scenario B — cap_sk_ bearer on WS (same token in BOTH slots):
  //   Prefix dispatch fires first; session lookup never called even though
  //   the same token also fills sessionToken.
  {
    const spy = spySession();
    const p = await resolveOperatorPrincipal(
      { sessionToken: VALID_KEY, bearerToken: VALID_KEY },
      { resolveSession: spy, resolveApiKey: apiKeyResolver(VALID_KEY) },
    );
    assert(p?.kind === 'api-key',
      'B: cap_sk_ bearer on WS channel (both slots filled) resolves to api-key');
    assert(spy.calls.length === 0,
      'B: session resolver NOT called for a cap_sk_ bearer (WS channel)');
  }

  // Scenario C — mcp_ bearer (unbound resolver):
  //   Denied by the default deny-resolver; session lookup never called.
  {
    const spy = spySession();
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: VALID_MCP },
      { resolveSession: spy, resolveApiKey: async () => null },
      // resolveMcp omitted -> defaults to denyMcpResolver
    );
    assert(p === null,
      'C: mcp_ bearer denied by default unbound resolver');
    assert(spy.calls.length === 0,
      'C: session resolver NOT called for an mcp_ bearer');
  }

  // Scenario D — mcp_ bearer on WS (same token in BOTH slots):
  //   Prefix dispatch fires first; denied, never falls through to session.
  {
    const spy = spySession();
    const p = await resolveOperatorPrincipal(
      { sessionToken: VALID_MCP, bearerToken: VALID_MCP },
      { resolveSession: spy, resolveApiKey: async () => null },
    );
    assert(p === null,
      'D: mcp_ bearer on WS channel denied by default');
    assert(spy.calls.length === 0,
      'D: session resolver NOT called for an mcp_ bearer (WS channel)');
  }

  // Scenario E — unknown/revoked cap_sk_ key:
  //   Dispatched to api-key resolver (correctly), which returns null; result is
  //   null — does NOT fall through to session or legacy.
  {
    const spy = spySession();
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'cap_sk_could-be-a-cookie', bearerToken: 'cap_sk_unknown-key' },
      { resolveSession: spy, resolveApiKey: async () => null },
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: 'cap_sk_unknown-key' }, // legacy enabled but must NOT be reached
    );
    assert(p === null,
      'E: unresolvable cap_sk_ key denied (does not fall through to session or legacy)');
    assert(spy.calls.length === 0,
      'E: session resolver NOT called after a failed cap_sk_ lookup');
  }

  // Scenario F — unprefixed bearer is NOT intercepted by prefix dispatch:
  //   Session path runs normally (controls: prefix dispatch must not swallow plain tokens).
  {
    const spy = spySession();
    let apiKeyCalled = false;
    const trackingApiKey = async () => { apiKeyCalled = true; return null; };
    const p = await resolveOperatorPrincipal(
      { sessionToken: UNRELATED, bearerToken: 'plain-bearer' },
      {
        resolveSession: async (t) => {
          spy.calls.push(t);
          return t === UNRELATED ? KEY_USER : null;
        },
        resolveApiKey: trackingApiKey,
      },
    );
    assert(p?.kind === 'session',
      'F: unprefixed bearer does not trigger api-key dispatch (session path unchanged)');
    assert(!apiKeyCalled,
      'F: api-key resolver NOT called for an unprefixed token');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
})();
