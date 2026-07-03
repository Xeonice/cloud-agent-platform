/**
 * add-multi-forge-task-delivery — ReposService source-forge detection (8.2).
 *
 * `create` records `Repo.forge`: explicit when supplied, else inferred from the
 * gitSource public host (github.com / gitlab.com / gitee.com), else null for a
 * self-hosted / unknown host. Echoed on the response. A picker/by-URL import thus
 * lands a forge-correct row (NOT github.com / NOT forge=null for gitlab/gitee).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRepoGitSource, ReposService } from './repos.service';
import type { PrismaService } from '../prisma/prisma.service';

function repoRow(overrides: Partial<{
  id: string;
  name: string;
  gitSource: string;
  forge: string | null;
}> = {}) {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
    name: overrides.name ?? 'repo',
    gitSource: overrides.gitSource ?? 'https://gitlab.com/g/p.git',
    createdAt: new Date(0),
    description: null,
    defaultBranch: null,
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
    forge: overrides.forge ?? null,
  };
}

function service(existing: ReturnType<typeof repoRow> | null = null) {
  let captured: { name: string; gitSource: string; forge: string | null } | undefined;
  const prisma = {
    repo: {
      findFirst: async () => existing,
      create: async (args: { data: { name: string; gitSource: string; forge: string | null } }) => {
        captured = args.data;
        return repoRow(args.data);
      },
    },
  } as unknown as PrismaService;
  return { svc: new ReposService(prisma), captured: () => captured };
}

test('infers gitlab from the gitSource host and echoes it', async () => {
  const { svc, captured } = service();
  const res = await svc.create({ name: 'p', gitSource: 'https://gitlab.com/g/p.git' });
  assert.equal(captured()?.forge, 'gitlab');
  assert.equal(res.forge, 'gitlab');
});

test('infers github and gitee from their hosts', async () => {
  const gh = service();
  await gh.svc.create({ name: 'r', gitSource: 'https://github.com/o/r.git' });
  assert.equal(gh.captured()?.forge, 'github');

  const ge = service();
  await ge.svc.create({ name: 'r', gitSource: 'https://gitee.com/o/r.git' });
  assert.equal(ge.captured()?.forge, 'gitee');
});

test('explicit forge wins over host inference', async () => {
  const { svc, captured } = service();
  const res = await svc.create({
    name: 'app',
    gitSource: 'https://git.corp.com/team/app.git/',
    forge: 'gitlab',
  });
  assert.equal(captured()?.forge, 'gitlab');
  assert.equal(captured()?.gitSource, 'https://git.corp.com/team/app.git');
  assert.equal(res.forge, 'gitlab');
});

test('self-hosted host with no explicit forge → null', async () => {
  const { svc, captured } = service();
  const res = await svc.create({ name: 'app', gitSource: 'https://git.corp.com/team/app.git' });
  assert.equal(captured()?.forge, null);
  assert.equal(res.forge ?? null, null);
});

test('normalizes http clone URLs and strips query/hash/trailing slash', async () => {
  assert.equal(
    normalizeRepoGitSource(' HTTPS://GITEE.COM/team/app.git/?utm=1#readme '),
    'https://gitee.com/team/app.git',
  );
});

test('rejects credential-bearing clone URLs', async () => {
  try {
    normalizeRepoGitSource('https://token:gitee-secret@gitee.com/team/app.git');
    assert.fail('expected credential-bearing URL to throw');
  } catch (err) {
    const response = (err as { getResponse?: () => unknown }).getResponse?.();
    assert.equal(
      (response as { error?: string }).error,
      'repo_git_source_credentials_forbidden',
    );
  }
});

test('duplicate normalized gitSource returns existing repo instead of creating', async () => {
  const existing = repoRow({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'already',
    gitSource: 'https://gitee.com/team/app.git',
    forge: 'gitee',
  });
  const { svc, captured } = service(existing);
  const res = await svc.create({
    name: 'new name',
    gitSource: 'https://gitee.com/team/app.git/',
    forge: 'gitee',
  });
  assert.equal(captured(), undefined);
  assert.equal(res.id, existing.id);
  assert.equal(res.name, 'already');
  assert.equal(res.gitSource, 'https://gitee.com/team/app.git');
});
