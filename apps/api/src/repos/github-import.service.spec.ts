/**
 * fix-large-repo-task-provisioning 4.3 — GitHub picker imports use the
 * requesting owner's server-side API candidate, not browser-supplied metadata.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { GithubImportService } from './github-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GithubReposClient } from './github-repos.client';
import type { RepoResponse } from '@cap/contracts';
import type { RepoCopyService } from './repo-copy.service';
import type { ReposService, VerifiedRepoImport } from './repos.service';
import { encryptToStored } from '../settings/secret-storage';

const ORIGINAL_KEY = process.env.CODEX_CRED_ENC_KEY;
process.env.CODEX_CRED_ENC_KEY = '1'.repeat(64);
after(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.CODEX_CRED_ENC_KEY;
  else process.env.CODEX_CRED_ENC_KEY = ORIGINAL_KEY;
});

test('private GitHub picker persists server-verified master with the current owner PAT', async () => {
  const credentialLookups: unknown[] = [];
  const seenTokens: Array<string | null> = [];
  let captured: VerifiedRepoImport | undefined;
  const tokensByOwner: Record<string, string> = {
    'owner-a': 'owner-a-github-pat',
    'owner-b': 'owner-b-github-pat',
  };
  const prisma = {
    forgeCredential: {
      findUnique: async (args: {
        where: { userId_kind_host: { userId: string } };
      }) => {
        credentialLookups.push(args);
        const token = tokensByOwner[args.where.userId_kind_host.userId];
        return token ? { tokenCiphertext: encryptToStored(token) } : null;
      },
    },
  } as unknown as PrismaService;
  const github = {
    listForOperator: async (token: string | null) => {
      seenTokens.push(token);
      return {
        ok: true as const,
        repos: [
          {
            id: 5,
            full_name: 'o/r',
            name: 'r',
            defaultBranch: 'master',
            visibility: 'private' as const,
            description: 'verified description',
          },
        ],
      };
    },
  } as GithubReposClient;
  const repos = {
    reconcileVerifiedImport: async (input: VerifiedRepoImport) => {
      captured = input;
      return {
        id: '22222222-2222-4222-8222-222222222222',
        name: input.name,
        gitSource: input.gitSource,
        createdAt: new Date(0),
        description: input.description ?? null,
        defaultBranch: input.defaultBranch,
        branchCount: null,
        updatedAt: null,
        githubId: input.githubId ?? null,
        isDefault: false,
        forge: input.forge,
      };
    },
  } as ReposService;
  // add-repo-content-store: the picker import also acquires the repo-store copy.
  // Record what the copy seam is handed so the spec can prove the import passes
  // the account's OWN PAT as an http auth header (never in the clone URL).
  const acquisitions: Array<{ gitSource: string; authHeader?: string }> = [];
  const copies = {
    acquireOnImport: async (repo: RepoResponse, authHeader?: string) => {
      acquisitions.push({
        gitSource: repo.gitSource,
        ...(authHeader === undefined ? {} : { authHeader }),
      });
      return { ...repo, copyStatus: 'ready' as const, copyUpdatedAt: new Date(1) };
    },
  } as RepoCopyService;
  const svc = new GithubImportService(prisma, github, repos, copies);

  const response = await svc.importRepoForOperator('owner-a', {
    id: 5,
    full_name: 'o/r',
    // Deliberately stale/forged: the server candidate must win.
    defaultBranch: 'main',
    description: 'browser value',
  });

  assert.deepEqual(credentialLookups, [
    {
      where: {
        userId_kind_host: {
          userId: 'owner-a',
          kind: 'github',
          host: 'github.com',
        },
      },
      select: { tokenCiphertext: true },
    },
  ]);
  assert.deepEqual(seenTokens, ['owner-a-github-pat']);
  assert.equal(captured?.defaultBranch, 'master');
  assert.equal(captured?.description, 'verified description');
  assert.equal(captured?.githubId, 'gh:5');
  assert.equal(captured?.gitSource, 'https://github.com/o/r.git');
  assert.equal(response.defaultBranch, 'master');
  assert.equal(response.forge, 'github');

  // add-repo-content-store (3.1): the GitHub picker import completes only with a
  // ready content copy, cloned from the canonical https source with the SAME
  // account PAT the listing was authorized by — carried as an http auth header,
  // never embedded in the clone URL.
  assert.deepEqual(acquisitions, [
    {
      gitSource: 'https://github.com/o/r.git',
      authHeader: `Authorization: Basic ${Buffer.from(
        'x-access-token:owner-a-github-pat',
      ).toString('base64')}`,
    },
  ]);
  assert.equal(acquisitions[0].authHeader?.includes('owner-a-github-pat'), false);
  assert.equal(response.copyStatus, 'ready');
});
