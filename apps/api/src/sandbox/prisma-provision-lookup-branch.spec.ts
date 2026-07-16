import assert from 'node:assert/strict';
import test from 'node:test';

import type { PrismaService } from '../prisma/prisma.service';
import type { DefaultForgeRegistry } from '../forge/forge-registry';
import type { ForgeTargetResolver } from '../forge/forge-target-resolver';
import {
  TaskBranchResolutionError,
  type TaskBranchResolver,
} from '../forge/task-branch-resolver';
import { PrismaProvisionLookup } from './prisma-provision-lookup';

const TASK_ID = 'task-clone-branch';
const GIT_SOURCE = 'https://gitee.com/team/private.git';

function prismaWithRepo(
  gitSource: string | null,
  workspaceMaterializationDeadlineMs: number | null = null,
): PrismaService {
  return {
    task: {
      findUnique: async () => ({
        repo: gitSource === null ? null : { gitSource },
      }),
    },
    taskAdmissionWork: {
      findUnique: async () =>
        workspaceMaterializationDeadlineMs === null
          ? null
          : { workspaceMaterializationDeadlineMs },
    },
  } as unknown as PrismaService;
}

test('canonical workspace planning and recovery reuse the shared branch resolver', async () => {
  const branchCalls: string[] = [];
  const branchResolver = {
    async resolve(taskId: string) {
      branchCalls.push(taskId);
      return {
        taskId,
        repositoryUrl: GIT_SOURCE,
        callerBranch: null,
        resolvedBranch: 'master',
        source: branchCalls.length === 1 ? 'repo-default-branch' : 'snapshot',
        snapshotted: true,
      };
    },
  } as unknown as TaskBranchResolver;
  const lookup = new PrismaProvisionLookup(
    prismaWithRepo(GIT_SOURCE, 123_456),
    undefined,
    undefined,
    undefined,
    branchResolver,
  );

  const first = await lookup.getTaskWorkspacePlan(TASK_ID);
  const previousMutableFallback = process.env.BOXLITE_GIT_CLONE_TIMEOUT_MS;
  process.env.BOXLITE_GIT_CLONE_TIMEOUT_MS = '7654321';
  const recovery = await lookup.getTaskWorkspacePlan(TASK_ID);
  if (previousMutableFallback === undefined) {
    delete process.env.BOXLITE_GIT_CLONE_TIMEOUT_MS;
  } else {
    process.env.BOXLITE_GIT_CLONE_TIMEOUT_MS = previousMutableFallback;
  }

  assert.deepEqual(first, {
    repositoryUrl: GIT_SOURCE,
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 123_456,
  });
  assert.deepEqual(recovery, first);
  assert.deepEqual(branchCalls, [TASK_ID, TASK_ID]);
});

test('typed branch failure stops clone lookup before any provider input is returned', async () => {
  const branchResolver = {
    async resolve() {
      throw new TaskBranchResolutionError('branch_not_found');
    },
  } as unknown as TaskBranchResolver;
  const lookup = new PrismaProvisionLookup(
    prismaWithRepo(GIT_SOURCE),
    undefined,
    undefined,
    undefined,
    branchResolver,
  );

  await assert.rejects(
      () => lookup.getTaskWorkspacePlan(TASK_ID),
    (error: unknown) => {
      assert.ok(error instanceof TaskBranchResolutionError);
      assert.equal(error.failureCode, 'provisioning_ref_not_found');
      return true;
    },
  );
});

test('canonical private plan carries only an opaque exact-host credential descriptor', async () => {
  const branchResolver = {
    async resolve(taskId: string) {
      return {
        taskId,
        repositoryUrl: GIT_SOURCE,
        callerBranch: null,
        resolvedBranch: 'master',
        source: 'snapshot',
        snapshotted: true,
      };
    },
  } as unknown as TaskBranchResolver;
  const target = {
    kind: 'gitee' as const,
    apiBaseUrl: 'https://gitee.com/api/v5',
    cloneUrl: GIT_SOURCE,
    repoId: { style: 'owner-repo' as const, owner: 'team', repo: 'private' },
    token: 'private-owner-token-canary',
  };
  const lookup = new PrismaProvisionLookup(
    prismaWithRepo(GIT_SOURCE),
    {
      getForgeTarget: async () => target,
    } as unknown as ForgeTargetResolver,
    {
      forKind: () => ({
        cloneAuthHeader: () =>
          'Authorization: Basic private-owner-header-canary',
      }),
    } as unknown as DefaultForgeRegistry,
    undefined,
    branchResolver,
  );

  const plan = await lookup.getTaskWorkspacePlan(TASK_ID);

  assert.ok(plan?.credential);
  assert.equal(plan.credential.host, 'gitee.com');
  assert.equal(plan.credential.urlPrefix, 'https://gitee.com/');
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes('private-owner-token-canary'), false);
  assert.equal(serialized.includes('private-owner-header-canary'), false);
  assert.equal(serialized.includes('[REDACTED]'), true);
});
