import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTaskLogContext,
  runWithTaskLog,
  runWithTaskProvisioningAttemptLog,
  runWithTaskProvisioningOperationLog,
  type TaskProvisioningAttemptLogContext,
  type TaskProvisioningOperationLogContext,
} from './log-context';
import { buildLoggerOptions } from './logger.options';

const TASK_A = '11111111-1111-4111-8111-111111111111';
const TASK_B = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPERATION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function loggerMixin(): Record<string, unknown> {
  const pinoHttp = buildLoggerOptions().pinoHttp;
  assert.equal(typeof pinoHttp, 'object');
  assert.notEqual(pinoHttp, null);
  const mixin = (pinoHttp as { mixin?: () => Record<string, unknown> }).mixin;
  if (typeof mixin !== 'function') assert.fail('logger mixin is not configured');
  return mixin();
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('legacy runWithTaskLog remains task-only and restores the outer scope', async () => {
  assert.equal(getTaskLogContext(), undefined);
  assert.deepEqual(loggerMixin(), {});

  await runWithTaskLog('legacy-task-id', async () => {
    assert.deepEqual(getTaskLogContext(), { taskId: 'legacy-task-id' });
    assert.deepEqual(loggerMixin(), { taskId: 'legacy-task-id' });
    await nextTurn();
    assert.deepEqual(getTaskLogContext(), { taskId: 'legacy-task-id' });
  });

  assert.equal(getTaskLogContext(), undefined);
  assert.deepEqual(loggerMixin(), {});
});

test('attempt and operation wrappers merge nested safe context and restore on exit', async () => {
  const attemptInput = {
    taskId: TASK_A,
    attemptId: ATTEMPT_A,
    attempt: 2,
    leaseToken: 'lease-canary-must-not-enter-context',
    providerSandboxId: 'raw-provider-sandbox-canary',
  } as TaskProvisioningAttemptLogContext & {
    readonly leaseToken: string;
    readonly providerSandboxId: string;
  };
  const operationInput = {
    stage: 'runtime_setup',
    operationId: OPERATION_A,
    command: 'command-canary-must-not-enter-context',
    stdout: 'stdout-canary-must-not-enter-context',
    rawProviderError: 'provider-error-canary-must-not-enter-context',
  } as TaskProvisioningOperationLogContext & {
    readonly command: string;
    readonly stdout: string;
    readonly rawProviderError: string;
  };

  await runWithTaskLog(TASK_A, async () => {
    assert.deepEqual(getTaskLogContext(), { taskId: TASK_A });

    await runWithTaskProvisioningAttemptLog(attemptInput, async () => {
      const attemptContext = {
        taskId: TASK_A,
        attemptId: ATTEMPT_A,
        attempt: 2,
      };
      assert.deepEqual(getTaskLogContext(), attemptContext);
      assert.deepEqual(loggerMixin(), attemptContext);

      await runWithTaskProvisioningOperationLog(operationInput, async () => {
        const operationContext = {
          ...attemptContext,
          stage: 'runtime_setup',
          operationId: OPERATION_A,
        };
        assert.deepEqual(getTaskLogContext(), operationContext);
        assert.deepEqual(loggerMixin(), operationContext);
        assert.equal('leaseToken' in loggerMixin(), false);
        assert.equal('providerSandboxId' in loggerMixin(), false);
        assert.equal('command' in loggerMixin(), false);
        assert.equal('stdout' in loggerMixin(), false);
        assert.equal('rawProviderError' in loggerMixin(), false);
        await nextTurn();
        assert.deepEqual(getTaskLogContext(), operationContext);
      });

      assert.deepEqual(getTaskLogContext(), attemptContext);
    });

    assert.deepEqual(getTaskLogContext(), { taskId: TASK_A });
  });

  assert.equal(getTaskLogContext(), undefined);
});

test('concurrent provisioning log scopes do not contaminate each other', async () => {
  const traces = await Promise.all([
    runWithTaskProvisioningAttemptLog(
      { taskId: TASK_A, attemptId: ATTEMPT_A, attempt: 1 },
      async () => {
        await nextTurn();
        return runWithTaskProvisioningOperationLog(
          { stage: 'sandbox_creation', operationId: OPERATION_A },
          async () => {
            await nextTurn();
            return loggerMixin();
          },
        );
      },
    ),
    runWithTaskProvisioningAttemptLog(
      { taskId: TASK_B, attemptId: ATTEMPT_B, attempt: 3 },
      async () => {
        await nextTurn();
        return runWithTaskProvisioningOperationLog(
          { stage: 'cleanup', operationId: OPERATION_B },
          async () => {
            await nextTurn();
            return loggerMixin();
          },
        );
      },
    ),
  ]);

  assert.deepEqual(traces, [
    {
      taskId: TASK_A,
      attemptId: ATTEMPT_A,
      attempt: 1,
      stage: 'sandbox_creation',
      operationId: OPERATION_A,
    },
    {
      taskId: TASK_B,
      attemptId: ATTEMPT_B,
      attempt: 3,
      stage: 'cleanup',
      operationId: OPERATION_B,
    },
  ]);
  assert.equal(getTaskLogContext(), undefined);
});

test('provisioning wrappers reject unbounded identity and operation inputs', () => {
  assert.throws(
    () =>
      runWithTaskProvisioningAttemptLog(
        { taskId: TASK_A, attemptId: ATTEMPT_A, attempt: 0 },
        () => undefined,
      ),
    /Invalid task provisioning log context/u,
  );
  assert.throws(
    () =>
      runWithTaskProvisioningAttemptLog(
        { taskId: 'not-a-uuid', attemptId: ATTEMPT_A, attempt: 1 },
        () => undefined,
      ),
    /Invalid task provisioning log context/u,
  );
  assert.throws(
    () =>
      runWithTaskProvisioningOperationLog(
        { stage: 'cleanup', operationId: OPERATION_A },
        () => undefined,
      ),
    /Invalid task provisioning log context/u,
  );
});
