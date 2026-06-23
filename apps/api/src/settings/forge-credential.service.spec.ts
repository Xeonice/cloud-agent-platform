/**
 * add-forge-credentials — ForgeCredentialService DI behavior.
 *
 * Against the REAL service with a fake Prisma + a stubbed global fetch:
 *   - connect: a VALIDATED token is stored encrypted + returned secret-free; an
 *     INVALID token (probe not ok) is rejected and NOTHING is stored.
 *   - list: secret-free (kind/host/state/last4 only — never the token).
 *   - getForgeCredential: decrypts the owner-scoped token for change C.
 *   - registerConnection: derives the per-kind apiBase when omitted; private/LAN
 *     hosts are allowed (no SSRF gate).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SessionUser } from '@cap/contracts';
import { ForgeCredentialService } from './forge-credential.service';
import { encryptToStored } from './secret-storage';
import type { PrismaService } from '../prisma/prisma.service';
import type { DefaultForgeRegistry } from '../forge/forge-registry';

/** Registry is only used by listAvailableRepos (not exercised in these tests). */
const REGISTRY = {} as unknown as DefaultForgeRegistry;

const KEY = '0'.repeat(64);
const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: KEY };
// The per-account scope key is now `user.id` directly (no githubId reverse lookup)
// — fix-local-account-settings-scope. `id: 'u1'` matches the owner-scoped rows.
const OPERATOR = { id: 'u1', githubId: 4242, login: 'op' } as unknown as SessionUser;

/** Build a fake PrismaService capturing forge writes; the scope is OPERATOR.id ('u1'). */
function makePrisma(overrides: Record<string, unknown> = {}) {
  const calls: { upserts: unknown[]; deletes: unknown[] } = { upserts: [], deletes: [] };
  const prisma = {
    user: { findUnique: async () => ({ id: 'u1' }) },
    forgeCredential: {
      upsert: async (args: unknown) => {
        calls.upserts.push(args);
        return {};
      },
      findMany: async () => [],
      findUnique: async () => null,
      deleteMany: async (args: unknown) => {
        calls.deletes.push(args);
        return { count: 1 };
      },
    },
    forgeConnection: {
      upsert: async (args: { create: Record<string, unknown> }) => args.create,
      findMany: async () => [],
      findUnique: async () => null,
    },
    ...overrides,
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

function stubFetch(ok: boolean): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

test('connect stores an encrypted credential and returns it secret-free', async () => {
  const { prisma, calls } = makePrisma();
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  const restore = stubFetch(true);
  try {
    const result = await svc.connect(
      OPERATOR,
      { kind: 'gitlab', host: 'git.corp.com', token: 'glpat-supersecretvalue' },
      ENV,
    );
    assert.deepEqual(result, {
      kind: 'gitlab',
      host: 'git.corp.com',
      state: 'connected',
      last4: 'alue',
    });
    assert.equal(calls.upserts.length, 1, 'one upsert');
    const args = calls.upserts[0] as { create: { tokenCiphertext: string } };
    assert.ok(!args.create.tokenCiphertext.includes('glpat-supersecret'), 'token encrypted');
    assert.equal(args.create.tokenCiphertext.split('.').length, 3, 'envelope stored');
  } finally {
    restore();
  }
});

test('connect rejects an invalid token and stores nothing', async () => {
  const { prisma, calls } = makePrisma();
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  const restore = stubFetch(false);
  try {
    await assert.rejects(
      () => svc.connect(OPERATOR, { kind: 'github', token: 'ghp_bad' }, ENV),
      /could not be validated/,
    );
    assert.equal(calls.upserts.length, 0, 'no row stored on invalid token');
  } finally {
    restore();
  }
});

test('connect defaults host to the public host when omitted', async () => {
  const { prisma, calls } = makePrisma();
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  const restore = stubFetch(true);
  try {
    const result = await svc.connect(OPERATOR, { kind: 'gitee', token: 'gitee_tok' }, ENV);
    assert.equal(result.host, 'gitee.com');
    const args = calls.upserts[0] as { create: { host: string } };
    assert.equal(args.create.host, 'gitee.com');
  } finally {
    restore();
  }
});

test('list returns secret-free shapes only', async () => {
  const { prisma } = makePrisma({
    forgeCredential: {
      findMany: async () => [
        { kind: 'github', host: 'github.com', state: 'connected', tokenLast4: 'a91f', tokenCiphertext: 'c.i.t' },
      ],
    },
  });
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  const list = await svc.list(OPERATOR);
  assert.deepEqual(list, [
    { kind: 'github', host: 'github.com', state: 'connected', last4: 'a91f' },
  ]);
  assert.ok(!JSON.stringify(list).includes('tokenCiphertext'), 'never leaks the ciphertext');
});

test('getForgeCredential decrypts the owner-scoped token', async () => {
  const stored = encryptToStored('glpat-owner-scoped-secret', ENV);
  const { prisma } = makePrisma({
    forgeCredential: { findUnique: async () => ({ tokenCiphertext: stored }) },
  });
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  assert.equal(
    await svc.getForgeCredential('u1', 'gitlab', 'git.corp.com', ENV),
    'glpat-owner-scoped-secret',
  );
});

test('registerConnection derives the per-kind apiBase for a private host', async () => {
  const { prisma } = makePrisma();
  const svc = new ForgeCredentialService(prisma, REGISTRY);
  const conn = await svc.registerConnection({ host: 'git.corp.com', kind: 'gitlab' });
  assert.equal(conn.apiBaseUrl, 'https://git.corp.com/api/v4');
  assert.equal(conn.host, 'git.corp.com');
});
