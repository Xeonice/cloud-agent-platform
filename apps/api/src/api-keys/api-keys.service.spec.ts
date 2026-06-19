/**
 * Tests for the API-key CRUD surface (api-key-machine-identity, task 5.3).
 *
 * Asserts the three load-bearing requirements:
 *   1. NO ESCALATION CHAIN — an `api-key` principal (and any non-`session`
 *      principal: legacy/mcp) cannot mint/list/revoke; only a GitHub-OAuth
 *      `session` principal reaches the service. Tested at the controller's
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
import { ForbiddenException } from '@nestjs/common';
import { API_KEY_PREFIX } from '@cap/contracts';

import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const GITHUB_ID = 4242;
const USER_ID = '00000000-0000-4000-a000-000000000001';

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
    user: {
      findUnique: async ({ where }: { where: { githubId: number } }) =>
        where.githubId === GITHUB_ID ? { id: USER_ID } : null,
    },
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
      githubId: GITHUB_ID,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.test/a.png',
      allowed: true,
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

  const res = await service.mint(GITHUB_ID, { name: 'ci', scopes: ['tasks:read'] });

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
  const res2 = await service.mint(GITHUB_ID, { name: 'ci2', scopes: ['tasks:read'] });
  assert.notEqual(res2.key, res.key, 'each mint generates a fresh raw key');
});

// ---------------------------------------------------------------------------
// 5.3 — list responses never leak the raw key or the stored hash
// ---------------------------------------------------------------------------

test('list exposes only non-secret metadata — never the raw key or hash', async () => {
  const { prisma } = makeFakePrisma();
  const service = new ApiKeysService(prisma);

  const minted = await service.mint(GITHUB_ID, {
    name: 'reader',
    scopes: ['tasks:read', 'repos:read'],
  });

  const items = await service.list(GITHUB_ID);
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

  const minted = await service.mint(GITHUB_ID, { name: 'doomed', scopes: ['tasks:write'] });
  const id = minted.id;

  const first = await service.revoke(GITHUB_ID, id);
  assert.ok(first.revokedAt !== null, 'first revoke stamps revokedAt');

  const second = await service.revoke(GITHUB_ID, id);
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
      githubId: GITHUB_ID,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: 'https://example.test/a.png',
      allowed: true,
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
