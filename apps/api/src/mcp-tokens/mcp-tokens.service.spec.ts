/**
 * MCP-token SERVICE spec (remote-mcp-server, task 3.1; supports 3.7's no-leak
 * guarantee at the source).
 *
 * Drives the REAL `McpTokensService` against a fake Prisma to pin the credential
 * lifecycle that is the security contract of the settings-minted `mcp_` token:
 *
 *   - mint: returns the raw `mcp_…` value EXACTLY ONCE; persists ONLY the SHA-256
 *     hash (never the raw token) + the display prefix/last4 + scopes; binds to
 *     the caller's OWN user row resolved from the immutable githubId.
 *   - list: projects ONLY non-secret metadata (prefix + last4, scopes,
 *     lifecycle timestamps) — never the raw token or its stored hash.
 *   - revoke: idempotent (`revokedAt` stamped once, preserved on a repeat call),
 *     own-scoped, and returns the post-revocation list view.
 *
 * Run from apps/api with: pnpm test
 * (pretest compiles to dist/ via nest build; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { McpTokensService } from './mcp-tokens.service';

const GITHUB_ID = 12345;
const USER_ROW_ID = 'user-row-1';

interface StoredToken {
  id: string;
  userId: string;
  tokenHash: string;
  prefix: string;
  last4: string;
  name: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * An in-memory Prisma double covering exactly the surface the service touches:
 * `user.findUnique` (resolve the owning row id), and `mcpToken` create / findMany
 * / findFirst / update. It records persisted rows so the test can assert the
 * stored shape (hash-only) and the idempotent revoke.
 */
function makePrisma(opts: { userExists?: boolean } = {}) {
  const rows: StoredToken[] = [];
  let seq = 0;
  return {
    rows,
    user: {
      findUnique: async (_args: unknown) =>
        opts.userExists === false ? null : { id: USER_ROW_ID },
    },
    mcpToken: {
      create: async ({
        data,
      }: {
        data: Omit<StoredToken, 'id' | 'createdAt' | 'lastUsedAt' | 'revokedAt'>;
      }) => {
        const row: StoredToken = {
          ...data,
          id: `tok-${++seq}`,
          createdAt: new Date(),
          // Prisma defaults: never-used / not-revoked until set.
          lastUsedAt: null,
          revokedAt: null,
        };
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { userId: string } }) =>
        rows.filter((r) => r.userId === where.userId),
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<StoredToken> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
}

function service(prisma: unknown): McpTokensService {
  return new McpTokensService(prisma as never);
}

test('mint: returns the raw mcp_ token ONCE and persists only its SHA-256 hash', async () => {
  const prisma = makePrisma();
  const res = await service(prisma).mint(GITHUB_ID, {
    name: 'CI token',
    scopes: ['tasks:read', 'tasks:write'],
  });

  // The response carries the raw token exactly once, with the reserved prefix.
  assert.ok(res.token.startsWith('mcp_'), 'raw token has the mcp_ prefix');
  assert.equal(res.prefix, 'mcp_');
  assert.equal(res.last4, res.token.slice(-4));
  assert.deepEqual(res.scopes, ['tasks:read', 'tasks:write']);
  assert.equal(res.expiresAt, null);

  // The PERSISTED row stores only the hash — never the raw token.
  assert.equal(prisma.rows.length, 1);
  const stored = prisma.rows[0];
  assert.equal(stored.userId, USER_ROW_ID, 'bound to the caller own user row');
  assert.equal(
    stored.tokenHash,
    createHash('sha256').update(res.token, 'utf8').digest('hex'),
    'stored hash is SHA-256 of the raw token',
  );
  assert.notEqual(stored.tokenHash, res.token, 'the raw token is never stored');
  assert.ok(!('token' in stored), 'no raw-token column on the persisted row');
});

test('mint: an absolute expiry is persisted and echoed back as ISO-8601', async () => {
  const prisma = makePrisma();
  const expiry = '2099-01-01T00:00:00.000Z';
  const res = await service(prisma).mint(GITHUB_ID, {
    name: 'expiring',
    scopes: ['repos:read'],
    expiresAt: expiry,
  });
  assert.equal(res.expiresAt, expiry);
  assert.equal(prisma.rows[0].expiresAt?.toISOString(), expiry);
});

test('mint: a missing operator account is a 404 (no orphaned token)', async () => {
  const prisma = makePrisma({ userExists: false });
  const status = await service(prisma)
    .mint(GITHUB_ID, { name: 'x', scopes: ['tasks:read'] })
    .then(() => 0, (e: { getStatus?: () => number }) => e.getStatus?.() ?? -1);
  assert.equal(status, 404);
  assert.equal(prisma.rows.length, 0, 'nothing persisted on a missing account');
});

test('list: projects only non-secret metadata (prefix + last4, scopes, timestamps) — never raw/hash', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const minted = await svc.mint(GITHUB_ID, { name: 'A', scopes: ['tasks:read'] });

  const items = await svc.list(GITHUB_ID);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.id, minted.id);
  assert.equal(item.prefix, 'mcp_');
  assert.equal(item.last4, minted.last4);
  assert.deepEqual(item.scopes, ['tasks:read']);
  assert.equal(item.lastUsedAt, null);
  assert.equal(item.revokedAt, null);

  // No secret material in the projected shape.
  const serialized = JSON.stringify(item);
  assert.ok(!serialized.includes(minted.token), 'list item never contains the raw token');
  assert.ok(!/hash/i.test(serialized), 'list item has no hash field');
});

test('revoke: idempotent — stamps revokedAt once, preserves it on a repeat call', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const minted = await svc.mint(GITHUB_ID, { name: 'B', scopes: ['tasks:read'] });

  const first = await svc.revoke(GITHUB_ID, minted.id);
  assert.ok(first, 'revoke returns the post-revocation view');
  assert.ok(first!.revokedAt, 'revokedAt is now set');
  const firstRevokedAt = first!.revokedAt;

  const second = await svc.revoke(GITHUB_ID, minted.id);
  assert.equal(second!.revokedAt, firstRevokedAt, 'a repeat revoke preserves the original instant');
});

test('revoke: an unknown / foreign id returns null (own-scoped, no mutation)', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  await svc.mint(GITHUB_ID, { name: 'C', scopes: ['tasks:read'] });

  assert.equal(await svc.revoke(GITHUB_ID, 'does-not-exist'), null);
  assert.equal(prisma.rows[0].revokedAt, null, 'the existing token is untouched');
});
