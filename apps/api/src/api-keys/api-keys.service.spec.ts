/**
 * Tests for the API-key CRUD surface (api-key-machine-identity, task 5.3).
 *
 * Asserts the three load-bearing requirements:
 *   1. NO ESCALATION CHAIN — an `api-key` principal (and any non-`session`
 *      principal: legacy/mcp) cannot mint/list/revoke; only a human `session`
 *      principal reaches the service. Tested at the controller's
 *      session-only gate.
 *   2. NO LEAK — neither the raw key value nor the stored SHA-256 hash ever
 *      appears in a list (or revoke) response; mint persists ONLY the hash.
 *   3. MINT-ONCE — mint returns the raw `cap_sk_…` key exactly once; the
 *      persisted record stores its hash, not the raw value.
 *
 * Exercises {@link ApiKeysService} with a fake Prisma and {@link ApiKeysController}
 * with synthesized principals — no DB, no DI container — so it runs under
 * `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { API_KEY_PREFIX } from '@cap/contracts';

import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { TaskProvisioningDiagnosticsCapabilityGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-deployment-gate.port';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const GITHUB_ID = 4242;
const USER_ID = '00000000-0000-4000-a000-000000000001';
// A LOCAL (password/OTP) account: authenticated + allowed but githubId === null.
// fix-local-account-api-keys-scope must let it mint/list/revoke keyed on user.id.
const LOCAL_USER_ID = '00000000-0000-4000-a000-000000000002';

interface ApiKeyRow {
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

/** Minimal in-memory fake Prisma covering the `user` + `apiKey` delegates used. */
function makeFakePrisma(): {
  prisma: PrismaService;
  rows: ApiKeyRow[];
} {
  const rows: ApiKeyRow[] = [];
  let seq = 0;

  const prisma = {
    apiKey: {
      create: async ({
        data,
      }: {
        data: {
          userId: string;
          tokenHash: string;
          prefix: string;
          last4: string;
          name: string;
          scopes: string[];
          expiresAt?: Date | null;
        };
      }) => {
        seq += 1;
        const row: ApiKeyRow = {
          id: `00000000-0000-4000-a000-00000000010${seq}`,
          userId: data.userId,
          tokenHash: data.tokenHash,
          prefix: data.prefix,
          last4: data.last4,
          name: data.name,
          scopes: data.scopes,
          lastUsedAt: null,
          expiresAt: data.expiresAt ?? null,
          revokedAt: null,
          createdAt: new Date(Date.now() + seq),
        };
        rows.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { userId: string } }) =>
        rows
          .filter((r) => r.userId === where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<ApiKeyRow> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('no such row');
        Object.assign(row, data);
        return row;
      },
    },
  } as unknown as PrismaService;

  return { prisma, rows };
}

