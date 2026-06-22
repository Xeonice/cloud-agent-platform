/**
 * Ground-truth test: "User record keyed by GitHub identity"
 * (add-private-account-identity / multi-user-oauth spec, requirement at line 56).
 *
 * Requirement (verbatim spec):
 *   The orchestrator SHALL persist a provider-agnostic `User` account and
 *   represent the GitHub login as a `github` `IdentityLink` keyed on the stable
 *   GitHub numeric `id`, recording the GitHub `login`, display name, avatar
 *   reference, and (when available) primary verified email for console rendering
 *   and account resolution. On a successful allowlisted GitHub login the
 *   orchestrator SHALL upsert the `User` + its `github` identity (create on first
 *   login, refresh mutable profile fields such as `login`/avatar on subsequent
 *   logins) so that audit, task ownership, and account-settings capabilities can
 *   attribute actions to a durable user identity. Provisioning or refreshing a
 *   record SHALL never of itself bypass the `allowed` gate.
 *
 * Three scenarios:
 *   A. First GitHub login creates the account AND a github IdentityLink keyed by
 *      the GitHub numeric id, capturing login/name/avatar/email.
 *   B. Subsequent login refreshes mutable profile fields (login, name, avatar)
 *      WITHOUT creating a duplicate account.
 *   C. A non-allowlisted identity gets no User record and no session — provisioning
 *      never bypasses the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthSessionService } from './auth-session.service';
import type { GitHubUser } from './github-oauth.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_USER: GitHubUser = {
  id: 77001,
  login: 'alice',
  name: 'Alice',
  avatarUrl: 'https://avatars.example.test/alice',
  email: 'alice@example.test',
};

const ACCESS_TOKEN = 'gha_test_token_alice';
const ENV_WITH_ALICE: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
const ENV_WITHOUT_ALICE: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: '0' };

// ---------------------------------------------------------------------------
// Scenario A: First GitHub login creates a User and a github IdentityLink
// ---------------------------------------------------------------------------

test('User record keyed by GitHub identity — Scenario A: first login creates User + github IdentityLink', async () => {
  // Track what the service writes.
  const userCreates: Array<Record<string, unknown>> = [];
  const identityLinkUpserts: Array<{ provider: string; providerAccountId: string }> = [];

  const prisma = {
    identityLink: {
      // No existing link → fresh provision path.
      findUnique: async (_args: unknown) => null,
      upsert: async (args: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
        create: { userId: string; provider: string; providerAccountId: string; secret: string | null };
        update: { userId: string; secret: string | null };
      }) => {
        identityLinkUpserts.push({
          provider: args.where.provider_providerAccountId.provider,
          providerAccountId: args.where.provider_providerAccountId.providerAccountId,
        });
        return {
          id: 'link-001',
          userId: 'user-alice',
          provider: args.where.provider_providerAccountId.provider,
          providerAccountId: args.where.provider_providerAccountId.providerAccountId,
          secret: args.create.secret,
        };
      },
    },
    user: {
      // No existing email match (fresh provision).
      findUnique: async (_args: unknown) => null,
      create: async (args: { data: Record<string, unknown>; select?: unknown }) => {
        userCreates.push({ ...args.data });
        return { id: 'user-alice' };
      },
      update: async (_args: unknown) => ({ id: 'user-alice' }),
      findUniqueOrThrow: async (_args: unknown) => ({
        role: 'member',
        mustChangePassword: false,
      }),
    },
    session: {
      create: async (_args: unknown) => ({}),
    },
  };

  const svc = new AuthSessionService(prisma as never, { recordIdentityLinked: () => {} } as never);
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, ENV_WITH_ALICE);

  // The gate must admit this identity.
  assert.ok(result !== null, 'session must be established for an allowlisted GitHub user');

  // A User row must have been created with the GitHub profile fields.
  assert.equal(userCreates.length, 1, 'exactly one User must be created on first login');
  const created = userCreates[0]!;
  assert.equal(created['login'], GITHUB_USER.login, 'User.login must match GitHub login');
  assert.equal(created['name'], GITHUB_USER.name, 'User.name must match GitHub name');
  assert.equal(created['avatarUrl'], GITHUB_USER.avatarUrl, 'User.avatarUrl must match GitHub avatar');
  assert.equal(created['email'], GITHUB_USER.email, 'User.email must capture primary verified email');

  // The github IdentityLink keyed on the numeric GitHub id must be upserted.
  assert.ok(identityLinkUpserts.length >= 1, 'an IdentityLink upsert must have been issued');
  const githubLink = identityLinkUpserts.find(
    (l) => l.provider === 'github' && l.providerAccountId === String(GITHUB_USER.id),
  );
  assert.ok(
    githubLink !== undefined,
    `IdentityLink upsert must use provider="github" and providerAccountId="${GITHUB_USER.id}" — got: ${JSON.stringify(identityLinkUpserts)}`,
  );
});

// ---------------------------------------------------------------------------
// Scenario B: Subsequent login refreshes mutable profile fields, no duplicate
// ---------------------------------------------------------------------------

test('User record keyed by GitHub identity — Scenario B: subsequent login refreshes profile, no duplicate', async () => {
  const UPDATED_USER: GitHubUser = {
    ...GITHUB_USER,
    login: 'alice-new-handle',
    name: 'Alice Updated',
    avatarUrl: 'https://avatars.example.test/alice-new',
  };

  const userCreates: Array<unknown> = [];
  const userUpdates: Array<Record<string, unknown>> = [];
  const identityLinkUpserts: Array<{ provider: string; providerAccountId: string }> = [];

  const prisma = {
    identityLink: {
      // Existing link → re-login path.
      findUnique: async (_args: unknown) => ({ userId: 'user-alice' }),
      upsert: async (args: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
        create: unknown;
        update: { userId: string; secret: string | null };
      }) => {
        identityLinkUpserts.push({
          provider: args.where.provider_providerAccountId.provider,
          providerAccountId: args.where.provider_providerAccountId.providerAccountId,
        });
        return {
          id: 'link-001',
          userId: 'user-alice',
          provider: args.where.provider_providerAccountId.provider,
          providerAccountId: args.where.provider_providerAccountId.providerAccountId,
          secret: null,
        };
      },
    },
    user: {
      findUnique: async (_args: unknown) => null,
      create: async (args: unknown) => {
        userCreates.push(args);
        return { id: 'should-not-create' };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown>; select?: unknown }) => {
        userUpdates.push({ ...args.data });
        return { id: args.where.id };
      },
      findUniqueOrThrow: async (_args: unknown) => ({
        role: 'member',
        mustChangePassword: false,
      }),
    },
    session: {
      create: async (_args: unknown) => ({}),
    },
  };

  const svc = new AuthSessionService(prisma as never, { recordIdentityLinked: () => {} } as never);
  const result = await svc.establishSessionForGitHubUser(UPDATED_USER, ACCESS_TOKEN, ENV_WITH_ALICE);

  assert.ok(result !== null, 'session must be established for a returning allowlisted user');

  // No new User should be created on a re-login.
  assert.equal(userCreates.length, 0, 're-login must NOT create a new User (no duplicate)');

  // The existing User record must be updated with the new profile fields.
  assert.ok(userUpdates.length >= 1, 're-login must update the User profile');
  const updated = userUpdates[0]!;
  assert.equal(updated['login'], UPDATED_USER.login, 'User.login must be refreshed');
  assert.equal(updated['name'], UPDATED_USER.name, 'User.name must be refreshed');
  assert.equal(updated['avatarUrl'], UPDATED_USER.avatarUrl, 'User.avatarUrl must be refreshed');

  // The github IdentityLink keyed on numeric id must still be upserted (token refresh).
  const githubLink = identityLinkUpserts.find(
    (l) => l.provider === 'github' && l.providerAccountId === String(GITHUB_USER.id),
  );
  assert.ok(
    githubLink !== undefined,
    `IdentityLink must be upserted on re-login for token refresh — got: ${JSON.stringify(identityLinkUpserts)}`,
  );
});

// ---------------------------------------------------------------------------
// Scenario C: Non-allowlisted identity gets no User record and no session
// ---------------------------------------------------------------------------

test('User record keyed by GitHub identity — Scenario C: non-allowlisted identity gets no User, no session', async () => {
  const userCreates: Array<unknown> = [];
  const userUpdates: Array<unknown> = [];

  const prisma = {
    identityLink: {
      findUnique: async (_args: unknown) => null,
      upsert: async (_args: unknown) => ({}),
    },
    user: {
      findUnique: async (_args: unknown) => null,
      create: async (args: unknown) => {
        userCreates.push(args);
        return { id: 'should-not-be-called' };
      },
      update: async (args: unknown) => {
        userUpdates.push(args);
        return { id: 'should-not-be-called' };
      },
      findUniqueOrThrow: async (_args: unknown) => ({ role: 'member', mustChangePassword: false }),
    },
    session: {
      create: async (_args: unknown) => ({}),
    },
  };

  const svc = new AuthSessionService(prisma as never, { recordIdentityLinked: () => {} } as never);

  // The env allowlist does NOT include this user's id.
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, ENV_WITHOUT_ALICE);

  // Gate must deny — return null, no session.
  assert.equal(result, null, 'non-allowlisted identity must be denied (null)');

  // Provisioning must NOT happen when the gate denies.
  assert.equal(
    userCreates.length,
    0,
    'provisioning (user.create) must NOT occur for a denied identity — gate must fail closed',
  );
  assert.equal(
    userUpdates.length,
    0,
    'profile refresh (user.update) must NOT occur for a denied identity',
  );
});
