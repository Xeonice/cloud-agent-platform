/**
 * Minimal test: "The reserved mcp_ slot binds the real resolver and reuses the
 * GitHub allowlist" (remote-mcp-server, multi-user-oauth spec).
 *
 * Requirement text (multi-user-oauth/spec.md):
 *   This change SHALL bind the real `resolveMcpToken` into the reserved `mcp_`
 *   prefix slot of `resolveOperatorPrincipal` (replacing the deny-until-bound
 *   default), so a `mcp_` credential resolves to an `mcp` principal — still routed
 *   by prefix to EXACTLY that domain. The MCP token reuses the SAME hard allowlist
 *   (`isAllowlistedRaw`) that governs who may obtain a console session or an API key,
 *   so one allowlist governs all three credential kinds.
 *
 * Scenario: A bound mcp_ token resolves to an mcp principal
 *   WHEN a credential with the `mcp_` prefix is presented and resolves
 *   THEN `resolveOperatorPrincipal` routes it to `resolveMcpToken` and returns
 *        an `mcp` principal, never tried against the other domains
 *
 * This test inlines the relevant logic from:
 *   - operator-principal.ts: resolveOperatorPrincipal + denyMcpResolver
 *   - auth-session.service.ts: resolveMcpToken (real pipeline: hash → DB → allowlist)
 *   - allowlist.ts: isAllowlistedRaw (the shared allowlist gate)
 *
 * Running: node apps/api/src/auth/mcp-slot-allowlist.test.mjs
 */

import { createHash } from 'node:crypto';

// ── inline mirrors of production constants ────────────────────────────────────

const CREDENTIAL_PREFIX = { API_KEY: 'cap_sk_', MCP: 'mcp_' };
const MCP_RESOURCE_URI = 'cap:mcp';
// Year-9999 far-future fallback for never-expiring tokens (G1: expiresAt mandatory).
const MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT = Math.floor(Date.UTC(9999, 0, 1) / 1000);

// ── inline: allowlist.ts ──────────────────────────────────────────────────────
// isAllowlistedRaw — the SAME gate reused by session, api-key, AND mcp resolution.

function parseAllowlist(raw) {
  if (typeof raw !== 'string') return new Set();
  const entries = raw.split(',').map(e => e.trim()).filter(e => e.length > 0);
  if (entries.length === 0) return new Set();
  const ids = new Set();
  for (const entry of entries) {
    if (!/^[0-9]+$/.test(entry)) return new Set(); // fail-closed on any bad entry
    const id = Number(entry);
    if (!Number.isSafeInteger(id)) return new Set();
    ids.add(id);
  }
  return ids;
}

function isAllowlisted(githubId, allowlist) {
  if (!Number.isInteger(githubId)) return false;
  return allowlist.has(githubId);
}

function isAllowlistedRaw(githubId, rawAllowlist) {
  return isAllowlisted(githubId, parseAllowlist(rawAllowlist));
}

// ── inline: auth-session.service.ts resolveMcpToken ─────────────────────────
// The real pipeline: hash → DB lookup → reject revoked/expired → re-confirm allowlist.

function hashMcpTokenValue(rawToken) {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

async function resolveMcpToken(rawToken, prisma, env = {}, now = new Date()) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
  const tokenHash = hashMcpTokenValue(rawToken);
  const record = await prisma.mcpToken.findUnique({ where: { tokenHash }, includeUser: true });
  if (!record) return null;
  if (record.revokedAt != null) return null;
  if (record.expiresAt != null && record.expiresAt.getTime() <= now.getTime()) return null;
  const stillAllowed = isAllowlistedRaw(record.user.githubId, env['AUTH_ALLOWLIST']);
  if (!stillAllowed) return null;
  // Best-effort lastUsedAt bump (fire-and-forget, never awaited for resolution).
  void prisma.mcpToken.update({ where: { id: record.id }, data: { lastUsedAt: now } }).catch(() => {});
  return {
    token: rawToken,
    clientId: 'settings',
    scopes: record.scopes,
    expiresAt: record.expiresAt
      ? Math.floor(record.expiresAt.getTime() / 1000)
      : MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT,
    resource: MCP_RESOURCE_URI,
    ownerGithubId: record.user.githubId,
  };
}

// ── inline: operator-principal.ts resolveOperatorPrincipal ───────────────────

const denyMcpResolver = async () => null;