function sessionRequest(): AuthenticatedRequest {
  const principal: OperatorPrincipal = {
    kind: 'session',
    user: {
      id: USER_ID,
      githubId: GITHUB_ID,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.test/a.png',
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

/**
 * A LOCAL (password/OTP) account session: authenticated + allowed but with NO
 * github identity (`githubId === null`, `login === null`). fix-local-account-
 * api-keys-scope: it must reach the api-key surface and be scoped on its own
 * `user.id`, exactly like a GitHub account.
 */
function localSessionRequest(userId = LOCAL_USER_ID): AuthenticatedRequest {
  const principal: OperatorPrincipal = {
    kind: 'session',
    user: {
      id: userId,
      githubId: null,
      login: null,
      name: 'local@example.test',
      avatarUrl: null,
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
  };
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

function principalRequest(principal: OperatorPrincipal | undefined): AuthenticatedRequest {
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// 5.3 — mint returns the raw key exactly once; only the hash is persisted
// ---------------------------------------------------------------------------

test('mint returns the raw cap_sk_ key once and persists only its hash', async () => {
  const { prisma, rows } = makeFakePrisma();
  const service = new ApiKeysService(prisma);

  const res = await service.mint(USER_ID, { name: 'ci', scopes: ['tasks:read'] });

  // The raw key is returned, carries the reserved prefix, and is high-entropy.
  assert.ok(res.key.startsWith(API_KEY_PREFIX), 'raw key carries the reserved prefix');
  assert.ok(res.key.length > API_KEY_PREFIX.length + 20, 'raw key body is non-trivial');
  assert.equal(res.last4, res.key.slice(-4), 'last4 mirrors the raw key suffix');
  assert.equal(res.prefix, API_KEY_PREFIX);

  // Exactly one record, storing the HASH of the raw key — never the raw key.
  assert.equal(rows.length, 1);
  const stored = rows[0];
  assert.equal(stored.tokenHash, sha256Hex(res.key), 'persists SHA-256 hash of the raw key');
  assert.notEqual(stored.tokenHash, res.key, 'stored value is NOT the raw key');
  assert.ok(
    !Object.values(stored).includes(res.key),
    'the raw key value appears in NO persisted column',
  );

  // Two mints yield two distinct keys (fresh entropy each time).
  const res2 = await service.mint(USER_ID, { name: 'ci2', scopes: ['tasks:read'] });
  assert.notEqual(res2.key, res.key, 'each mint generates a fresh raw key');
});

test('diagnostics grant is default-closed and persists nothing before deployment compatibility', async () => {
  const { prisma, rows } = makeFakePrisma();
  const service = new ApiKeysService(prisma);

  await assert.rejects(
    () =>
      service.mint(USER_ID, {
        name: 'too-early diagnostics key',
        scopes: ['tasks:diagnostics'],
      }),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      });
      return true;
    },
  );
  assert.equal(rows.length, 0, 'no credential exists while the gate is closed');
});

test('open shared deployment gate permits an explicit diagnostics grant without widening old keys', async () => {
  const { prisma, rows } = makeFakePrisma();
  const openGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => undefined,
    assertScopesGrantable: () => undefined,
  };
  const service = new ApiKeysService(prisma, openGate);

  const oldKey = await service.mint(USER_ID, {
    name: 'old reader',
    scopes: ['tasks:read'],
  });
  const diagnosticsKey = await service.mint(USER_ID, {
    name: 'diagnostics reader',
    scopes: ['tasks:read', 'tasks:diagnostics'],
  });

  assert.deepEqual(rows.map((row) => row.scopes), [
    ['tasks:read'],
    ['tasks:read', 'tasks:diagnostics'],
  ]);
  assert.deepEqual(oldKey.scopes, ['tasks:read']);
  assert.equal(oldKey.scopes.includes('tasks:diagnostics'), false);
  assert.deepEqual(diagnosticsKey.scopes, [
    'tasks:read',
    'tasks:diagnostics',
  ]);
});

test('a failing deployment gate fails closed before API-key persistence', async () => {
  const { prisma, rows } = makeFakePrisma();
  const failingGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => {
      throw new Error('attestation unavailable');
    },
    assertScopesGrantable: () => {
      throw new Error('attestation unavailable');
    },
  };
  const service = new ApiKeysService(prisma, failingGate);

  await assert.rejects(
    () =>
      service.mint(USER_ID, {
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
  assert.equal(rows.length, 0);
});

test('an unavailable deployment gate does not affect ordinary API-key scopes', async () => {
  const { prisma, rows } = makeFakePrisma();
  const unavailableGate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen: () => {
      throw new Error('attestation unavailable');
    },
    assertScopesGrantable: () => {
      throw new Error('attestation unavailable');
    },
  };
  const service = new ApiKeysService(prisma, unavailableGate);

  const minted = await service.mint(USER_ID, {
    name: 'ordinary reader',
    scopes: ['tasks:read'],
  });
  assert.deepEqual(minted.scopes, ['tasks:read']);
  assert.deepEqual(rows.map((row) => row.scopes), [['tasks:read']]);
});

// ---------------------------------------------------------------------------
// 5.3 — list responses never leak the raw key or the stored hash
// ---------------------------------------------------------------------------

test('list exposes only non-secret metadata — never the raw key or hash', async () => {
  const { prisma } = makeFakePrisma();
  const service = new ApiKeysService(prisma);

  const minted = await service.mint(USER_ID, {
    name: 'reader',
    scopes: ['tasks:read', 'repos:read'],
  });

  const items = await service.list(USER_ID);
  assert.equal(items.length, 1);
  const item = items[0];

  // The list item carries id/name/scopes/prefix/last4 + nullable timestamps.
  assert.deepEqual(item.scopes, ['tasks:read', 'repos:read']);
  assert.equal(item.prefix, API_KEY_PREFIX);
  assert.equal(item.last4, minted.last4);
  assert.equal(item.lastUsedAt, null);
  assert.equal(item.revokedAt, null);

  // Neither the raw key value NOR the stored hash appears anywhere in the item.
  const serialized = JSON.stringify(item);
  assert.ok(!serialized.includes(minted.key), 'raw key absent from list response');
  assert.ok(
    !serialized.includes(sha256Hex(minted.key)),
    'stored hash absent from list response',
  );
  assert.ok(!('key' in item), 'no raw-key field on a list item');
  assert.ok(!('tokenHash' in item), 'no tokenHash field on a list item');
});

// ---------------------------------------------------------------------------
// 5.3 — revoke is idempotent and the revoked view still leaks nothing
// ---------------------------------------------------------------------------

test('revoke is idempotent and the revoked view leaks neither key nor hash', async () => {
  const { prisma } = makeFakePrisma();
  const service = new ApiKeysService(prisma);

  const minted = await service.mint(USER_ID, { name: 'doomed', scopes: ['tasks:write'] });
  const id = minted.id;

  const first = await service.revoke(USER_ID, id);
  assert.ok(first.revokedAt !== null, 'first revoke stamps revokedAt');

  const second = await service.revoke(USER_ID, id);
  assert.equal(second.revokedAt, first.revokedAt, 'idempotent: timestamp is stable on re-revoke');

  const serialized = JSON.stringify(second);
  assert.ok(!serialized.includes(minted.key), 'raw key absent from revoke response');
  assert.ok(
    !serialized.includes(sha256Hex(minted.key)),
    'stored hash absent from revoke response',
  );
});

// ---------------------------------------------------------------------------
// 5.3 — no escalation chain: a non-session principal cannot mint/list/revoke
// ---------------------------------------------------------------------------

test('an api-key principal cannot mint/list/revoke (no escalation chain)', async () => {
  const { prisma, rows } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));

  const apiKeyPrincipal: OperatorPrincipal = {
    kind: 'api-key',
    user: {
      id: `user-${GITHUB_ID}`,
      githubId: GITHUB_ID,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.test/a.png',
      allowed: true,
      role: 'member',
      mustChangePassword: false,
    },
    scopes: ['tasks:read'],
    keyId: 'some-key-id',
  };
  const req = principalRequest(apiKeyPrincipal);

  await assert.rejects(
    () => controller.mint(req, { name: 'evil', scopes: ['tasks:write'] }),
    ForbiddenException,
    'api-key principal is 403 on mint',
  );
  await assert.rejects(() => controller.list(req), ForbiddenException, 'api-key principal is 403 on list');
  await assert.rejects(
    () => controller.revoke(req, 'whatever'),
    ForbiddenException,
    'api-key principal is 403 on revoke',
  );

  // Crucially, no key was ever created by the rejected escalation attempt.
  assert.equal(rows.length, 0, 'no key minted by a non-session principal');
});

test('legacy and mcp principals (and a missing principal) are also 403 on CRUD', async () => {
  const { prisma } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));

  const legacy: OperatorPrincipal = { kind: 'legacy-token', user: null };
  const mcp: OperatorPrincipal = { kind: 'mcp', user: null, scopes: ['tasks:read'] };

  for (const principal of [legacy, mcp, undefined]) {
    const req = principalRequest(principal);
    await assert.rejects(
      () => controller.mint(req, { name: 'x', scopes: ['tasks:read'] }),
      ForbiddenException,
    );
    await assert.rejects(() => controller.list(req), ForbiddenException);
  }
});

