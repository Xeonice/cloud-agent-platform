/**
 * add-multi-forge-task-delivery (R.1) — the GitHub import write records its forge.
 *
 * `POST /repos/github/import` must land `forge='github'` (never null) so detection
 * step (1) is populated for every imported repo, and echo it on the response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { GithubImportService } from './github-import.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GithubReposClient } from './github-repos.client';

test('github import write records forge=github and echoes it', async () => {
  let captured: { forge: string | null; gitSource: string } | undefined;
  const prisma = {
    repo: {
      findMany: async () => [],
      create: async (args: {
        data: {
          name: string;
          gitSource: string;
          githubId: string;
          defaultBranch: string;
          description: string | null;
          forge: string | null;
        };
      }) => {
        captured = { forge: args.data.forge, gitSource: args.data.gitSource };
        return {
          id: '22222222-2222-4222-8222-222222222222',
          name: args.data.name,
          gitSource: args.data.gitSource,
          createdAt: new Date(0),
          description: args.data.description,
          defaultBranch: args.data.defaultBranch,
          branchCount: null,
          updatedAt: null,
          githubId: args.data.githubId,
          isDefault: false,
          forge: args.data.forge,
        };
      },
    },
  } as unknown as PrismaService;
  const svc = new GithubImportService(prisma, {} as unknown as GithubReposClient);

  const res = await svc.importRepo({ id: 5, full_name: 'o/r', defaultBranch: 'main' });

  assert.equal(captured?.forge, 'github');
  assert.equal(captured?.gitSource, 'https://github.com/o/r.git');
  assert.equal(res.forge, 'github');
});
