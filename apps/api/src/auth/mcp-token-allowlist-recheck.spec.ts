/**
 * Ground-truth test: "MCP token resolution re-confirms the owner's enabled state and
 * returns a full AuthInfo" (add-private-account-identity, task 2.5 / D2).
 *
 * The requirement:
 *   `resolveMcpToken` MUST re-check `User.allowed` on EVERY call (the pure-DB
 *   runtime gate introduced by add-private-account-identity), AND
 *   on success it MUST return a FULL `McpAuthInfo`:
 *     { token, clientId, scopes, expiresAt (number, seconds), resource, ownerGithubId }.
 *
 *   Concretely:
 *     - owner `allowed = true`  → resolves to a full AuthInfo (all fields populated).
 *     - owner `allowed = false` -> resolves to null (disable takes effect
 *       on the VERY NEXT request — no caching of a prior admit).
 *     - `ownerGithubId` is nullable: a local-account owner (no github identity)
 *       carries `null` and is still ADMITTED when `allowed = true`.
 *
 * Exercises the REAL `AuthSessionService.resolveMcpToken` against a fake Prisma
 * double that emits the `user.allowed` flag directly.  No DI container, no DB.
 *
 * Run from apps/api with: pnpm test
 * (pretest builds to dist/; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AuthSessionService, MCP_RESOURCE_URI } from './auth-session.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Shape of an McpToken row as resolveMcpToken reads it (with owner). */
interface FakeMcpTokenRow {
  id: string;
  tokenHash: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  user: {
    id: string;
    githubId: number | null;
    login: string;
    name: string;
    avatarUrl: string;
    allowed: boolean;
  };
}

/**
 * Build a minimal fake Prisma that returns `row` from `mcpToken.findUnique` and
 * absorbs the best-effort `lastUsedAt` bump (`mcpToken.update`).
 */
function makePrismaWithToken(row: FakeMcpTokenRow | null) {
  return {
    mcpToken: {
      findUnique: async (_args: unknown): Promise<FakeMcpTokenRow | null> => row,
      update: async (_args: unknown): Promise<FakeMcpTokenRow> => row as FakeMcpTokenRow,
    },
  };
}

/** Construct a real `AuthSessionService` over a fake Prisma. */
function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never);
}

// ---------------------------------------------------------------------------
// The raw token we present in each call.
// ---------------------------------------------------------------------------

const RAW_TOKEN = 'mcp_test_enabled_recheck_scenario';

/**
 * Build a reusable token row. `tokenHash` matches `RAW_TOKEN` exactly as
 * `resolveMcpToken` computes it (SHA-256 via `hashMcpTokenValue`).
 */
