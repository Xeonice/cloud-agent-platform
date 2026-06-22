/**
 * Ground-truth test: "Account identity is decoupled from GitHub via IdentityLink"
 * (add-private-account-identity / local-account-identity spec).
 *
 * Scenario: "A GitHub login resolves through its identity link"
 *
 *   WHEN  a GitHub identity authenticates
 *   THEN  the orchestrator resolves the User via the IdentityLink whose
 *         provider="github" and providerAccountId equals the GitHub numeric id,
 *         rather than via a githubId column on User.
 *
 * Concretely: `establishSessionForGitHubUser` must call
 * `prisma.identityLink.findUnique` with the correct provider/providerAccountId
 * key — NOT query `prisma.user.findUnique({ where: { githubId: ... } })` to
 * locate the user. We verify this by asserting that:
 *
 *   1. identityLink.findUnique IS called with { provider: 'github',
 *      providerAccountId: '<numeric id string>' }
 *   2. the resolved session belongs to the user who owns that IdentityLink row
 *      (user-from-identity, not user-from-githubId-column)
 *   3. user.findUnique is NOT called with { where: { githubId: ... } } — the
 *      old column-based lookup is absent from the resolution path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthSessionService } from './auth-session.service';
import type { GitHubUser } from './github-oauth.service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_USER: GitHubUser = {
  id: 55555,
  login: 'identity-link-user',
  name: 'Identity Link User',
  avatarUrl: 'https://example.test/avatar.png',
  email: null, // no email — keeps the auto-link branch inactive
};

const ACCESS_TOKEN = 'gha_identity_link_token';

/** The userId that the fake IdentityLink row resolves to. */
const IDENTITY_LINK_USER_ID = 'user-from-identity-link';

/**
 * Build a fake Prisma where an existing IdentityLink row maps the GitHub
 * numeric id to IDENTITY_LINK_USER_ID. The User table has NO `githubId` column
 * lookup — any call to user.findUnique({ where: { githubId: ... } }) would be
 * observable here.
 */
function buildFakePrisma() {
  // Track what identityLink.findUnique was called with.
  const identityLinkLookups: Array<{ provider: string; providerAccountId: string }> = [];
  // Track any user lookups by githubId (should not happen).
  const userByGithubIdLookups: Array<number> = [];

  const prisma = {
    identityLink: {
      findUnique: async (args: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
        select: { userId: true };
      }) => {
        const key = args.where.provider_providerAccountId;
        identityLinkLookups.push({ provider: key.provider, providerAccountId: key.providerAccountId });

        // Return a matching row only when provider/providerAccountId match.
        if (
          key.provider === 'github' &&
          key.providerAccountId === String(GITHUB_USER.id)
        ) {
          return { userId: IDENTITY_LINK_USER_ID };
        }
        return null;
      },
      upsert: async (_args: unknown) => ({}),
    },
    user: {
      findUnique: async (args: {
        where: { githubId?: number; email?: string; id?: string };
        select?: unknown;
      }) => {
        // Record any resolution via githubId column (must NOT happen).
        if ('githubId' in args.where && args.where.githubId !== undefined) {
          userByGithubIdLookups.push(args.where.githubId);
        }
        // Support the update-path: resolution by id (fine, expected).
        if ('id' in args.where && args.where.id === IDENTITY_LINK_USER_ID) {
          return { id: IDENTITY_LINK_USER_ID };
        }
        return null;
      },
      update: async (args: { where: { id: string }; data: unknown; select?: unknown }) => {
        // Simulate a successful profile refresh for the resolved user.
        return { id: args.where.id };
      },
      create: async (_args: unknown) => ({ id: 'unexpected-new-user' }),
      // establish reads the account's authorization facts by id for the session
      // payload (by id — NOT githubId, so it never trips the no-githubId-lookup
      // assertion this spec enforces).
      findUniqueOrThrow: async (_args: unknown) => ({
        role: 'member',
        mustChangePassword: false,
      }),
    },
    session: {
      create: async (_args: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        return {};
      },
    },
  };

  return {
    prisma,
    getIdentityLinkLookups: () => identityLinkLookups,
    getUserByGithubIdLookups: () => userByGithubIdLookups,
  };
}

function serviceOver(prisma: unknown): AuthSessionService {
  return new AuthSessionService(prisma as never, { recordIdentityLinked: () => {} } as never);
}

// ---------------------------------------------------------------------------
// Test 1: IdentityLink.findUnique is called with provider="github" and the
// numeric GitHub id as providerAccountId (string form).
// ---------------------------------------------------------------------------

test('identity decoupled from GitHub: identityLink.findUnique is called with provider="github" + numeric id', async () => {
  const { prisma, getIdentityLinkLookups } = buildFakePrisma();
  const svc = serviceOver(prisma);

  const env: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, env);

  assert.ok(result !== null, 'session must be established for an admitted user');

  const lookups = getIdentityLinkLookups();
  assert.ok(lookups.length >= 1, 'identityLink.findUnique must have been called at least once');

  const githubLookup = lookups.find(
    (l) => l.provider === 'github' && l.providerAccountId === String(GITHUB_USER.id),
  );
  assert.ok(
    githubLookup !== undefined,
    `identityLink.findUnique must be called with provider="github" and providerAccountId="${GITHUB_USER.id}" — got: ${JSON.stringify(lookups)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 2: The resolved session belongs to the user that the IdentityLink row
// points to — NOT to a user located via a githubId column.
// ---------------------------------------------------------------------------

test('identity decoupled from GitHub: session is minted for the user resolved via IdentityLink, not via githubId column', async () => {
  let mintedForUserId: string | undefined;

  const { prisma } = buildFakePrisma();

  // Intercept session.create to capture which userId the session is minted for.
  const originalSessionCreate = prisma.session.create.bind(prisma.session);
  (prisma.session as unknown as Record<string, unknown>).create = async (args: {
    data: { userId: string; tokenHash: string; expiresAt: Date };
  }) => {
    mintedForUserId = args.data.userId;
    return originalSessionCreate(args);
  };

  const svc = serviceOver(prisma);
  const env: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  const result = await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, env);

  assert.ok(result !== null, 'session must be established');
  assert.equal(
    mintedForUserId,
    IDENTITY_LINK_USER_ID,
    `session must be minted for the user resolved via IdentityLink (${IDENTITY_LINK_USER_ID}), got: ${mintedForUserId}`,
  );
});

// ---------------------------------------------------------------------------
// Test 3: The User table is NOT queried by githubId column during resolution.
// The identity is decoupled: the IdentityLink is the resolver, not User.githubId.
// ---------------------------------------------------------------------------

test('identity decoupled from GitHub: user.findUnique is NOT called with githubId during resolution', async () => {
  const { prisma, getUserByGithubIdLookups } = buildFakePrisma();
  const svc = serviceOver(prisma);

  const env: NodeJS.ProcessEnv = { AUTH_ALLOWLIST: String(GITHUB_USER.id) };
  await svc.establishSessionForGitHubUser(GITHUB_USER, ACCESS_TOKEN, env);

  const byGithubId = getUserByGithubIdLookups();
  assert.equal(
    byGithubId.length,
    0,
    `user.findUnique MUST NOT be called with githubId — the identity is resolved via IdentityLink, not the User.githubId column. Found calls with githubId: ${JSON.stringify(byGithubId)}`,
  );
});
