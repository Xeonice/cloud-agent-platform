/**
 * Minimal ground-truth test: API key revocation scenario.
 *
 * Exercises the load-bearing requirement:
 *   A revoked API key must NOT resolve to a principal (resolveApiKey returns null
 *   immediately after revocation, even if the same raw key was valid before).
 *
 * Uses the REAL compiled AuthSessionService + ApiKeysService from dist/ with
 * an in-memory fake Prisma, no DB, no DI container.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_AUTH = path.resolve(here, '../../dist/auth');
const DIST_KEYS = path.resolve(here, '../../dist/api-keys');

const { AuthSessionService } = require(path.join(DIST_AUTH, 'auth-session.service.js'));
const { ApiKeysService }     = require(path.join(DIST_KEYS, 'api-keys.service.js'));

// ---------------------------------------------------------------------------
// In-memory fake Prisma covering user + apiKey delegates
// ---------------------------------------------------------------------------

const GITHUB_ID  = 7777;
const USER_ID    = 'user-00000000-0000-0000-0000-000000000001';

function makePrisma() {
  const users  = [{
    id: USER_ID,
    githubId: GITHUB_ID,
    login: 'tester',
    name: 'Tester',
    avatarUrl: '',
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  }];
  const apiKeys = [];
  let seq = 0;

  return {
    user: {
      findUnique: async ({ where }) =>
        users.find((u) => u.githubId === where.githubId) ?? null,
    },
    apiKey: {
      create: async ({ data }) => {
        seq += 1;
        const row = {
          id: `key-${seq}`,
          userId: data.userId,
          tokenHash: data.tokenHash,
          prefix: data.prefix,
          last4: data.last4,
          name: data.name,
          scopes: data.scopes,
          lastUsedAt: null,
          expiresAt: data.expiresAt ?? null,
          revokedAt: null,
          createdAt: new Date(),
          // embed user inline for resolveApiKey include:{ user: true }
          user: users.find((u) => u.id === data.userId),
        };
        apiKeys.push(row);
        return row;
      },
      findFirst: async ({ where }) => {
        // resolveApiKey does findFirst({ where:{ tokenHash }, include:{ user:true } })
        // ApiKeysService.revoke does findFirst({ where:{ id, userId } })
        if (where.tokenHash !== undefined) {
          return apiKeys.find((r) => r.tokenHash === where.tokenHash) ?? null;
        }
        if (where.id !== undefined && where.userId !== undefined) {
          return apiKeys.find((r) => r.id === where.id && r.userId === where.userId) ?? null;
        }
        return null;
      },
      findMany: async ({ where }) =>
        apiKeys.filter((r) => r.userId === where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      update: async ({ where, data }) => {
        const row = apiKeys.find((r) => r.id === where.id);
        if (!row) throw new Error(`no apiKey row for id=${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test: API key revocation
// ---------------------------------------------------------------------------

const run = async () => {
  console.log('\n=== API key revocation: resolveApiKey must return null after revoke ===\n');

  const prisma    = makePrisma();
  const keySvc    = new ApiKeysService(prisma);
  const authSvc   = new AuthSessionService(prisma);

  // Step 1: Mint a key.
  const minted = await keySvc.mint(USER_ID, { name: 'ci-bot', scopes: ['tasks:read'] });
  assert(typeof minted.key === 'string' && minted.key.startsWith('cap_sk_'),
    'Step 1: mint returns a raw cap_sk_ key');

  // Step 2: The raw key resolves to a principal (key is active).
  const before = await authSvc.resolveApiKey(minted.key);
  assert(before !== null, 'Step 2: active key resolves to a principal (not null)');
  assert(before?.user?.githubId === GITHUB_ID,
    'Step 2b: resolved principal carries the correct githubId');
  assert(before?.keyId === minted.id,
    'Step 2c: resolved principal carries the correct keyId');

  // Step 3: Revoke the key.
  const revokeResult = await keySvc.revoke(USER_ID, minted.id);
  assert(revokeResult.revokedAt !== null,
    'Step 3: revoke stamps revokedAt on the key record');

  // Step 4: The same raw key no longer resolves — revocation takes effect immediately.
  const after = await authSvc.resolveApiKey(minted.key);
  assert(after === null,
    'Step 4: revoked key resolves to null (authentication denied)');

  // Step 5: Idempotency — revoking again still returns a stamped record and the
  //         key still does not resolve.
  const revokeAgain = await keySvc.revoke(USER_ID, minted.id);
  assert(revokeAgain.revokedAt === revokeResult.revokedAt,
    'Step 5a: second revoke is idempotent (revokedAt timestamp unchanged)');
  const afterAgain = await authSvc.resolveApiKey(minted.key);
  assert(afterAgain === null,
    'Step 5b: key still does not resolve after idempotent re-revoke');

  // ---------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
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
