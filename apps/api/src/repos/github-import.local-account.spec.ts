/**
 * fix-local-account-settings-scope (repos-github-import) — the GitHub-import
 * surface scopes the account's OWN GitHub OAuth token on the account primary key
 * `user.id`, NOT on the GitHub identity. A LOCAL account (password/OTP,
 * `githubId === null`) that has separately connected a `github` IdentityLink can
 * list/import; a GitHub account is unaffected; the per-account token never leaks
 * across accounts; an IDENTITY-LESS principal (no account at all) is still
 * rejected with the distinct `github_auth_required` signal (NOT a session 401).
 *
 * The controller's account-id gate and the service's `userId`-keyed token read are
 * exercised together with stub Prisma/HTTP boundaries — no live GitHub, no DB.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AvailableGithubRepo, SessionUser } from '@cap/contracts';

import { GithubImportController } from './github-import.controller';
import {
  GithubAuthorizationRequiredException,
  GithubImportService,
} from './github-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GithubReposClient, GithubListResult } from './github-repos.client';
import type { AuthenticatedRequest } from '../auth/auth.guard';

// --- fixtures --------------------------------------------------------------

/** A complete SessionUser with the required `id`; vary the discriminating fields. */
function sessionUser(overrides: Partial<SessionUser> & Pick<SessionUser, 'id'>): SessionUser {
  return {
    id: overrides.id,
    githubId: overrides.githubId ?? null,
    login: overrides.login ?? null,
    name: overrides.name ?? 'Test Account',
    avatarUrl: overrides.avatarUrl ?? null,
    allowed: overrides.allowed ?? true,
    role: overrides.role ?? 'member',
    mustChangePassword: overrides.mustChangePassword ?? false,
  };
}

/** A LOCAL account: no GitHub identity on the principal (githubId === null). */
const LOCAL_ACCOUNT = sessionUser({
  id: 'local-user-1111-4111-8111-111111111111',
  githubId: null,
  login: null,
  name: 'Local Operator',
});

/** A GitHub-provisioned account: carries a numeric githubId. */
const GITHUB_ACCOUNT = sessionUser({
  id: 'gh-user-2222-4222-8222-222222222222',
  githubId: 4242,
  login: 'octocat',
  name: 'Octo Cat',
});

/** A SECOND account, to prove per-account token isolation. */
const OTHER_ACCOUNT = sessionUser({
  id: 'other-user-3333-4333-8333-333333333333',
  githubId: 9999,
  login: 'otheruser',
  name: 'Other',
});

const SAMPLE_REPO: AvailableGithubRepo = {
  id: 1,
  full_name: 'owner/repo',
  name: 'repo',
  visibility: 'public',
  defaultBranch: 'main',
  description: null,
};

/**
 * A Prisma stub whose `identityLink.findFirst` returns each account's OWN secret
 * keyed by `userId` (the FK on the github IdentityLink) — exactly the query
 * `getGithubTokenForUser({ where: { userId, provider } })` makes. An account with
 * no entry (a local account that never connected GitHub) yields `null`, the same
 * signal as a missing token.
 */
function prismaWithTokens(tokensByUserId: Record<string, string>): PrismaService {
  return {
    identityLink: {
      findFirst: async (args: { where: { userId: string; provider: string } }) => {
        const secret = tokensByUserId[args.where.userId];
        return secret === undefined ? null : { secret };
      },
    },
    repo: {
      // listAvailableReconciled also reconciles against imported repos.
      findMany: async () => [],
    },
  } as unknown as PrismaService;
}

/** A GithubReposClient stub that records the token it was handed, then succeeds. */
function recordingClient(repos: AvailableGithubRepo[] = [SAMPLE_REPO]): {
  client: GithubReposClient;
  seenTokens: Array<string | null>;
} {
  const seenTokens: Array<string | null> = [];
  const client = {
    listForOperator: async (accessToken: string | null): Promise<GithubListResult> => {
      seenTokens.push(accessToken);
      if (accessToken === null || accessToken.length === 0) {
        return { ok: false, error: { code: 'github_auth_required', retryable: false } };
      }
      return { ok: true, repos };
    },
  } as unknown as GithubReposClient;
  return { client, seenTokens };
}

