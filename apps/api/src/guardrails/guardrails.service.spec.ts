import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskFailureCode, TaskStatus } from '@cap/contracts';
import type { ModuleRef } from '@nestjs/core';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  AdmissionTransitionIndeterminateError,
  type AdmissionTransitionResult,
} from '../tasks/tasks.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { GuardrailsService, type GuardrailsConfig } from './guardrails.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};

type Transition = (
  taskId: string,
  next: Extract<TaskStatus, 'queued' | 'running'>,
  userId?: string,
  transitionToken?: string,
) => Promise<AdmissionTransitionResult>;

function buildService(
  transition: Transition,
  options: {
    sandbox?: SandboxProvider;
    reconcile?: (
      taskId: string,
      next: 'queued' | 'running',
      transitionToken: string,
      userId?: string,
    ) => Promise<AdmissionTransitionResult>;
    isCurrent?: (
      taskId: string,
      next: 'queued' | 'running',
      transitionToken: string,
    ) => Promise<boolean>;
  } = {},
): GuardrailsService {
  const service = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    options.sandbox,
    CONFIG,
  );
  Object.assign(service, {
    tasks: {
      transitionForAdmission: transition,
      reconcileAdmissionTransition: options.reconcile,
      isAdmissionTransitionCurrent: options.isCurrent,
    },
  });
  return service;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
}

test('duplicate admission is idempotent and preserves owner attribution', async () => {
  const transitions: Array<{ taskId: string; next: TaskStatus; userId?: string }> = [];
  const service = buildService(async (taskId, next, userId) => {
    transitions.push({ taskId, next, userId });
    return 'transitioned';
  });

  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');
  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');

  assert.deepEqual(transitions, [{ taskId: TASK_ID, next: 'running', userId: USER_ID }]);
  assert.equal(service.runningCount, 1);
  assert.equal(service.queuedCount, 0);
});

test('failed running transition releases the reserved semaphore slot', async () => {
  let failTransition = true;
  const service = buildService(async () => {
    if (failTransition) throw new Error('database unavailable');
    return 'transitioned';
  });

  await assert.rejects(
    service.admit(TASK_ID, { userId: USER_ID }),
    /could not transition to running/,
  );
  assert.equal(service.runningCount, 0);

  failTransition = false;
  assert.equal(await service.admit(OTHER_TASK_ID, { userId: USER_ID }), 'running');
  assert.equal(service.runningCount, 1);
});

test('failed queued transition removes the task from the backlog', async () => {
  const service = buildService(async (_taskId, next) => {
    if (next === 'queued') throw new Error('database unavailable');
    return 'transitioned';
  });

  assert.equal(await service.admit(TASK_ID, { userId: USER_ID }), 'running');
  await assert.rejects(
    service.admit(OTHER_TASK_ID, { userId: USER_ID }),
    /could not transition to queued/,
  );

  assert.equal(service.runningCount, 1);
  assert.equal(service.queuedCount, 0);
});

test('concurrent duplicate admission shares the first in-flight result', async () => {
  let releaseTransition: (() => void) | undefined;
  let transitions = 0;
  const gate = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const service = buildService(async () => {
    transitions += 1;
    await gate;
    return 'transitioned';
  });

  const first = service.admit(TASK_ID, { userId: USER_ID });
  const second = service.admit(TASK_ID, { userId: USER_ID });
  await Promise.resolve();

  assert.equal(transitions, 1);
  let secondSettled = false;
  void second.finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  releaseTransition?.();
  assert.deepEqual(await Promise.all([first, second]), ['running', 'running']);
  assert.equal(service.runningCount, 1);
});

