/**
 * MCP-token SERVICE spec (remote-mcp-server, task 3.1; supports 3.7's no-leak
 * guarantee at the source; fix-local-account-mcp-token-scope).
 *
 * Drives the REAL `McpTokensService` against a fake Prisma to pin the credential
 * lifecycle that is the security contract of the settings-minted `mcp_` token:
 *
 *   - mint: returns the raw `mcp_…` value EXACTLY ONCE; persists ONLY the SHA-256
 *     hash (never the raw token) + the display prefix/last4 + scopes; binds to
 *     the caller's OWN user row via the account primary key `userId` (a string,
 *     present for BOTH local and GitHub accounts — no GitHub identity required).
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
import { ServiceUnavailableException } from '@nestjs/common';

import { McpTokensService } from './mcp-tokens.service';
import type { TaskProvisioningDiagnosticsCapabilityGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-deployment-gate.port';

// The account primary key is the per-account scope key for BOTH a GitHub account
// (githubId present) and a LOCAL account (githubId null) — the service only ever
// sees the resolved string `userId`, never the GitHub identity.
const USER_A = 'user-row-a';
const USER_B = 'user-row-b';

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
 * `mcpToken` create / findMany / findFirst / update. The service is now keyed on
 * the account primary key `userId` (the FK) directly, so there is NO
 * `user.findUnique` reverse lookup to fake (McpToken is FK on user_id). It
 * records persisted rows so the test can assert the stored shape (hash-only),
 * the per-account scoping, and the idempotent revoke.
 */
function makePrisma() {
  const rows: StoredToken[] = [];
  let seq = 0;
  return {
    rows,
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

function service(
  prisma: unknown,
  gate?: TaskProvisioningDiagnosticsCapabilityGatePort,
): McpTokensService {
  return new McpTokensService(prisma as never, gate);
}

test('mint: returns the raw mcp_ token ONCE and persists only its SHA-256 hash', async () => {
  const prisma = makePrisma();
  const res = await service(prisma).mint(USER_A, {
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
  assert.equal(stored.userId, USER_A, 'bound to the caller own user row');
  assert.equal(
    stored.tokenHash,
    createHash('sha256').update(res.token, 'utf8').digest('hex'),
    'stored hash is SHA-256 of the raw token',
  );
  assert.notEqual(stored.tokenHash, res.token, 'the raw token is never stored');
  assert.ok(!('token' in stored), 'no raw-token column on the persisted row');
});

test('diagnostics grant is default-closed and persists no MCP token', async () => {
  const prisma = makePrisma();

  await assert.rejects(
    () =>
      service(prisma).mint(USER_A, {
        name: 'too-early diagnostics client',
        scopes: ['tasks:diagnostics'],
      }),
    ServiceUnavailableException,
  );
  assert.equal(prisma.rows.length, 0);
});

test('open shared deployment gate permits explicit MCP diagnostics grant and preserves old scopes exactly', async () => {
  const prisma = makePrisma();
  const openGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => undefined,
    assertScopesGrantable: () => undefined,
  };
  const svc = service(prisma, openGate);

  const oldToken = await svc.mint(USER_A, {
    name: 'existing MCP reader',
    scopes: ['tasks:read'],
  });
  const diagnosticsToken = await svc.mint(USER_A, {
    name: 'diagnostics MCP reader',
    scopes: ['tasks:read', 'tasks:diagnostics'],
  });

  assert.deepEqual(prisma.rows.map((row) => row.scopes), [
    ['tasks:read'],
    ['tasks:read', 'tasks:diagnostics'],
  ]);
  assert.deepEqual(oldToken.scopes, ['tasks:read']);
  assert.equal(oldToken.scopes.includes('tasks:diagnostics'), false);
  assert.deepEqual(diagnosticsToken.scopes, [
    'tasks:read',
    'tasks:diagnostics',
  ]);
});

test('a failing deployment gate fails closed before MCP-token persistence', async () => {
  const prisma = makePrisma();
  const failingGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => {
      throw new Error('attestation unavailable');
    },
    assertScopesGrantable: () => {
      throw new Error('attestation unavailable');
    },
  };

  await assert.rejects(
    () =>
      service(prisma, failingGate).mint(USER_A, {
        name: 'must not exist',
        scopes: ['tasks:diagnostics'],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      });
      assert.equal(JSON.stringify(error.getResponse()).includes('attestation'), false);
      return true;
    },
  );
  assert.equal(prisma.rows.length, 0);
});

test('an unavailable deployment gate does not affect ordinary MCP-token scopes', async () => {
  const prisma = makePrisma();
  const unavailableGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => {
      throw new Error('attestation unavailable');
    },
    assertScopesGrantable: () => {
      throw new Error('attestation unavailable');
    },
  };

  const minted = await service(prisma, unavailableGate).mint(USER_A, {
    name: 'ordinary reader',
    scopes: ['tasks:read'],
  });
  assert.deepEqual(minted.scopes, ['tasks:read']);
  assert.deepEqual(prisma.rows.map((row) => row.scopes), [['tasks:read']]);
});