function tokenRow(
  allowed: boolean,
  opts: { githubId?: number | null; expiresAt?: Date | null; revokedAt?: Date | null } = {},
): FakeMcpTokenRow {
  return {
    id: 'mcp-tok-001',
    tokenHash: sha256Hex(RAW_TOKEN),
    scopes: ['tasks:read', 'tasks:write'],
    revokedAt: opts.revokedAt ?? null,
    expiresAt: opts.expiresAt ?? null, // no expiry → lifecycle is the allowed flag
    user: {
      id: 'acct-owner-001',
      githubId: opts.githubId !== undefined ? opts.githubId : 99999,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.test/a.png',
      allowed,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('resolveMcpToken: an allowed owner resolves to a FULL AuthInfo (all fields populated)', async () => {
  const svc = serviceOver(makePrismaWithToken(tokenRow(true)));

  const info = await svc.resolveMcpToken(RAW_TOKEN);

  assert.ok(info !== null, 'should resolve when owner.allowed is true');
  // Full AuthInfo — every field must be present and well-typed.
  assert.equal(info.token, RAW_TOKEN, 'AuthInfo.token echoes the presented raw token');
  assert.equal(info.clientId, 'settings', 'AuthInfo.clientId is "settings" (settings-minted model)');
  assert.deepEqual(info.scopes, ['tasks:read', 'tasks:write'], 'AuthInfo.scopes match the minted grant');
  // G1: expiresAt MUST be a number (seconds since epoch) — an undefined/null value
  // would cause the SDK requireBearerAuth to 401 EVERY valid token.
  assert.equal(typeof info.expiresAt, 'number', 'AuthInfo.expiresAt is a number (G1)');
  assert.ok(info.expiresAt > Math.floor(Date.now() / 1000), 'expiresAt is in the future (far-future fallback for no-expiry token)');
  assert.equal(info.resource, MCP_RESOURCE_URI, 'AuthInfo.resource is the canonical MCP resource URI');
  assert.equal(info.ownerGithubId, 99999, 'AuthInfo.ownerGithubId carries the owner github id');
  assert.equal(
    info.ownerId,
    'acct-owner-001',
    'AuthInfo.ownerId carries the owner ACCOUNT id (fix-local-account-task-attribution)',
  );
});

test('resolveMcpToken: a disabled owner resolves to null (DB allowed flag re-confirmed per call)', async () => {
  // Same token material, same DB record — ONLY the owner's `allowed` flag changed.
  // The add-private-account-identity requirement: resolveMcpToken re-checks
  // `user.allowed` on EVERY call.
  const svc = serviceOver(makePrismaWithToken(tokenRow(false)));

  const info = await svc.resolveMcpToken(RAW_TOKEN);

  assert.equal(
    info,
    null,
    'should return null when owner.allowed is false on the very next request',
  );
});

test('resolveMcpToken: allowed→null per-call — no caching of a prior admit', async () => {
  // Simulate two sequential requests using the same raw token.
  // Between request 1 and request 2, an admin sets `allowed = false`.

  // Request 1: owner is allowed → resolves.
  const svcAllowed = serviceOver(makePrismaWithToken(tokenRow(true)));
  const r1 = await svcAllowed.resolveMcpToken(RAW_TOKEN);
  assert.ok(r1 !== null, 'request 1: token resolves while owner is allowed');

  // Request 2: owner has been disabled -> same token, null result.
  const svcDenied = serviceOver(makePrismaWithToken(tokenRow(false)));
  const r2 = await svcDenied.resolveMcpToken(RAW_TOKEN);
  assert.equal(
    r2,
    null,
    'request 2: same token returns null after owner is disabled — no caching of the prior admit',
  );
});

test('resolveMcpToken: local-account owner (githubId null, allowed true) still resolves (full AuthInfo)', async () => {
  // add-private-account-identity: a token owned by a LOCAL account (password/OTP,
  // no github identity) carries ownerGithubId=null. It MUST still be admitted when
  // `allowed = true` — authority is `user.allowed`, not the presence of a github id.
  const svc = serviceOver(makePrismaWithToken(tokenRow(true, { githubId: null })));

  const info = await svc.resolveMcpToken(RAW_TOKEN);

  assert.ok(info !== null, 'local-account token resolves when owner.allowed is true');
  assert.equal(info.ownerGithubId, null, 'ownerGithubId is null for a local-account owner (nullable, best-effort attribution only)');
  // fix-local-account-task-attribution: even with NO github id, the account id is
  // present — this is what the task-attribution chain threads so a local account's
  // MCP task is owner-attributed and its stored Codex credential resolves.
  assert.equal(info.ownerId, 'acct-owner-001', 'ownerId (account primary key) is present for a local-account owner');
  // The full AuthInfo is still returned.
  assert.equal(info.clientId, 'settings');
  assert.equal(typeof info.expiresAt, 'number');
  assert.equal(info.resource, MCP_RESOURCE_URI);
});

test('resolveMcpToken: local-account owner (githubId null, allowed false) is denied', async () => {
  const svc = serviceOver(makePrismaWithToken(tokenRow(false, { githubId: null })));
  const info = await svc.resolveMcpToken(RAW_TOKEN);
  assert.equal(info, null, 'local-account token is denied when owner.allowed is false');
});

test('resolveMcpToken: an explicit expiresAt is returned as seconds-since-epoch in AuthInfo (G1)', async () => {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
  const svc = serviceOver(makePrismaWithToken(tokenRow(true, { expiresAt })));

  const info = await svc.resolveMcpToken(RAW_TOKEN);

  assert.ok(info !== null);
  assert.equal(
    info.expiresAt,
    Math.floor(expiresAt.getTime() / 1000),
    'expiresAt is the stored value converted to seconds (G1)',
  );
});

test('resolveMcpToken: a revoked token resolves to null regardless of allowed flag', async () => {
  const svc = serviceOver(makePrismaWithToken(tokenRow(true, { revokedAt: new Date(Date.now() - 1000) })));
  assert.equal(await svc.resolveMcpToken(RAW_TOKEN), null, 'revoked token is always null');
});

test('resolveMcpToken: an expired token resolves to null regardless of allowed flag', async () => {
  const svc = serviceOver(makePrismaWithToken(tokenRow(true, { expiresAt: new Date(Date.now() - 1000) })));
  assert.equal(await svc.resolveMcpToken(RAW_TOKEN), null, 'expired token is always null');
});

test('resolveMcpToken: an unknown token (hash miss) resolves to null', async () => {
  const svc = serviceOver(makePrismaWithToken(null)); // findUnique returns null
  assert.equal(
    await svc.resolveMcpToken('mcp_completely_unknown'),
    null,
    'unrecognised token (no hash match) is null',
  );
});