function reqFor(user: SessionUser | null): AuthenticatedRequest {
  return {
    operatorPrincipal: user
      ? { kind: 'session', user }
      : { kind: 'legacy-token', user: null },
  } as unknown as AuthenticatedRequest;
}

// --- tests -----------------------------------------------------------------

test('LOCAL account (githubId=null) with a connected github identity can list repos', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithTokens({ [LOCAL_ACCOUNT.id]: 'local-gh-token' });
  const svc = new GithubImportService(prisma, client);
  const controller = new GithubImportController(svc);

  const out = await controller.listAvailable(reqFor(LOCAL_ACCOUNT));

  assert.equal(out.length, 1);
  assert.equal(out[0].full_name, 'owner/repo');
  // The token resolved was the LOCAL account's own (keyed on user.id), proving the
  // identity gate no longer blocks a local account from importing.
  assert.deepEqual(seenTokens, ['local-gh-token']);
});

test('GitHub account is unaffected — resolves ITS OWN token by user.id (no regression)', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithTokens({ [GITHUB_ACCOUNT.id]: 'gh-token' });
  const svc = new GithubImportService(prisma, client);
  const controller = new GithubImportController(svc);

  const out = await controller.listAvailable(reqFor(GITHUB_ACCOUNT));

  assert.equal(out.length, 1);
  assert.deepEqual(seenTokens, ['gh-token']);
});

test('per-account isolation — account A never reads account B’s token', async () => {
  const prisma = prismaWithTokens({
    [GITHUB_ACCOUNT.id]: 'A-token',
    [OTHER_ACCOUNT.id]: 'B-token',
  });

  const a = recordingClient();
  await new GithubImportController(
    new GithubImportService(prisma, a.client),
  ).listAvailable(reqFor(GITHUB_ACCOUNT));

  const b = recordingClient();
  await new GithubImportController(
    new GithubImportService(prisma, b.client),
  ).listAvailable(reqFor(OTHER_ACCOUNT));

  assert.deepEqual(a.seenTokens, ['A-token'], 'A sees only A token');
  assert.deepEqual(b.seenTokens, ['B-token'], 'B sees only B token');
});

test('account with NO connected github identity gets github_auth_required (not an empty list)', async () => {
  const { client } = recordingClient();
  // No entry for the local account → getGithubTokenForUser returns null → client
  // short-circuits to the auth-required failure.
  const prisma = prismaWithTokens({});
  const svc = new GithubImportService(prisma, client);
  const controller = new GithubImportController(svc);

  await assert.rejects(
    () => controller.listAvailable(reqFor(LOCAL_ACCOUNT)),
    (err: unknown) => {
      assert.ok(err instanceof GithubAuthorizationRequiredException);
      const body = err.getResponse() as { error: string };
      assert.equal(body.error, 'github_auth_required');
      return true;
    },
  );
});

test('IDENTITY-LESS principal (machine/legacy token, user=null) is rejected at the boundary', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithTokens({});
  const svc = new GithubImportService(prisma, client);
  const controller = new GithubImportController(svc);

  await assert.rejects(
    () => controller.listAvailable(reqFor(null)),
    (err: unknown) => {
      assert.ok(err instanceof GithubAuthorizationRequiredException);
      const body = err.getResponse() as { error: string };
      assert.equal(body.error, 'github_auth_required');
      return true;
    },
  );
  // The gate rejects BEFORE any token read / GitHub call for an identity-less caller.
  assert.deepEqual(seenTokens, [], 'no token resolution attempted for a principal with no account');
});