// ---------------------------------------------------------------------------
// 5.3 — a session principal DOES reach the service and gets a working surface
// ---------------------------------------------------------------------------

test('a session principal can mint, list, and revoke its own keys', async () => {
  const { prisma } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));
  const req = sessionRequest();

  const mintRes = await controller.mint(req, { name: 'ok', scopes: ['tasks:read'] });
  assert.ok(mintRes.key.startsWith(API_KEY_PREFIX));

  const listRes = await controller.list(req);
  assert.equal(listRes.keys.length, 1);
  assert.equal(listRes.keys[0].id, mintRes.id);

  const revokeRes = await controller.revoke(req, mintRes.id);
  assert.ok(revokeRes.key.revokedAt !== null, 'session revoke stamps revokedAt');
});

// ---------------------------------------------------------------------------
// fix-local-account-api-keys-scope — a LOCAL account (githubId === null) can
// mint, list, and revoke its own keys, scoped on user.id (no github required)
// ---------------------------------------------------------------------------

test('a local account (githubId null) can mint, list, and revoke its own keys', async () => {
  const { prisma, rows } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));
  const req = localSessionRequest();

  const mintRes = await controller.mint(req, { name: 'local-key', scopes: ['tasks:read'] });
  assert.ok(mintRes.key.startsWith(API_KEY_PREFIX), 'local account mints a real key');

  // The persisted row is owned by the local account's own user.id — no reverse
  // lookup, no github identity involved.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, LOCAL_USER_ID, 'key is FK-owned by the local user.id');

  const listRes = await controller.list(req);
  assert.equal(listRes.keys.length, 1);
  assert.equal(listRes.keys[0].id, mintRes.id);

  const revokeRes = await controller.revoke(req, mintRes.id);
  assert.ok(revokeRes.key.revokedAt !== null, 'local account revoke stamps revokedAt');
});

