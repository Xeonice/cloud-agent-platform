/**
 * fix-codex-headless-subscription-auth — refresh-and-persist of codex's rotated official auth.json.
 * Covers the safety guard (never overwrite a stored credential with garbage), owner-scoping, the
 * official-only write (compatible / env-fallback no-op), and the round-trip re-encryption.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PrismaCodexAuthSource } from './prisma-codex-auth-source';
import { EnvCodexAuthSource } from './env-codex-auth-source';
import { decryptSecret, resolveEncryptionKey } from '../settings/settings-crypto';
import type { PrismaService } from '../prisma/prisma.service';

const KEY_HEX = '0'.repeat(64); // 64 hex chars = 32-byte AES key
const VALID_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { refresh_token: 'rt-ROTATED', access_token: 'at' },
  last_refresh: '2026-06-20T00:00:00Z',
});

interface UpdateCall {
  where: unknown;
  data: { authJsonCiphertext?: string };
}

function makePrisma(opts: { ownerId: string | null; cred: { mode: string } | null }) {
  const calls = { findUnique: 0, update: [] as UpdateCall[] };
  const prisma = {
    auditEvent: {
      findFirst: async () => (opts.ownerId ? { userId: opts.ownerId } : null),
    },
    codexCredential: {
      findUnique: async () => {
        calls.findUnique++;
        return opts.cred;
      },
      update: async (args: UpdateCall) => {
        calls.update.push(args);
        return {};
      },
    },
  } as unknown as PrismaService;
  return { prisma, calls };
}

test('persistRefreshedAuth skips a non-parseable / refresh_token-less auth.json (no DB touch)', async () => {
  const { prisma, calls } = makePrisma({ ownerId: 'o1', cred: { mode: 'official' } });
  const src = new PrismaCodexAuthSource(prisma);
  await src.persistRefreshedAuth('t1', 'not json at all');
  await src.persistRefreshedAuth('t1', JSON.stringify({ tokens: {} })); // no refresh_token
  await src.persistRefreshedAuth('t1', JSON.stringify({ tokens: { refresh_token: '' } })); // empty
  assert.equal(calls.findUnique, 0, 'the guard must short-circuit before any DB query');
  assert.equal(calls.update.length, 0);
});

test('persistRefreshedAuth re-encrypts and updates the owner OFFICIAL credential', async () => {
  process.env.CODEX_CRED_ENC_KEY = KEY_HEX;
  const { prisma, calls } = makePrisma({ ownerId: 'owner-1', cred: { mode: 'official' } });
  await new PrismaCodexAuthSource(prisma).persistRefreshedAuth('t1', VALID_AUTH);
  assert.equal(calls.update.length, 1);
  assert.deepEqual(calls.update[0]!.where, { userId: 'owner-1' }); // owner-scoped
  // the stored ciphertext round-trips back to the exact refreshed auth.json
  const stored = calls.update[0]!.data.authJsonCiphertext!;
  const [ciphertext, iv, authTag] = stored.split('.');
  const back = decryptSecret(
    { ciphertext: ciphertext!, iv: iv!, authTag: authTag! },
    resolveEncryptionKey(KEY_HEX),
  );
  assert.equal(back, VALID_AUTH);
});

test('persistRefreshedAuth no-ops for a COMPATIBLE credential (no auth.json to refresh)', async () => {
  process.env.CODEX_CRED_ENC_KEY = KEY_HEX;
  const { prisma, calls } = makePrisma({ ownerId: 'owner-1', cred: { mode: 'compatible' } });
  await new PrismaCodexAuthSource(prisma).persistRefreshedAuth('t1', VALID_AUTH);
  assert.equal(calls.update.length, 0);
});

test('persistRefreshedAuth no-ops when the task has no attributed owner (env fallback)', async () => {
  process.env.CODEX_CRED_ENC_KEY = KEY_HEX;
  const { prisma, calls } = makePrisma({ ownerId: null, cred: { mode: 'official' } });
  await new PrismaCodexAuthSource(prisma).persistRefreshedAuth('t1', VALID_AUTH);
  assert.equal(calls.update.length, 0);
});

test('EnvCodexAuthSource.persistRefreshedAuth is a no-op that never throws', async () => {
  await new EnvCodexAuthSource().persistRefreshedAuth('t1', VALID_AUTH);
});
