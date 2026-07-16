/**
 * repos-github-import — the GitHub-import surface scopes the account's OWN
 * connected GitHub PAT on the account primary key `user.id`, NOT on the GitHub
 * identity. A LOCAL account (password/OTP, `githubId === null`) that has
 * connected a GitHub PAT can list/import; a GitHub account is unaffected; the
 * per-account token never leaks across accounts; an IDENTITY-LESS principal (no
 * account at all) is still rejected with the distinct `github_auth_required`
 * signal (NOT a session 401).
 *
 * The controller's account-id gate and the service's `userId`-keyed token read are
 * exercised together with stub Prisma/HTTP boundaries — no live GitHub, no DB.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import type { AvailableGithubRepo, SessionUser } from '@cap/contracts';

import { GithubImportController } from './github-import.controller';
import {
  GithubAuthorizationRequiredException,
  GithubImportService,
} from './github-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GithubReposClient, GithubListResult } from './github-repos.client';
import type { ReposService } from './repos.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { encryptToStored } from '../settings/secret-storage';

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

const ORIGINAL_ENC_KEY = process.env.CODEX_CRED_ENC_KEY;
const TEST_ENC_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.CODEX_CRED_ENC_KEY = TEST_ENC_KEY;

after(() => {
  if (ORIGINAL_ENC_KEY === undefined) {
    delete process.env.CODEX_CRED_ENC_KEY;
  } else {
    process.env.CODEX_CRED_ENC_KEY = ORIGINAL_ENC_KEY;
  }
});

/**
 * A Prisma stub whose `forgeCredential.findUnique` returns each account's OWN
 * encrypted GitHub PAT keyed by `(userId, github, github.com)`. An account with no
 * entry yields `null`, the same signal as a missing token.
 */
function prismaWithPats(tokensByUserId: Record<string, string>): PrismaService {
  return {
    forgeCredential: {
      findUnique: async (args: {
        where: { userId_kind_host: { userId: string; kind: string; host: string } };
      }) => {
        const key = args.where.userId_kind_host;
        if (key.kind !== 'github' || key.host !== 'github.com') {
          return null;
        }
        const token = tokensByUserId[key.userId];
        return token === undefined
          ? null
          : { tokenCiphertext: encryptToStored(token) };
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

function githubService(
  prisma: PrismaService,
  client: GithubReposClient,
  repos: Pick<ReposService, 'reconcileVerifiedImport'> = {
    reconcileVerifiedImport: async () => {
      throw new Error('unexpected repo reconciliation');
    },
  } as Pick<ReposService, 'reconcileVerifiedImport'>,
): GithubImportService {
  return new GithubImportService(prisma, client, repos as ReposService);
}

// --- tests -----------------------------------------------------------------

test('LOCAL account (githubId=null) with a connected GitHub PAT can list repos', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithPats({ [LOCAL_ACCOUNT.id]: 'local-gh-pat' });
  const svc = githubService(prisma, client);
  const controller = new GithubImportController(svc);

  const out = await controller.listAvailable(reqFor(LOCAL_ACCOUNT));

  assert.equal(out.length, 1);
  assert.equal(out[0].full_name, 'owner/repo');
  // The PAT resolved was the LOCAL account's own (keyed on user.id), proving the
  // identity gate does not block a local account from importing.
  assert.deepEqual(seenTokens, ['local-gh-pat']);
});

test('GitHub account is unaffected — resolves ITS OWN PAT by user.id (no regression)', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithPats({ [GITHUB_ACCOUNT.id]: 'gh-pat' });
  const svc = githubService(prisma, client);
  const controller = new GithubImportController(svc);

  const out = await controller.listAvailable(reqFor(GITHUB_ACCOUNT));

  assert.equal(out.length, 1);
  assert.deepEqual(seenTokens, ['gh-pat']);
});

test('per-account isolation — account A never reads account B’s token', async () => {
  const prisma = prismaWithPats({
    [GITHUB_ACCOUNT.id]: 'A-pat',
    [OTHER_ACCOUNT.id]: 'B-pat',
  });

  const a = recordingClient();
  await new GithubImportController(
    githubService(prisma, a.client),
  ).listAvailable(reqFor(GITHUB_ACCOUNT));

  const b = recordingClient();
  await new GithubImportController(
    githubService(prisma, b.client),
  ).listAvailable(reqFor(OTHER_ACCOUNT));

  assert.deepEqual(a.seenTokens, ['A-pat'], 'A sees only A PAT');
  assert.deepEqual(b.seenTokens, ['B-pat'], 'B sees only B PAT');
});

test('account with NO connected GitHub PAT never borrows another account PAT', async () => {
  const { client, seenTokens } = recordingClient();
  // B has a PAT, but the local account does not: A still resolves null and the
  // client short-circuits to the auth-required failure.
  const prisma = prismaWithPats({ [OTHER_ACCOUNT.id]: 'B-pat' });
  const svc = githubService(prisma, client);
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
  assert.deepEqual(seenTokens, [null]);
});

test('account with NO connected GitHub PAT cannot import by posting a repo body directly', async () => {
  const { client } = recordingClient();
  const prisma = prismaWithPats({});
  const svc = githubService(prisma, client);
  const controller = new GithubImportController(svc);

  await assert.rejects(
    () =>
      controller.import(reqFor(LOCAL_ACCOUNT), {
        id: 1,
        full_name: 'owner/repo',
        defaultBranch: 'main',
        description: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof GithubAuthorizationRequiredException);
      const body = err.getResponse() as { error: string };
      assert.equal(body.error, 'github_auth_required');
      return true;
    },
  );
});

test('connected GitHub PAT cannot import a repo outside its visible list', async () => {
  const { client } = recordingClient([]);
  const prisma = prismaWithPats({ [LOCAL_ACCOUNT.id]: 'local-gh-pat' });
  const svc = githubService(prisma, client);
  const controller = new GithubImportController(svc);

  await assert.rejects(
    () =>
      controller.import(reqFor(LOCAL_ACCOUNT), {
        id: 1,
        full_name: 'owner/repo',
        defaultBranch: 'main',
        description: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ForbiddenException);
      const body = err.getResponse() as { error: string };
      assert.equal(body.error, 'github_repo_not_accessible');
      return true;
    },
  );
});

test('IDENTITY-LESS principal (machine/legacy token, user=null) is rejected at the boundary', async () => {
  const { client, seenTokens } = recordingClient();
  const prisma = prismaWithPats({});
  const svc = githubService(prisma, client);
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