// ---------------------------------------------------------------------------
// per-account isolation — account A never sees / can never revoke account B's
// keys (works identically for local and github accounts; scoped on user.id)
// ---------------------------------------------------------------------------

test('per-account isolation: A cannot see or revoke B keys (and vice-versa)', async () => {
  const { prisma } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));

  // A = a GitHub account; B = a local account. Each mints one key.
  const reqA = sessionRequest();
  const reqB = localSessionRequest();

  const aKey = await controller.mint(reqA, { name: 'a-key', scopes: ['tasks:read'] });
  const bKey = await controller.mint(reqB, { name: 'b-key', scopes: ['tasks:read'] });

  // Each account's list shows ONLY its own key.
  const aList = await controller.list(reqA);
  assert.deepEqual(
    aList.keys.map((k) => k.id),
    [aKey.id],
    'A sees only its own key',
  );
  const bList = await controller.list(reqB);
  assert.deepEqual(
    bList.keys.map((k) => k.id),
    [bKey.id],
    'B sees only its own key',
  );

  // A cannot revoke B's key (404, never reveals existence) and vice-versa.
  await assert.rejects(
    () => controller.revoke(reqA, bKey.id),
    /No API key/,
    "A cannot revoke B's key",
  );
  await assert.rejects(
    () => controller.revoke(reqB, aKey.id),
    /No API key/,
    "B cannot revoke A's key",
  );

  // Both keys remain live after the cross-account revoke attempts.
  assert.equal((await controller.list(reqA)).keys[0].revokedAt, null);
  assert.equal((await controller.list(reqB)).keys[0].revokedAt, null);
});

// ---------------------------------------------------------------------------
// the gate now hinges ONLY on an authenticated session — an identity-less
// principal (machine/legacy with user === null) is still rejected fail-closed
// ---------------------------------------------------------------------------

test('an identity-less session-less principal is still rejected on CRUD', async () => {
  const { prisma, rows } = makeFakePrisma();
  const controller = new ApiKeysController(new ApiKeysService(prisma));

  // A `session` kind whose user is somehow null is identity-less and rejected.
  const identityless = principalRequest({
    kind: 'session',
    user: null,
  } as unknown as OperatorPrincipal);

  await assert.rejects(
    () => controller.mint(identityless, { name: 'x', scopes: ['tasks:read'] }),
    ForbiddenException,
    'identity-less principal is 403 on mint',
  );
  await assert.rejects(
    () => controller.list(identityless),
    ForbiddenException,
    'identity-less principal is 403 on list',
  );
  assert.equal(rows.length, 0, 'no key minted by an identity-less principal');
});
