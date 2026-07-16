import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import type { DefaultForgeRegistry } from '../forge/forge-registry';
import type { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { TaskBranchResolutionError } from '../forge/task-branch-resolver';
import { PrismaProvisionLookup } from './prisma-provision-lookup';

const TASK_ID = 'task-no-implicit-head';

test('production Prisma lookup never derives a legacy clone from TASK_REPO_URL or a bare repo URL', async () => {
  const previous = process.env.TASK_REPO_URL;
  process.env.TASK_REPO_URL = 'https://global.example.test/fallback.git';
  let taskReads = 0;
  let forgeLookups = 0;
  try {
    const lookup = new PrismaProvisionLookup(
      {
        task: {
          async findUnique() {
            taskReads += 1;
            return {
              repo: { gitSource: 'https://gitee.com/team/private.git' },
            };
          },
        },
      } as unknown as PrismaService,
      {
        async getForgeTarget() {
          forgeLookups += 1;
          return null;
        },
      } as unknown as ForgeTargetResolver,
      {
        forKind() {
          assert.fail('legacy clone auth must not be resolved');
        },
      } as unknown as DefaultForgeRegistry,
    );

    await assert.rejects(
      () => lookup.getCloneSpec(TASK_ID),
      (error: unknown) => {
        assert.ok(error instanceof TaskBranchResolutionError);
        assert.equal(error.reason, 'repository_unavailable');
        return true;
      },
    );
    assert.equal(taskReads, 0);
    assert.equal(forgeLookups, 0);
  } finally {
    if (previous === undefined) delete process.env.TASK_REPO_URL;
    else process.env.TASK_REPO_URL = previous;
  }
});

test('production workspace planning fails closed when its branch resolver is not configured', async () => {
  const lookup = new PrismaProvisionLookup({} as PrismaService);

  await assert.rejects(
    () => lookup.getTaskWorkspacePlan(TASK_ID),
    /Task branch resolver is not configured/u,
  );
});