test('duplicate admission waits for an in-flight queued promotion', async () => {
  let releasePromotion: (() => void) | undefined;
  const promotionGate = new Promise<void>((resolve) => {
    releasePromotion = resolve;
  });
  const transitions: Array<{ taskId: string; next: TaskStatus }> = [];
  const service = buildService(async (taskId, next) => {
    transitions.push({ taskId, next });
    if (taskId === OTHER_TASK_ID && next === 'running') await promotionGate;
    return 'transitioned';
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(await service.admit(OTHER_TASK_ID), 'queued');
  await service.onTerminal(TASK_ID);

  while (!transitions.some((entry) => entry.taskId === OTHER_TASK_ID && entry.next === 'running')) {
    await Promise.resolve();
  }
  let duplicateSettled = false;
  const duplicate = service.admit(OTHER_TASK_ID).finally(() => {
    duplicateSettled = true;
  });
  await Promise.resolve();
  assert.equal(duplicateSettled, false);

  releasePromotion?.();
  assert.equal(await duplicate, 'running');
  assert.equal(service.runningCount, 1);
});

test('slot release waits for the in-flight queued CAS before promotion', async () => {
  let releaseQueued: (() => void) | undefined;
  const queuedGate = new Promise<void>((resolve) => {
    releaseQueued = resolve;
  });
  const transitions: Array<{ taskId: string; next: TaskStatus }> = [];
  const service = buildService(async (taskId, next) => {
    transitions.push({ taskId, next });
    if (taskId === OTHER_TASK_ID && next === 'queued') await queuedGate;
    return 'transitioned';
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  const queuedAdmission = service.admit(OTHER_TASK_ID);
  await waitFor(() =>
    transitions.some((entry) => entry.taskId === OTHER_TASK_ID && entry.next === 'queued'),
  );

  await service.onTerminal(TASK_ID);
  await Promise.resolve();
  assert.equal(
    transitions.some((entry) => entry.taskId === OTHER_TASK_ID && entry.next === 'running'),
    false,
  );

  releaseQueued?.();
  assert.equal(await queuedAdmission, 'queued');
  await waitFor(() =>
    transitions.some((entry) => entry.taskId === OTHER_TASK_ID && entry.next === 'running'),
  );
  assert.deepEqual(
    transitions.filter((entry) => entry.taskId === OTHER_TASK_ID).map((entry) => entry.next),
    ['queued', 'running'],
  );
  assert.equal(service.runningCount, 1);
  assert.equal(service.queuedCount, 0);
});

test('ambiguous running CAS retains its slot and reconciles with the same token', async () => {
  let transitionToken: string | undefined;
  let reconciliations = 0;
  const service = buildService(
    async (taskId, next, _userId, token) => {
      transitionToken = token;
      throw new AdmissionTransitionIndeterminateError(taskId, next, token ?? 'missing');
    },
    {
      async reconcile(_taskId, _next, token) {
        reconciliations += 1;
        assert.equal(token, transitionToken);
        return 'transitioned';
      },
      async isCurrent(_taskId, _next, token) {
        return token === transitionToken;
      },
    },
  );

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(reconciliations, 1);
  assert.equal(service.runningCount, 1);
});

test('operator stop fenced during the running transition prevents provider start', async () => {
  let releaseTransition: (() => void) | undefined;
  let transitionStarted = false;
  const transitionGate = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  let provisionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    async provision() {
      provisionCalls += 1;
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(
    async () => {
      transitionStarted = true;
      await transitionGate;
      return 'transitioned';
    },
    { sandbox, isCurrent: async () => true },
  );

  const admission = service.admit(TASK_ID);
  await waitFor(() => transitionStarted);
  await service.onTerminal(TASK_ID);
  releaseTransition?.();
  assert.equal(await admission, 'running');
  assert.equal(provisionCalls, 0);
  assert.equal(service.runningCount, 0);
});

test('operator stop during provision tears down the late sandbox result', async () => {
  let releaseProvision: (() => void) | undefined;
  let provisionStarted = false;
  const provisionGate = new Promise<void>((resolve) => {
    releaseProvision = resolve;
  });
  let teardownCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    async provision() {
      provisionStarted = true;
      await provisionGate;
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {
      teardownCalls += 1;
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
  });

  const admission = service.admit(TASK_ID);
  await waitFor(() => provisionStarted);
  await service.onTerminal(TASK_ID);
  releaseProvision?.();
  assert.equal(await admission, 'running');
  assert.ok(teardownCalls >= 2);
  assert.equal(service.runningCount, 0);
});

test('terminal microtask after the final current check cannot start the provider', async () => {
  let provisionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    async provision() {
      provisionCalls += 1;
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', { sandbox });
  let checks = 0;
  Object.assign(service, {
    async waitForRunningAdmission() {
      checks += 1;
      if (checks === 3) {
        queueMicrotask(() => void service.onTerminal(TASK_ID));
      }
      return true;
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(provisionCalls, 0);
  assert.equal(service.runningCount, 0);
});

test('terminal microtask after selected-run lookup cannot reopen the gateway', async () => {
  let teardownCalls = 0;
  let openSessionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    async provision() {
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {
      teardownCalls += 1;
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', { sandbox });
  Object.assign(service, {
    gateway: {
      openSession() {
        openSessionCalls += 1;
      },
      unregisterSession() {},
    },
  });
  let checks = 0;
  Object.assign(service, {
    async waitForRunningAdmission() {
      checks += 1;
      if (checks === 5) {
        queueMicrotask(() => void service.onTerminal(TASK_ID));
      }
      return true;
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(openSessionCalls, 0);
  assert.ok(teardownCalls >= 2);
  assert.equal(service.runningCount, 0);
});

test('force-fail releases its terminal fence even when the lifecycle write fails', async () => {
  const service = buildService(async () => 'transitioned');
  const internals = service as unknown as {
    forceFail(
      taskId: string,
      cause: 'provision_failed',
    ): Promise<void>;
    terminalTasks: Set<string>;
  };

  await internals.forceFail(TASK_ID, 'provision_failed');
  assert.equal(internals.terminalTasks.has(TASK_ID), false);
});

test('classified exit persists one structured failure without waiting for audit', async () => {
  const service = buildService(async () => 'transitioned');
  const structured: Array<{
    taskId: string;
    code: TaskFailureCode;
    exitCode: number | null;
  }> = [];
  const generic: TaskStatus[] = [];
  let auditStarted = false;
  Object.assign(service, {
    gateway: {
      async readSessionLogTail() {
        return 'HTTP 401 token expired';
      },
    },
    audit: {
      async recordExited() {
        auditStarted = true;
        await new Promise<never>(() => undefined);
      },
    },
    tasks: {
      async classifyRuntimeOutputFailure() {
        return { code: 'runtime_auth_expired' as const };
      },
      async failWithRuntimeFailure(
        taskId: string,
        code: TaskFailureCode,
        exitCode: number | null,
      ) {
        structured.push({ taskId, code, exitCode });
        return {};
      },
      async transition(_taskId: string, next: TaskStatus) {
        generic.push(next);
        return {};
      },
    },
  });

  service.recordExit(TASK_ID, { code: 1, abnormal: false });
  await waitFor(() => structured.length === 1);

  assert.deepEqual(structured, [
    { taskId: TASK_ID, code: 'runtime_auth_expired', exitCode: 1 },
  ]);
  assert.deepEqual(generic, []);
  assert.equal(auditStarted, true);
  const breaker = service as unknown as {
    breaker: { consecutiveFailures(taskId: string): number };
  };
  assert.equal(breaker.breaker.consecutiveFailures(TASK_ID), 1);
});

test('exit classification timeout settles generically then enriches the late result', async () => {
  const service = buildService(async () => 'transitioned');
  let releaseTail: (() => void) | undefined;
  const tailGate = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  const generic: TaskStatus[] = [];
  const structured: TaskFailureCode[] = [];
  Object.assign(service, {
    gateway: {
      async readSessionLogTail() {
        await tailGate;
        return 'Session expired. Please run /login to sign in again.';
      },
    },
    tasks: {
      async classifyRuntimeOutputFailure() {
        return { code: 'runtime_auth_expired' as const };
      },
      async failWithRuntimeFailure(
        _taskId: string,
        code: TaskFailureCode,
      ) {
        structured.push(code);
        return {};
      },
      async transition(_taskId: string, next: TaskStatus) {
        generic.push(next);
        return {};
      },
    },
  });

  service.recordExit(TASK_ID, { code: 1, abnormal: false });
  await new Promise<void>((resolve) => setTimeout(resolve, 2_050));
  await waitFor(() => generic.length === 1);
  assert.deepEqual(generic, ['failed']);
  assert.deepEqual(structured, []);

  releaseTail?.();
  await waitFor(() => structured.length === 1);
  assert.deepEqual(structured, ['runtime_auth_expired']);
  const breaker = service as unknown as {
    breaker: { consecutiveFailures(taskId: string): number };
  };
  assert.equal(breaker.breaker.consecutiveFailures(TASK_ID), 1);
});
