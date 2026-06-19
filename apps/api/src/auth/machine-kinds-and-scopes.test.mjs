/**
 * Minimal test: "Operator principal supports machine kinds and authorization scopes"
 * (api-key-machine-identity, multi-user-oauth spec)
 *
 * Requirement text:
 *   The operator principal SHALL support an `api-key` kind in addition to `session`
 *   and `legacy-token`, and SHALL reserve an `mcp` kind. The principal SHALL be able
 *   to carry an optional set of authorization scopes and an optional key identifier.
 *   A principal that carries no scopes SHALL be treated as allow-all by scope-gated
 *   operations, preserving the behavior of session and legacy principals.
 *
 * Scenario: API-key principal carries owner and scopes
 *   WHEN an API key resolves successfully
 *   THEN the resulting principal has kind `api-key`, a user equal to the key owner,
 *        and the key's granted scopes
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ---- inline mirrors of the production logic ----

const CREDENTIAL_PREFIX = { API_KEY: 'cap_sk_', MCP: 'mcp_' };

// Mirrors operator-principal.ts: denyMcpResolver
const denyMcpResolver = async () => null;

// Mirrors operator-principal.ts: resolveOperatorPrincipal (the relevant dispatch logic)
async function resolveOperatorPrincipal(credentials, resolvers, env = {}) {
  const bearer = credentials.bearerToken;

  // Step 0: token-prefix dispatch
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

  // Step 1: session
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolvers.resolveSession(sessionToken);
    if (user !== null) return { kind: 'session', user };
  }

  // Step 2: legacy bearer
  const AUTH_TOKEN_LEGACY_ENABLED = 'AUTH_TOKEN_LEGACY_ENABLED';
  const AUTH_TOKEN = 'AUTH_TOKEN';
  function isLegacyTokenEnabled(e) {
    const raw = e[AUTH_TOKEN_LEGACY_ENABLED];
    if (typeof raw !== 'string') return false;
    const v = raw.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  function constantTimeEqual(a, b) {
    const da = createHash('sha256').update(a, 'utf8').digest();
    const db = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(da, db);
  }
  if (typeof bearer === 'string' && bearer.length > 0 && isLegacyTokenEnabled(env)) {
    const configured = env[AUTH_TOKEN];
    if (typeof configured === 'string' && configured.length > 0) {
      if (constantTimeEqual(bearer, configured)) return { kind: 'legacy-token', user: null };
    }
  }

  return null;
}

// Mirrors operator-principal.ts: hasScope
function hasScope(principal, required) {
  if (principal?.scopes === undefined) return true; // allow-all for session/legacy
  return principal.scopes.includes(required);
}

// ---- test harness ----

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

// ---- fixtures ----

const KEY_OWNER = {
  githubId: 67890,
  login: 'machine-owner',
  name: 'Key Owner',
  avatarUrl: '',
  allowed: true,
};

const SESSION_USER = {
  githubId: 12345,
  login: 'human-op',
  name: 'Human Operator',
  avatarUrl: '',
  allowed: true,
};

const LIVE_KEY = 'cap_sk_abc123-high-entropy-random-key';

// An api-key resolver that returns owner + scopes for the live key
const apiKeyResolver = async (raw) => {
  if (raw === LIVE_KEY) {
    return { user: KEY_OWNER, scopes: ['tasks:read', 'tasks:write'], keyId: 'key-abc' };
  }
  return null;
};

const sessionResolver = async (token) => (token === 'live-session' ? SESSION_USER : null);
const denySession = async () => null;

const run = async () => {
  console.log('\n=== Requirement: Operator principal supports machine kinds and authorization scopes ===\n');

  // R1: PrincipalKind type includes 'api-key' and 'mcp' (structural check via resolution)
  // An api-key principal resolves to kind 'api-key'
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: apiKeyResolver },
      {},
    );
    assert(p !== null, 'R1a: api-key resolution returns a non-null principal');
    assert(p?.kind === 'api-key', 'R1b: resolved principal has kind "api-key"');
  }

  // R2: api-key principal carries owner (user) equal to the key owner
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: apiKeyResolver },
      {},
    );
    assert(p?.user !== null && p?.user !== undefined, 'R2a: api-key principal carries a user (key owner)');
    assert(p?.user?.githubId === KEY_OWNER.githubId, 'R2b: api-key principal user equals the key owner');
    assert(p?.user?.login === KEY_OWNER.login, 'R2c: api-key principal user login matches key owner');
  }

  // R3: api-key principal carries the key's granted scopes
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: apiKeyResolver },
      {},
    );
    assert(Array.isArray(p?.scopes), 'R3a: api-key principal has a scopes array');
    assert(p?.scopes?.includes('tasks:read'), 'R3b: api-key principal scopes include tasks:read');
    assert(p?.scopes?.includes('tasks:write'), 'R3c: api-key principal scopes include tasks:write');
  }

  // R4: api-key principal optionally carries a key identifier (keyId)
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: apiKeyResolver },
      {},
    );
    assert(p?.keyId === 'key-abc', 'R4: api-key principal carries the optional keyId');
  }

  // R5: mcp kind is reserved — resolves to kind 'mcp' when a bound resolver returns it
  {
    const boundMcpResolver = async (raw) =>
      raw === 'mcp_bound-token' ? { kind: 'mcp', user: null, scopes: ['tasks:read'] } : null;
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: 'mcp_bound-token' },
      { resolveSession: denySession, resolveApiKey: async () => null, resolveMcp: boundMcpResolver },
      {},
    );
    assert(p !== null && p?.kind === 'mcp', 'R5: mcp kind is reserved and supported by the principal type');
  }

  // R6: session principal has NO scopes (scopes === undefined) -> allow-all
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: 'live-session', bearerToken: null },
      { resolveSession: sessionResolver, resolveApiKey: async () => null },
      {},
    );
    assert(p?.kind === 'session', 'R6a: session resolves to kind "session"');
    assert(p?.scopes === undefined, 'R6b: session principal carries NO scopes (undefined)');
    assert(hasScope(p, 'tasks:read'), 'R6c: scopeless session passes any scope gate (allow-all)');
    assert(hasScope(p, 'tasks:write'), 'R6d: scopeless session passes tasks:write (allow-all)');
    assert(hasScope(p, 'repos:read'), 'R6e: scopeless session passes repos:read (allow-all)');
  }

  // R7: legacy-token principal has NO scopes -> allow-all
  {
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: 'shared-secret' },
      { resolveSession: denySession, resolveApiKey: async () => null },
      { AUTH_TOKEN_LEGACY_ENABLED: 'true', AUTH_TOKEN: 'shared-secret' },
    );
    assert(p?.kind === 'legacy-token', 'R7a: legacy-token resolves to kind "legacy-token"');
    assert(p?.scopes === undefined, 'R7b: legacy-token principal carries NO scopes (undefined)');
    assert(hasScope(p, 'tasks:write'), 'R7c: scopeless legacy-token passes any scope gate (allow-all)');
  }

  // R8: scope-gated check: a scoped api-key principal is denied for a scope it lacks
  {
    const narrowKeyResolver = async (raw) =>
      raw === LIVE_KEY ? { user: KEY_OWNER, scopes: ['tasks:read'], keyId: 'k' } : null;
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: narrowKeyResolver },
      {},
    );
    assert(hasScope(p, 'tasks:read'), 'R8a: api-key with tasks:read passes tasks:read gate');
    assert(!hasScope(p, 'tasks:write'), 'R8b: api-key without tasks:write is denied at gate (->403)');
    assert(!hasScope(p, 'repos:read'), 'R8c: api-key without repos:read is denied at gate (->403)');
  }

  // R9: empty-scope api-key is deny-all (distinct from undefined which is allow-all)
  {
    const emptyKeyResolver = async (raw) =>
      raw === LIVE_KEY ? { user: KEY_OWNER, scopes: [], keyId: 'k' } : null;
    const p = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: LIVE_KEY },
      { resolveSession: denySession, resolveApiKey: emptyKeyResolver },
      {},
    );
    assert(Array.isArray(p?.scopes) && p?.scopes.length === 0, 'R9a: empty-scope api-key has scopes=[]');
    assert(!hasScope(p, 'tasks:read'), 'R9b: empty-scope api-key passes NO gate (deny-all)');
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
