/**
 * Ground-truth test: "AUTH_ALLOWLIST is GitHub login-time provisioning,
 * not a runtime gate" (add-private-account-identity).
 *
 * Requirement:
 *   At GitHub login (`establishSessionForGitHubUser`), AUTH_ALLOWLIST decides
 *   whether to admit or deny and writes `User.allowed = true` into the DB.
 *   At runtime (`resolveSession`), the gate reads ONLY `User.allowed` from the
 *   DB — it does NOT re-consult AUTH_ALLOWLIST. So:
 *
 *   - A user whose id IS in AUTH_ALLOWLIST at login time gets admitted and a
 *     session minted.
 *   - A user whose id is NOT in AUTH_ALLOWLIST at login time is denied (null).
 *   - After admission, resolveSession honours `User.allowed = true` even when
 *     the env AUTH_ALLOWLIST has been changed or cleared — the env is irrelevant
 *     at runtime.
 *   - resolveSession returns null only when `User.allowed = false`, regardless
 *     of the current AUTH_ALLOWLIST env value.
 *
 * Exercises the REAL `AuthSessionService.establishSessionForGitHubUser` and
 * `resolveSession` against a fake Prisma double. No DI container, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthSessionService } from './auth-session.service';
import type { GitHubUser } from './github-oauth.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal GitHub user fixture. */
const GITHUB_USER: GitHubUser = {
  id: 42000,
  login: 'testuser',
  name: 'Test User',
  avatarUrl: 'https://example.test/avatar.png',
  email: 'test@example.test',
};

/** A GitHub user whose numeric id is NOT in the allowlist fixture. */
const GITHUB_USER_DENIED: GitHubUser = {
  ...GITHUB_USER,
  id: 99999,
  login: 'denied-user',
};

const ACCESS_TOKEN = 'gha_test_access_token';

/**
 * Build a fake Prisma suitable for `establishSessionForGitHubUser`.
 *
 * Simulates: no existing IdentityLink, no email match → fresh user provision.
 * Captures the minted session's tokenHash so `resolveSession` can look it up.
 */
function makeFakePrismaForLogin(allowedFlag: boolean) {
  let createdSession: { tokenHash: string; expiresAt: Date; userId: string } | null = null;
  const prisma = {
    identityLink: {
      findUnique: async (_args: unknown) => null, // no existing link
      upsert: async (_args: unknown) => ({}),
    },
    user: {
      findUnique: async (_args: unknown) => null, // no email match
      create: async (_args: unknown) => {
        return { id: 'user-001' };
      },
      update: async (_args: unknown) => ({ id: 'user-001' }),
      // establish reads back the account's authorization facts for the session
      // payload (role for the admin gate; mustChangePassword always false for a
      // github identity).
      findUniqueOrThrow: async (_args: unknown) => ({
        role: 'member',
        mustChangePassword: false,
      }),
    },
    identitySecret: {
      upsert: async (_args: unknown) => ({}),
    },
    session: {
      create: async (args: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        createdSession = { ...args.data };
        return {};
      },
      findFirst: async (args: { where: { tokenHash: string }; include: { user: boolean } }) => {
        if (!createdSession || createdSession.tokenHash !== args.where.tokenHash) {
          return null;
        }
        // Return a session record with user whose allowed reflects the DB state.
        return {
          ...createdSession,
          user: {
            githubId: GITHUB_USER.id,
            login: GITHUB_USER.login,
            name: GITHUB_USER.name,
            avatarUrl: GITHUB_USER.avatarUrl,
            allowed: allowedFlag,
          },
        };
      },
      deleteMany: async (_args: unknown) => ({}),
    },
  };

  return { prisma, _getCreatedSession: () => createdSession };
}

/** Service under test with a null AuditService (audit.recordIdentityLinked is
 *  not called in the fresh-provision path). */
function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never, null as never);
}

// ---------------------------------------------------------------------------
// Test 1: Login-time gate: admitted when id IS in AUTH_ALLOWLIST
// ---------------------------------------------------------------------------

test('establishSessionForGitHubUser: id in AUTH_ALLOWLIST → session minted (admitted)', async () => {
  const { prisma } = makeFakePrismaForLogin(true);
  const svc = serviceOver(prisma);

  // env has ONLY this user's numeric id
  const env: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, env);

  assert.ok(result !== null, 'should return a session when id is on AUTH_ALLOWLIST');
  assert.equal(result.user.allowed, true);
  assert.ok(typeof result.token === 'string' && result.token.length > 0, 'token must be non-empty');
});

// ---------------------------------------------------------------------------
// Test 2: Login-time gate: denied when id NOT in AUTH_ALLOWLIST
// ---------------------------------------------------------------------------

test('establishSessionForGitHubUser: id NOT in AUTH_ALLOWLIST → null (denied, no session)', async () => {
  const { prisma } = makeFakePrismaForLogin(false);
  const svc = serviceOver(prisma);

  // AUTH_ALLOWLIST contains a DIFFERENT id — not the user's
  const env: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: '11111' };
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER_DENIED, ACCESS_TOKEN, env);

  assert.equal(
    result,
    null,
    'should return null when id is NOT on AUTH_ALLOWLIST — login-time gate denies',
  );
});

// ---------------------------------------------------------------------------
// Test 3: Runtime gate: resolveSession reads ONLY User.allowed, not AUTH_ALLOWLIST
//
// Scenario: user was admitted at login (allowed=true in DB), but AUTH_ALLOWLIST
// has since been cleared. resolveSession should still resolve (env is irrelevant).
// ---------------------------------------------------------------------------

test('resolveSession: admitted user resolves even when AUTH_ALLOWLIST is now empty (env not re-checked)', async () => {
  // Prisma returns a session whose user has allowed=true (as set at login)
  const { prisma } = makeFakePrismaForLogin(true);
  const svc = serviceOver(prisma);

  // First, do the login to mint the session
  const loginEnv: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  const loginResult = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, loginEnv);
  assert.ok(loginResult !== null, 'precondition: login must succeed');

  // Now call resolveSession with AUTH_ALLOWLIST cleared from env (simulating env change)
  // resolveSession should still resolve because User.allowed=true in DB
  const resolveResult = await svc.resolveSession(loginResult.token);

  assert.ok(
    resolveResult !== null,
    'resolveSession: should resolve even when AUTH_ALLOWLIST is absent — runtime gate reads DB User.allowed, not env',
  );
  assert.equal(resolveResult.allowed, true);
});

// ---------------------------------------------------------------------------
// Test 4: Runtime gate: resolveSession returns null when User.allowed=false
// (regardless of AUTH_ALLOWLIST env — DB flag is authoritative at runtime)
// ---------------------------------------------------------------------------

test('resolveSession: user with allowed=false in DB is denied even if AUTH_ALLOWLIST would admit them', async () => {
  // Prisma returns allowed=false (simulating an admin disabling the user)
  const { prisma } = makeFakePrismaForLogin(false);
  const svc = serviceOver(prisma);

  // Mint a session at login (AUTH_ALLOWLIST admits the user)
  const loginEnv: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  const loginResult = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, loginEnv);
  assert.ok(loginResult !== null, 'precondition: login must succeed with correct allowlist');

  // At runtime, the DB now has allowed=false (admin disabled the account).
  // Even though AUTH_ALLOWLIST still has this user's id, resolveSession must return null.
  const resolveResult = await svc.resolveSession(loginResult.token);

  assert.equal(
    resolveResult,
    null,
    'resolveSession: null when User.allowed=false in DB — DB flag is the runtime gate, not AUTH_ALLOWLIST',
  );
});