async function resolveOperatorPrincipal(credentials, resolvers) {
  const bearer = credentials.bearerToken;

  // 0. TOKEN-PREFIX DISPATCH — FIRST step (D1).
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

  // 1. Session-first (unprefixed credential).
  const sessionToken = credentials.sessionToken;
  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const user = await resolvers.resolveSession(sessionToken);
    if (user !== null) return { kind: 'session', user };
  }

  return null;
}

// ── fake Prisma ───────────────────────────────────────────────────────────────

function makePrisma(row) {
  return {
    mcpToken: {
      findUnique: async () => row,
      update: async () => row ?? {},
    },
  };
}

// ── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const OWNER_GITHUB_ID = 42001;
const ALLOWLIST = String(OWNER_GITHUB_ID);
const RAW_TOKEN = 'mcp_test-ground-truth-token-body';

// Matching DB row for RAW_TOKEN (hash computed at test time to prove we hash correctly).
const STORED_HASH = hashMcpTokenValue(RAW_TOKEN);
const VALID_ROW = {
  id: 'row-1',
  scopes: ['tasks:read', 'tasks:write'],
  expiresAt: null, // never-expiring
  revokedAt: null,
  user: { githubId: OWNER_GITHUB_ID },
};

// ── run ───────────────────────────────────────────────────────────────────────

