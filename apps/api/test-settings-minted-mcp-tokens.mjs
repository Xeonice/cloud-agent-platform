/**
 * Minimal ground-truth test: "Settings-minted MCP tokens" (remote-mcp-server).
 *
 * Exercises the core round-trip:
 *   1. Mint a token via McpTokensService.mint() → raw `mcp_` value returned once,
 *      only the SHA-256 hash persisted (never the raw token).
 *   2. Resolve the minted token via AuthSessionService.resolveMcpToken() →
 *      a full McpAuthInfo with expiresAt set (G1 mandatory), scopes, clientId,
 *      and resource; allowlist re-confirmed per request.
 *   3. A REVOKED token resolves to null (never admitted).
 *   4. A de-allowlisted owner is denied on the next resolve call.
 *
 * Runs against the compiled dist/ (no Nest container, no DB).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, 'dist');

const { McpTokensService, hashMcpToken } =
  require(path.join(DIST, 'mcp-tokens/mcp-tokens.service.js'));
const { AuthSessionService } =
  require(path.join(DIST, 'auth/auth-session.service.js'));

// ---- shared constants -------------------------------------------------------

const GITHUB_ID = 42000;
const USER_ROW_ID = 'user-42';
// AUTH_ALLOWLIST containing the owning operator's numeric id.
const ALLOWLIST_ENV = { AUTH_ALLOWLIST: String(GITHUB_ID) };

// ---- in-memory Prisma double ------------------------------------------------

/**
 * Shared store so McpTokensService (writes) and AuthSessionService (reads the
 * same rows) use a single source of truth, exactly as the real DB does.
 */
function makeSharedStore() {
  let seq = 0;
  const rows = [];

  const user = {
    findUnique: async () => ({ id: USER_ROW_ID }),
  };

  const mcpToken = {
    create: async ({ data }) => {
      const row = {
        ...data,
        id: `tok-${++seq}`,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
        // expiresAt may be null (not-expiring token).
      };
      rows.push(row);
      return row;
    },
    findMany: async ({ where }) =>
      rows.filter((r) => r.userId === where.userId),
    findFirst: async ({ where }) =>
      rows.find((r) =>
        (!where.id || r.id === where.id) &&
        (!where.userId || r.userId === where.userId)
      ) ?? null,
    findUnique: async ({ where }) => {
      const row = rows.find((r) => r.tokenHash === where.tokenHash) ?? null;
      if (!row) return null;
      // Simulate Prisma's `include: { user: true }` — attach the owner user object.
      return { ...row, user: { githubId: GITHUB_ID } };
    },
    update: async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
  };

  return { rows, user, mcpToken };
}

// ---- test harness -----------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ---- tests ------------------------------------------------------------------

const run = async () => {
  console.log('\n=== Settings-minted MCP tokens: ground-truth scenario test ===\n');

  const prisma = makeSharedStore();
  const mintSvc = new McpTokensService(prisma);
  const authSvc = new AuthSessionService(prisma);

  // ---- T1: Mint returns the raw token ONCE; only the SHA-256 hash is stored ----
  const mintResult = await mintSvc.mint(GITHUB_ID, {
    name: 'cursor-token',
    scopes: ['tasks:read', 'tasks:write'],
  });

  assert(
    typeof mintResult.token === 'string' && mintResult.token.startsWith('mcp_'),
    'T1a: mint returns a raw mcp_-prefixed token',
  );
  assert(mintResult.prefix === 'mcp_', 'T1b: prefix field is mcp_');
  assert(
    mintResult.last4 === mintResult.token.slice(-4),
    'T1c: last4 matches the trailing 4 chars of the raw token',
  );
  assert(
    prisma.rows.length === 1,
    'T1d: exactly one row persisted',
  );

  const storedRow = prisma.rows[0];
  const expectedHash = createHash('sha256')
    .update(mintResult.token, 'utf8')
    .digest('hex');
  assert(
    storedRow.tokenHash === expectedHash,
    'T1e: persisted tokenHash is the SHA-256 of the raw token',
  );
  assert(
    storedRow.tokenHash !== mintResult.token,
    'T1f: raw token is NEVER the stored value (hash-only)',
  );
  assert(
    !('token' in storedRow),
    'T1g: no "token" column on the persisted row',
  );
  assert(mintResult.expiresAt === null, 'T1h: no-expiry token returns null expiresAt');

  // ---- T2: resolveMcpToken returns a full AuthInfo (G1: expiresAt is set) ----
  const authInfo = await authSvc.resolveMcpToken(
    mintResult.token,
    ALLOWLIST_ENV,
  );

  assert(authInfo !== null, 'T2a: valid token resolves to a non-null AuthInfo');
  assert(
    typeof authInfo.expiresAt === 'number' && authInfo.expiresAt > 0,
    'T2b: G1 satisfied — expiresAt is a positive integer (seconds since epoch, never unset)',
  );
  assert(
    authInfo.clientId === 'settings',
    'T2c: clientId is "settings" (settings-minted model)',
  );
  assert(
    Array.isArray(authInfo.scopes) &&
      authInfo.scopes.includes('tasks:read') &&
      authInfo.scopes.includes('tasks:write'),
    'T2d: granted scopes carried onto the AuthInfo',
  );
  assert(
    authInfo.token === mintResult.token,
    'T2e: the raw token is echoed back in the AuthInfo (for SDK use)',
  );
  assert(
    typeof authInfo.resource === 'string' && authInfo.resource.length > 0,
    'T2f: resource URI is present',
  );
  assert(
    authInfo.ownerGithubId === GITHUB_ID,
    'T2g: ownerGithubId matches the minting operator',
  );

  // ---- T3: a REVOKED token resolves to null ----
  await mintSvc.revoke(GITHUB_ID, mintResult.id);
  const afterRevoke = await authSvc.resolveMcpToken(mintResult.token, ALLOWLIST_ENV);
  assert(
    afterRevoke === null,
    'T3: revoked token is rejected (resolves to null)',
  );

  // ---- T4: de-allowlisted owner is denied on the next resolve call ----
  // Mint a fresh (non-revoked) token.
  const mint2 = await mintSvc.mint(GITHUB_ID, {
    name: 'cursor-token-2',
    scopes: ['tasks:read'],
  });
  // Token resolves fine while owner is allowlisted.
  const beforeDeAllowlist = await authSvc.resolveMcpToken(mint2.token, ALLOWLIST_ENV);
  assert(beforeDeAllowlist !== null, 'T4a: token resolves while owner is allowlisted');

  // Owner removed from allowlist.
  const afterDeAllowlist = await authSvc.resolveMcpToken(mint2.token, {
    AUTH_ALLOWLIST: '99999', // owner's id not listed
  });
  assert(
    afterDeAllowlist === null,
    'T4b: de-allowlisted owner is denied on the very next resolve call',
  );

  // ---- T5: an unknown / garbage token resolves to null ----
  const unknown = await authSvc.resolveMcpToken('mcp_totally_fake', ALLOWLIST_ENV);
  assert(unknown === null, 'T5: unknown token resolves to null');

  // ---- summary ----
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  }
};

void run();
