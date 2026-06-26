/**
 * Ground-truth test: "API key resolution re-confirms the owner's enabled state on every request"
 * (add-private-account-identity, task 2.5 / D2).
 *
 * The requirement: `resolveApiKey` must re-check `User.allowed` on EVERY call, so
 * that disabling a user's account causes their API keys to stop working on
 * the very next request — without waiting for a cache flush or server restart.
 *
 * Exercises the REAL `AuthSessionService.resolveApiKey` against a fake Prisma
 * double. No DI container, no DB.
 *
 * Run from apps/api with: pnpm test
 * (pretest builds to dist/; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AuthSessionService } from './auth-session.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Shape of an ApiKey row as resolveApiKey reads it (via prisma.apiKey.findFirst). */
interface FakeApiKeyRow {
  id: string;
  tokenHash: string;
  scopes: string[];
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  user: {
    githubId: number | null;
    login: string;
    name: string;
    avatarUrl: string;
    allowed: boolean;
  };
}

/**
 * Build a minimal fake Prisma that returns `row` from `apiKey.findFirst` and
 * absorbs the best-effort `lastUsedAt` bump (`apiKey.update`).
 */
function makePrismaWithKey(row: FakeApiKeyRow | null) {
  return {
    apiKey: {
      findFirst: async (_args: unknown): Promise<FakeApiKeyRow | null> => row,
      update: async (_args: unknown): Promise<FakeApiKeyRow> => row as FakeApiKeyRow,
    },
  };
}

/** Construct a real `AuthSessionService` over a fake Prisma. */
function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never);
}

// ---------------------------------------------------------------------------
// The raw key we will present in each call.
// ---------------------------------------------------------------------------

const RAW_KEY = 'cap_sk_test_key_for_enabled_recheck';

/**
 * A reusable "valid" key row pointing to an ALLOWED owner.
 * `tokenHash` matches `RAW_KEY` exactly as resolveApiKey computes it
 * (SHA-256 via `hashSessionToken`).
 */
function keyRow(allowed: boolean): FakeApiKeyRow {
  return {
    id: 'key-001',
    tokenHash: sha256Hex(RAW_KEY),
    scopes: ['tasks:read'],
    revokedAt: null,
    expiresAt: null,   // no expiry — lifecycle is the allowed flag
    lastUsedAt: null,
    user: {
      githubId: 99999,
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

test('resolveApiKey: a key whose owner is allowed resolves to the owner + scopes', async () => {
  const svc = serviceOver(makePrismaWithKey(keyRow(true)));

  const result = await svc.resolveApiKey(RAW_KEY);

  assert.ok(result !== null, 'should resolve when owner is allowed');
  assert.equal(result.user.allowed, true);
  assert.deepEqual(result.scopes, ['tasks:read']);
});

test('resolveApiKey: a key whose owner is disabled resolves to null (allowed re-checked)', async () => {
  // Same key material, same DB record — ONLY the owner's `allowed` flag changed.
  // The requirement is that resolveApiKey re-confirms this flag on EVERY call.
  const svc = serviceOver(makePrismaWithKey(keyRow(false)));

  const result = await svc.resolveApiKey(RAW_KEY);

  assert.equal(
    result,
    null,
    'should return null when owner.allowed is false on the very next call',
  );
});

test('resolveApiKey: a key for an allowed owner, then same key for a disabled owner — re-check is per-call', async () => {
  // Simulate two sequential requests using the same raw key.
  // Between request 1 and request 2, an admin flips `allowed` to false.

  // Request 1: owner is allowed → resolves.
  const svcAllowed = serviceOver(makePrismaWithKey(keyRow(true)));
  const r1 = await svcAllowed.resolveApiKey(RAW_KEY);
  assert.ok(r1 !== null, 'request 1: key resolves while owner is allowed');

  // Request 2: owner has been disabled -> same key, null result.
  const svcDenied = serviceOver(makePrismaWithKey(keyRow(false)));
  const r2 = await svcDenied.resolveApiKey(RAW_KEY);
  assert.equal(
    r2,
    null,
    'request 2: same key returns null after owner is disabled — no caching of the prior admit',
  );
});

test('resolveApiKey: a revoked key is null regardless of allowed flag', async () => {
  const row = { ...keyRow(true), revokedAt: new Date(Date.now() - 1000) };
  const svc = serviceOver(makePrismaWithKey(row));
  assert.equal(await svc.resolveApiKey(RAW_KEY), null, 'revoked key is always null');
});

test('resolveApiKey: an expired key is null regardless of allowed flag', async () => {
  const row = { ...keyRow(true), expiresAt: new Date(Date.now() - 1000) };
  const svc = serviceOver(makePrismaWithKey(row));
  assert.equal(await svc.resolveApiKey(RAW_KEY), null, 'expired key is always null');
});

test('resolveApiKey: an unknown key (hash miss) is null', async () => {
  const svc = serviceOver(makePrismaWithKey(null)); // findFirst returns null
  assert.equal(
    await svc.resolveApiKey('cap_sk_completely_unknown'),
    null,
    'unrecognised key is null',
  );
});
