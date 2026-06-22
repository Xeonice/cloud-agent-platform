/**
 * Ground-truth test: "The runtime authorization gate is the user's allowed flag"
 * (add-private-account-identity — local-account-identity spec, Requirement D2).
 *
 * The requirement:
 *   The orchestrator SHALL gate every authenticated request on the resolved
 *   user's `allowed` flag, re-confirmed at request time (not cached).
 *   A resolved principal whose user has `allowed = false` SHALL be denied
 *   fail-closed regardless of identity type (session, API key).
 *   The gate SHALL fail closed for any account that does not exist.
 *
 * Exercises the REAL `AuthSessionService.resolveSession` and `resolveApiKey`
 * against fake Prisma doubles. No DI container, no DB.
 *
 * Run from apps/api with: pnpm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { AuthSessionService } from './auth-session.service';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never, null as never);
}

// ---------------------------------------------------------------------------
// Session path: resolveSession gates on user.allowed
// ---------------------------------------------------------------------------

const RAW_SESSION_TOKEN = 'sess_runtime_allowed_gate_test';

function makePrismaForSession(allowed: boolean) {
  const tokenHash = sha256Hex(RAW_SESSION_TOKEN);
  const sessionRow = {
    tokenHash,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    user: {
      githubId: 42,
      login: 'testuser',
      name: 'Test User',
      avatarUrl: 'https://example.test/a.png',
      allowed,
    },
  };
  return {
    session: {
      findFirst: async (args: { where: { tokenHash: string } }) =>
        args.where.tokenHash === tokenHash ? sessionRow : null,
    },
  };
}

test('resolveSession: allowed=true → session resolves (request proceeds)', async () => {
  const svc = serviceOver(makePrismaForSession(true));
  const result = await svc.resolveSession(RAW_SESSION_TOKEN);
  assert.ok(result !== null, 'allowed user must resolve');
  assert.equal(result.allowed, true);
});

test('resolveSession: allowed=false → null (denied fail-closed on next request)', async () => {
  // Scenario: "Disallowed account is denied on its next request"
  // Same token, same DB session row — ONLY User.allowed changed to false.
  // The gate is re-confirmed at request time, so the very next call returns null.
  const svc = serviceOver(makePrismaForSession(false));
  const result = await svc.resolveSession(RAW_SESSION_TOKEN);
  assert.equal(
    result,
    null,
    'de-allowlisted user must be denied fail-closed on their next request',
  );
});

test('resolveSession: no session row → null (gate fails closed for non-existent account)', async () => {
  const svc = serviceOver(makePrismaForSession(true));
  // Token not in the DB → findFirst returns null
  const result = await svc.resolveSession('sess_completely_unknown');
  assert.equal(result, null, 'unknown session must fail closed');
});

// ---------------------------------------------------------------------------
// API-key path: resolveApiKey gates on user.allowed
// ---------------------------------------------------------------------------

const RAW_API_KEY = 'cap_sk_runtime_allowed_gate_test';

function makePrismaForApiKey(allowed: boolean) {
  const tokenHash = sha256Hex(RAW_API_KEY);
  const keyRow = {
    id: 'key-001',
    tokenHash,
    scopes: ['tasks:read'],
    revokedAt: null,
    expiresAt: null,
    lastUsedAt: null,
    user: {
      githubId: 42,
      login: 'testuser',
      name: 'Test User',
      avatarUrl: 'https://example.test/a.png',
      allowed,
    },
  };
  return {
    apiKey: {
      findFirst: async (args: { where: { tokenHash: string } }) =>
        args.where.tokenHash === tokenHash ? keyRow : null,
      update: async (_args: unknown) => keyRow,
    },
  };
}

test('resolveApiKey: allowed=true → key resolves (request proceeds)', async () => {
  const svc = serviceOver(makePrismaForApiKey(true));
  const result = await svc.resolveApiKey(RAW_API_KEY);
  assert.ok(result !== null, 'allowed user API key must resolve');
  assert.equal(result.user.allowed, true);
});

test('resolveApiKey: allowed=false → null (denied fail-closed on next request)', async () => {
  // Same key material — ONLY the owner's allowed flag changed to false.
  const svc = serviceOver(makePrismaForApiKey(false));
  const result = await svc.resolveApiKey(RAW_API_KEY);
  assert.equal(
    result,
    null,
    'de-allowlisted owner API key must be denied fail-closed',
  );
});