test('mint: a LOCAL account (no GitHub identity) mints bound to its own user row', async () => {
  // The service is keyed on the account primary key `userId`, never on a GitHub
  // identity — a local (password/OTP) account whose githubId is null reaches here
  // with its resolved string id and mints normally.
  const prisma = makePrisma();
  const res = await service(prisma).mint(USER_A, {
    name: 'local-account token',
    scopes: ['tasks:read'],
  });
  assert.ok(res.token.startsWith('mcp_'));
  assert.equal(prisma.rows.length, 1);
  assert.equal(prisma.rows[0].userId, USER_A, 'bound to the local account own row');
});

test('mint: an absolute expiry is persisted and echoed back as ISO-8601', async () => {
  const prisma = makePrisma();
  const expiry = '2099-01-01T00:00:00.000Z';
  const res = await service(prisma).mint(USER_A, {
    name: 'expiring',
    scopes: ['repos:read'],
    expiresAt: expiry,
  });
  assert.equal(res.expiresAt, expiry);
  assert.equal(prisma.rows[0].expiresAt?.toISOString(), expiry);
});

test('list: projects only non-secret metadata (prefix + last4, scopes, timestamps) — never raw/hash', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const minted = await svc.mint(USER_A, { name: 'A', scopes: ['tasks:read'] });

  const items = await svc.list(USER_A);
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

test('list: per-account isolation — A never sees B tokens (and vice versa)', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const a = await svc.mint(USER_A, { name: 'a-token', scopes: ['tasks:read'] });
  const b = await svc.mint(USER_B, { name: 'b-token', scopes: ['tasks:read'] });

  const aList = await svc.list(USER_A);
  assert.deepEqual(
    aList.map((t) => t.id),
    [a.id],
    'A sees only its own token',
  );

  const bList = await svc.list(USER_B);
  assert.deepEqual(
    bList.map((t) => t.id),
    [b.id],
    'B sees only its own token',
  );
});

test('revoke: idempotent — stamps revokedAt once, preserves it on a repeat call', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const minted = await svc.mint(USER_A, { name: 'B', scopes: ['tasks:read'] });

  const first = await svc.revoke(USER_A, minted.id);
  assert.ok(first, 'revoke returns the post-revocation view');
  assert.ok(first!.revokedAt, 'revokedAt is now set');
  const firstRevokedAt = first!.revokedAt;

  const second = await svc.revoke(USER_A, minted.id);
  assert.equal(second!.revokedAt, firstRevokedAt, 'a repeat revoke preserves the original instant');
});

test('revoke: an unknown / foreign id returns null (own-scoped, no mutation)', async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  await svc.mint(USER_A, { name: 'C', scopes: ['tasks:read'] });

  assert.equal(await svc.revoke(USER_A, 'does-not-exist'), null);
  assert.equal(prisma.rows[0].revokedAt, null, 'the existing token is untouched');
});

test("revoke: another account cannot revoke A's token (own-scoped)", async () => {
  const prisma = makePrisma();
  const svc = service(prisma);
  const a = await svc.mint(USER_A, { name: 'a-token', scopes: ['tasks:read'] });

  // B presents A's token id — own-scoped, so it is a no-op returning null.
  assert.equal(await svc.revoke(USER_B, a.id), null, 'B cannot revoke A token');
  assert.equal(prisma.rows[0].revokedAt, null, "A's token is untouched");
});