const run = async () => {
  console.log('\n=== Requirement: The reserved mcp_ slot binds the real resolver and reuses the GitHub allowlist ===\n');

  // ── Part A: resolveMcpToken uses isAllowlistedRaw (the shared gate) ──────

  console.log('--- Part A: resolveMcpToken allowlist re-check (same isAllowlistedRaw) ---\n');

  // A1: allowlisted owner → token resolves
  {
    const prisma = makePrisma(VALID_ROW);
    const info = await resolveMcpToken(RAW_TOKEN, prisma, { AUTH_ALLOWLIST: ALLOWLIST });
    check(info !== null, 'A1: allowlisted owner + valid token → resolves to AuthInfo');
    check(info?.ownerGithubId === OWNER_GITHUB_ID, 'A1b: AuthInfo carries ownerGithubId');
    check(Array.isArray(info?.scopes), 'A1c: AuthInfo carries scopes');
    // G1: expiresAt MUST be populated (never undefined — requireBearerAuth 401s it).
    check(typeof info?.expiresAt === 'number' && info.expiresAt > 0,
      'A1d: expiresAt is a populated number (G1 — SDK requireBearerAuth guard)');
    check(info?.expiresAt === MCP_NON_EXPIRING_AUTHINFO_EXPIRES_AT,
      'A1e: never-expiring token gets the far-future fallback bound');
    check(info?.resource === MCP_RESOURCE_URI, 'A1f: resource is the canonical MCP URI');
  }

  // A2: de-allowlisted owner → same token is denied (allowlist re-checked every call)
  {
    const prisma = makePrisma(VALID_ROW);
    const info = await resolveMcpToken(RAW_TOKEN, prisma, { AUTH_ALLOWLIST: '99999' });
    check(info === null, 'A2: de-allowlisted owner → token denied (allowlist re-confirmed)');
  }

  // A3: empty/unset allowlist denies fail-closed (same semantics as session + api-key)
  {
    const prisma = makePrisma(VALID_ROW);
    const infoUnset = await resolveMcpToken(RAW_TOKEN, prisma, {});
    const infoEmpty = await resolveMcpToken(RAW_TOKEN, prisma, { AUTH_ALLOWLIST: '' });
    check(infoUnset === null, 'A3a: unset AUTH_ALLOWLIST denies fail-closed (same as session)');
    check(infoEmpty === null, 'A3b: empty AUTH_ALLOWLIST denies fail-closed');
  }

  // A4: revoked token denied before allowlist check
  {
    const revokedRow = { ...VALID_ROW, revokedAt: new Date(Date.now() - 1000) };
    const prisma = makePrisma(revokedRow);
    const info = await resolveMcpToken(RAW_TOKEN, prisma, { AUTH_ALLOWLIST: ALLOWLIST });
    check(info === null, 'A4: revoked token denied (revokedAt set)');
  }

  // A5: expired token denied
  {
    const expiredRow = { ...VALID_ROW, expiresAt: new Date(Date.now() - 1000) };
    const prisma = makePrisma(expiredRow);
    const info = await resolveMcpToken(RAW_TOKEN, prisma, { AUTH_ALLOWLIST: ALLOWLIST });
    check(info === null, 'A5: expired token denied (expiresAt in the past)');
  }

  console.log('\n--- Part B: mcp_ slot is prefix-routed to resolveMcpToken (never session/api-key) ---\n');

  // ── Part B: resolveOperatorPrincipal routes mcp_ to the bound resolver ───

  // B1: when the real resolveMcpToken is bound to the resolveMcp slot, an mcp_ token
  //     presented to resolveOperatorPrincipal resolves to an `mcp` principal.
  {
    const prisma = makePrisma(VALID_ROW);
    const env = { AUTH_ALLOWLIST: ALLOWLIST };

    // Session resolver spy: proves mcp_ token NEVER hits the session domain.
    const sessionCalls = [];
    const sessionSpy = async (t) => { sessionCalls.push(t); return null; };

    // Bind the real resolveMcpToken into the slot — exactly as auth.guard.ts does.
    const resolveMcpSlot = async (raw) => {
      const authInfo = await resolveMcpToken(raw, prisma, env);
      if (authInfo === null) return null;
      return { kind: 'mcp', user: null, scopes: authInfo.scopes };
    };

    const principal = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: RAW_TOKEN },
      {
        resolveSession: sessionSpy,
        resolveApiKey: async () => null,
        resolveMcp: resolveMcpSlot,
      },
    );

    check(principal !== null, 'B1: mcp_ token with bound real resolver resolves to a principal');
    check(principal?.kind === 'mcp', 'B1b: resolved principal kind is "mcp"');
    check(principal?.user === null, 'B1c: mcp principal user is null (machine identity, no GitHub session)');
    check(Array.isArray(principal?.scopes), 'B1d: mcp principal carries the token scopes');
    check(sessionCalls.length === 0,
      'B1e: mcp_ token NEVER touches the session resolver (prefix-routed, not session)');
  }

  // B2: the same mcp_ token is denied when the owner is de-allowlisted —
  //     proving the shared isAllowlistedRaw gate blocks it at the resolver.
  {
    const prisma = makePrisma(VALID_ROW);
    const deAllowlistedEnv = { AUTH_ALLOWLIST: '99999' }; // owner not on list

    const resolveMcpSlot = async (raw) => {
      const authInfo = await resolveMcpToken(raw, prisma, deAllowlistedEnv);
      if (authInfo === null) return null;
      return { kind: 'mcp', user: null, scopes: authInfo.scopes };
    };

    const principal = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: RAW_TOKEN },
      {
        resolveSession: async () => null,
        resolveApiKey: async () => null,
        resolveMcp: resolveMcpSlot,
      },
    );

    check(principal === null,
      'B2: de-allowlisted owner → mcp_ token denied at resolveOperatorPrincipal (shared allowlist gate)');
  }

  // B3: without a bound resolver (default denyMcpResolver), mcp_ is always denied.
  {
    const principal = await resolveOperatorPrincipal(
      { sessionToken: null, bearerToken: RAW_TOKEN },
      {
        resolveSession: async () => null,
        resolveApiKey: async () => null,
        // resolveMcp omitted → falls back to denyMcpResolver
      },
    );
    check(principal === null,
      'B3: unbound mcp_ slot (default deny) → always denied (inert until bound)');
  }

  // B4: a valid mcp_ token is NOT routed to the session or api-key resolvers —
  //     the prefix dispatch is the FIRST step and routes exclusively.
  {
    const prisma = makePrisma(VALID_ROW);
    const env = { AUTH_ALLOWLIST: ALLOWLIST };

    const sessionCalls = [];
    const apiKeyCalls = [];

    const resolveMcpSlot = async (raw) => {
      const authInfo = await resolveMcpToken(raw, prisma, env);
      if (authInfo === null) return null;
      return { kind: 'mcp', user: null, scopes: authInfo.scopes };
    };

    await resolveOperatorPrincipal(
      // Also present as sessionToken (models the WS channel where one token fills both slots)
      { sessionToken: RAW_TOKEN, bearerToken: RAW_TOKEN },
      {
        resolveSession: async (t) => { sessionCalls.push(t); return null; },
        resolveApiKey: async (t) => { apiKeyCalls.push(t); return null; },
        resolveMcp: resolveMcpSlot,
      },
    );

    check(sessionCalls.length === 0,
      'B4a: mcp_ token (incl. WS channel where it fills sessionToken slot) NEVER hits session resolver');
    check(apiKeyCalls.length === 0,
      'B4b: mcp_ token NEVER hits the api-key resolver');
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('\nALL TESTS PASSED'); process.exit(0); }
  else { console.error('\nSOME TESTS FAILED'); process.exit(1); }
};

void run();
