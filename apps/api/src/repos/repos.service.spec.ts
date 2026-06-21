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

import { ReposService } from './repos.service';
import type { PrismaService } from '../prisma/prisma.service';

function service() {
  let captured: { forge: string | null } | undefined;
  const prisma = {
    repo: {
      create: async (args: { data: { name: string; gitSource: string; forge: string | null } }) => {
        captured = { forge: args.data.forge };
        return {
          id: '11111111-1111-4111-8111-111111111111',
          name: args.data.name,
          gitSource: args.data.gitSource,
          createdAt: new Date(0),
          description: null,
          defaultBranch: null,
          branchCount: null,
          updatedAt: null,
          githubId: null,
          isDefault: false,
          forge: args.data.forge,
        };
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
    gitSource: 'https://git.corp.com/team/app.git',
    forge: 'gitlab',
  });
  assert.equal(captured()?.forge, 'gitlab');
  assert.equal(res.forge, 'gitlab');
});

test('self-hosted host with no explicit forge → null', async () => {
  const { svc, captured } = service();
  const res = await svc.create({ name: 'app', gitSource: 'https://git.corp.com/team/app.git' });
  assert.equal(captured()?.forge, null);
  assert.equal(res.forge ?? null, null);
});
