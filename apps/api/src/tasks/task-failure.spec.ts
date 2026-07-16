import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskFailureCode } from '@cap/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import { taskFailureFromRecord } from './task-failure';
import { taskResponseFromRecord } from './task-response';
import { TasksService } from './tasks.service';

const FAILURE_AT = new Date('2026-07-12T12:32:31.000Z');

test('model failure columns project to fixed actionable public failures', () => {
  const cases: Array<{
    code: TaskFailureCode;
    action: 'retry_task' | 'choose_another_model';
    message: RegExp;
  }> = [
    {
      code: 'runtime_model_setup_failed',
      action: 'retry_task',
      message: /Codex.*安全准备.*模型/,
    },
    {
      code: 'runtime_model_rejected',
      action: 'choose_another_model',
      message: /Codex.*拒绝.*模型/,
    },
  ];

  for (const expected of cases) {
    const failure = taskFailureFromRecord({
      runtime: 'codex',
      failureCode: expected.code,
      failureAt: FAILURE_AT,
      failureExitCode: 1,
    });

    assert.equal(failure?.code, expected.code);
    assert.equal(failure?.action, expected.action);
    assert.ok(failure && 'exitCode' in failure);
    assert.equal(failure.exitCode, 1);
    assert.match(failure?.message ?? '', expected.message);
  }
});

test('provisioning failure columns project to fixed secret-free public failures', () => {
  const unsafeCanary =
    'token=secret-canary endpoint=https://private.invalid fatal: clone failed';
  const cases = [
    {
      code: 'provisioning_capacity_exhausted',
      action: 'increase_sandbox_capacity',
      message: /存储空间不足.*增加磁盘容量/,
    },
    {
      code: 'provisioning_workspace_timeout',
      action: 'retry_task',
      message: /工作区准备超时.*重试/,
    },
    {
      code: 'provisioning_forge_auth_failed',
      action: 'reconnect_forge',
      message: /身份验证失败.*重新连接/,
    },
    {
      code: 'provisioning_tls_network_failed',
      action: 'retry_task',
      message: /TLS 或网络错误.*重试/,
    },
    {
      code: 'provisioning_ref_not_found',
      action: 'verify_repository_ref',
      message: /未找到.*分支或引用.*确认/,
    },
    {
      code: 'provisioning_unknown',
      action: 'retry_task',
      message: /环境准备失败.*重试/,
    },
  ] as const;

  for (const expected of cases) {
    const failure = taskFailureFromRecord({
      runtime: unsafeCanary,
      failureCode: expected.code,
      failureAt: FAILURE_AT,
      failureExitCode: 128,
    });

    assert.equal(failure?.code, expected.code);
    assert.equal(failure?.action, expected.action);
    assert.match(failure?.message ?? '', expected.message);
    assert.ok(failure && !('runtime' in failure));
    assert.equal('exitCode' in failure, false);
    assert.equal(JSON.stringify(failure).includes('secret-canary'), false);
    assert.equal(JSON.stringify(failure).includes('private.invalid'), false);
  }
});

test('task response projects only the strict public provisioning summary', () => {
  const unsafeCanary =
    'token=secret-canary endpoint=https://provider.invalid command=git clone';
  const persistedWorkWithInternalFields = {
    state: 'running',
    stage: 'workspace_transfer',
    attempt: 2,
    resolvedBranch: 'master',
    updatedAt: new Date('2026-07-12T12:31:00.000Z'),
    leaseOwner: unsafeCanary,
    providerSandboxId: unsafeCanary,
    diagnostic: unsafeCanary,
  };
  const response = taskResponseFromRecord({
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'clone the repository',
    status: 'running',
    createdAt: new Date('2026-07-12T12:30:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    admissionWork: persistedWorkWithInternalFields,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  });

  assert.deepEqual(response.provisioning, {
    state: 'running',
    stage: 'workspace_transfer',
    attempt: 2,
    resolvedBranch: 'master',
    updatedAt: new Date('2026-07-12T12:31:00.000Z'),
  });
  const serialized = JSON.stringify(response.provisioning);
  assert.equal(serialized.includes(unsafeCanary), false);
  for (const internalField of [
    'leaseOwner',
    'leaseUntil',
    'providerSandboxId',
    'connection',
    'command',
    'credential',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(response.provisioning, internalField),
      false,
    );
  }
});

test('legacy task response explicitly projects null provisioning', () => {
  const response = taskResponseFromRecord({
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'legacy task',
    status: 'completed',
    createdAt: new Date('2026-07-12T12:30:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  });

  assert.equal(response.provisioning, null);
});

test('list get and terminal stop share the safe provisioning projection', async () => {
  const unsafeCanary =
    'Bearer secret-canary https://provider.invalid git -c http.extraHeader=...';
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'large private repository',
    status: 'failed',
    lifecycleVersion: 4,
    failureCode: 'provisioning_capacity_exhausted',
    failureAt: FAILURE_AT,
    failureExitCode: null,
    createdAt: new Date('2026-07-12T12:30:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    admissionWork: {
      state: 'failed',
      stage: 'workspace_transfer',
      attempt: 2,
      resolvedBranch: 'master',
      updatedAt: new Date('2026-07-12T12:31:00.000Z'),
      leaseOwner: unsafeCanary,
      providerSandboxId: unsafeCanary,
      diagnostic: unsafeCanary,
    },
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  };
  const service = new TasksService({
    task: {
      async findMany() {
        return [record];
      },
      async findUnique() {
        return record;
      },
    },
  } as unknown as PrismaService);

  const [listed] = await service.list();
  const fetched = await service.findById(record.id);
  const stopped = await service.stop(record.id);
  for (const response of [listed, fetched, stopped]) {
    assert.equal(response?.failure?.code, 'provisioning_capacity_exhausted');
    assert.deepEqual(response?.provisioning, {
      state: 'failed',
      stage: 'workspace_transfer',
      attempt: 2,
      resolvedBranch: 'master',
      updatedAt: new Date('2026-07-12T12:31:00.000Z'),
    });
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes('secret-canary'), false);
    assert.equal(serialized.includes('provider.invalid'), false);
    assert.equal(serialized.includes('extraHeader'), false);
  }
});

test('model rejection projection retains requested task model independently', () => {
  const response = taskResponseFromRecord({
    id: '11111111-1111-4111-8111-111111111111',
    repoId: '22222222-2222-4222-8222-222222222222',
    prompt: 'use the requested model',
    status: 'failed',
    failureCode: 'runtime_model_rejected',
    failureAt: FAILURE_AT,
    failureExitCode: 1,
    createdAt: new Date('2026-07-12T12:30:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'claude-code',
    model: 'provider/requested-selector',
    sandboxEnvironmentId: null,
    executionMode: 'headless-exec',
    deliver: 'none',
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  });

  assert.equal(response.model, 'provider/requested-selector');
  assert.equal(response.failure?.code, 'runtime_model_rejected');
  assert.equal(response.failure?.action, 'choose_another_model');
});
