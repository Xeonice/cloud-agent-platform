import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';

import type { SandboxProvisionPlan } from '@cap/sandbox';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import { TaskBranchResolutionError } from '../forge/task-branch-resolver';
import type {
  CloneSpec,
  ProvisionLookup,
} from '../sandbox/provision-lookup.port';
import {
  GuardrailsService,
  type GuardrailsConfig,
} from './guardrails.service';

const TASK_ID = 'task-branch-policy';
const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};

function baseLookup(): ProvisionLookup {
  return {
    async getTaskLaunchContext() {
      return {
        modelIntent: { kind: 'runtime-default' },
        ownerUserId: 'owner-a',
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        workspaceMaterializationDeadlineMs: 321_000,
      };
    },
    async getCloneSpec() {
      return null;
    },
    async getTaskPrompt() {
      return null;
    },
    async getTaskSkills() {
      return [];
    },
    async getTaskRuntime() {
      return 'codex';
    },
    async getTaskExecutionMode() {
      return 'interactive-pty';
    },
  };
}

function provisionPlanner(lookup: ProvisionLookup): {
  resolveProvisionPlan(
    taskId: string,
  ): Promise<SandboxProvisionPlan<CloneSpec>>;
} {
  return new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    undefined,
    CONFIG,
    lookup,
  ) as unknown as {
    resolveProvisionPlan(
      taskId: string,
    ): Promise<SandboxProvisionPlan<CloneSpec>>;
  };
}

test('an adapter that omits canonical workspace planning retains legacy clone compatibility', async () => {
  let cloneLookups = 0;
  const lookup: ProvisionLookup = {
    ...baseLookup(),
    async getCloneSpec() {
      cloneLookups += 1;
      return { url: 'https://legacy.example.test/team/repo.git' };
    },
  };

  const plan = await provisionPlanner(lookup).resolveProvisionPlan(TASK_ID);

  assert.equal(cloneLookups, 1);
  assert.deepEqual(plan.cloneSpec, {
    url: 'https://legacy.example.test/team/repo.git',
  });
  assert.equal(plan.workspace, undefined);
});

for (const anomalousWorkspace of [null, undefined]) {
  test(`a present canonical resolver returning ${String(anomalousWorkspace)} fails closed`, async () => {
    let cloneLookups = 0;
    const lookup = {
      ...baseLookup(),
      async getCloneSpec() {
        cloneLookups += 1;
        return { url: 'https://legacy.example.test/team/repo.git' };
      },
      async getTaskWorkspacePlan() {
        return anomalousWorkspace;
      },
    } as unknown as ProvisionLookup;

    await assert.rejects(
      () => provisionPlanner(lookup).resolveProvisionPlan(TASK_ID),
      (error: unknown) => {
        assert.ok(error instanceof TaskBranchResolutionError);
        assert.equal(error.reason, 'repository_unavailable');
        return true;
      },
    );
    assert.equal(cloneLookups, 0);
  });
}

test('a canonical workspace plan suppresses every legacy clone lookup', async () => {
  let cloneLookups = 0;
  const lookup: ProvisionLookup = {
    ...baseLookup(),
    async getCloneSpec() {
      cloneLookups += 1;
      throw new Error('legacy clone lookup must not run');
    },
    async getTaskWorkspacePlan() {
      return {
        repositoryUrl: 'https://gitee.com/team/private.git',
        callerBranch: null,
        resolvedBranch: 'master',
        deadlineMs: 900_000,
      };
    },
  };

  const plan = await provisionPlanner(lookup).resolveProvisionPlan(TASK_ID);

  assert.equal(cloneLookups, 0);
  assert.equal(plan.cloneSpec, null);
  assert.equal(plan.workspace?.resolvedBranch, 'master');
  assert.equal(plan.workspace?.deadlineMs, 321_000);
});
