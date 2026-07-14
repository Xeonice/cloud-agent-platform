import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskFailureCode } from '@cap/contracts';
import { taskFailureFromRecord } from './task-failure';
import { taskResponseFromRecord } from './task-response';

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
    assert.equal(failure?.exitCode, 1);
    assert.match(failure?.message ?? '', expected.message);
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
