import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type TaskFailureCode,
  type TaskStatus,
} from '@cap-console/contracts';
import type { ModuleRef } from '@nestjs/core';
import type { SessionCredentialsService } from '@/creds/session-credentials.service';
import type { AdmissionTransitionResult } from '@/tasks/tasks.service';
import type { SandboxProvider } from '@/sandbox/sandbox-provider.port';
import type { ProvisionLookup } from '@/provision-lookup/provision-lookup.port';
import type { TaskProvisioningDiagnosticRecorderPort } from '@/task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '@/task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { GuardrailsService, type GuardrailsConfig } from './guardrails.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 10,
};

const DEFAULT_PROVISION_LOOKUP: ProvisionLookup = {
  async getTaskLaunchContext() {
    return {
      modelIntent: { kind: 'runtime-default' },
      ownerUserId: USER_ID,
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      workspaceMaterializationDeadlineMs: 900_000,
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
    provisionLookup?: ProvisionLookup;
    provisioningDiagnosticRecorder?: TaskProvisioningDiagnosticRecorderPort;
    provisioningDiagnosticWriteGate?: TaskProvisioningDiagnosticsWriteGatePort;
  } = {},
): GuardrailsService {
  const service = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    options.sandbox,
    CONFIG,
    options.provisionLookup ?? DEFAULT_PROVISION_LOOKUP,
    undefined,
    undefined,
    undefined,
    options.provisioningDiagnosticRecorder,
    options.provisioningDiagnosticWriteGate,
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

function installConfirmedTerminalCas(
  service: GuardrailsService,
  options: {
    readonly trace?: string[];
    readonly statuses?: TaskStatus[];
    readonly provisioningFailures?: string[];
  } = {},
): void {
  const tasks = (service as unknown as { tasks: Record<string, unknown> }).tasks;
  const commit = async (taskId: string, status: TaskStatus): Promise<object> => {
    options.trace?.push('task_cas');
    options.statuses?.push(status);
    service.fenceTerminal(taskId, status);
    await service.onTerminal(taskId, status);
    return { status };
  };
  Object.assign(tasks, {
    async transition(taskId: string, status: TaskStatus) {
      return commit(taskId, status);
    },
    async failWithProvisioningFailure(taskId: string, cause: string) {
      options.provisioningFailures?.push(cause);
      return commit(taskId, 'failed');
    },
    async failWithRuntimeFailure(taskId: string) {
      return commit(taskId, 'failed');
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    },
  };
}

test('durable terminal cleanup without a sandbox port fails closed and retains the slot', async () => {
  const service = buildService(async () => 'transitioned');
  const semaphore = (
    service as unknown as {
      semaphore: { offer(taskId: string): 'running' | 'queued' };
    }
  ).semaphore;
  assert.equal(semaphore.offer(TASK_ID), 'running');
  assert.equal(service.runningCount, 1);

  await assert.rejects(
    service.onDurableAdmissionTerminal(TASK_ID, 'lease:missing-sandbox'),
    /cleanup provider is unavailable/,
  );
  assert.equal(service.runningCount, 1);
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

test('natural failed terminal preserves the historical terminal delivery plan', async () => {
  let deliverCalls = 0;
  const sessionReasons: string[] = [];
  const service = buildService(async () => 'transitioned', {
    sandbox: {
      getSandboxMode: () => 'danger-full-access',
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  Object.assign(service, {
    creds: {
      destroyForSession(_taskId: string, reason: string) {
        sessionReasons.push(reason);
      },
    },
    async deliverResult() {
      deliverCalls += 1;
    },
  });

  await service.onTerminal(TASK_ID, 'failed');

  assert.equal(deliverCalls, 1);
  assert.deepEqual(sessionReasons, ['completed']);
});

test('guardrail failed CAS uses failed teardown semantics and never delivers workspace changes', async () => {
  let deliverCalls = 0;
  const sessionReasons: string[] = [];
  const service = buildService(async () => 'transitioned', {
    sandbox: {
      getSandboxMode: () => 'danger-full-access',
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  Object.assign(service, {
    creds: {
      destroyForSession(_taskId: string, reason: string) {
        sessionReasons.push(reason);
      },
    },
    async deliverResult() {
      deliverCalls += 1;
    },
  });
  installConfirmedTerminalCas(service);

  await (
    service as unknown as {
      forceFail(taskId: string, cause: 'deadline'): Promise<TaskStatus | undefined>;
    }
  ).forceFail(TASK_ID, 'deadline');

  assert.equal(deliverCalls, 0);
  assert.deepEqual(sessionReasons, ['failed']);
});

test('PR delivery uses the shared resolved snapshot as its base branch', async () => {
  let openedBaseBranch: string | null = null;
  const writes: Array<Record<string, unknown>> = [];
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['workspace.git.deliver'],
    async deliverWorkspaceChanges() {
      return { hadChanges: true, commitSha: 'abc123', error: null };
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', { sandbox });
  Object.assign(service, {
    prisma: {
      task: {
        async findUnique() {
          return { status: 'completed', deliver: 'pr', branch: null };
        },
        async update(args: { data: Record<string, unknown> }) {
          writes.push(args.data);
          return {};
        },
      },
    },
    forgeResolver: {
      async getForgeTarget() {
        return {
          kind: 'gitee',
          apiBaseUrl: 'https://gitee.com/api/v5',
          cloneUrl: 'https://gitee.com/team/private.git',
          repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
          token: 'owner-token',
        };
      },
    },
    forgeRegistry: {
      forKind() {
        return {
          kind: 'gitee',
          cloneAuthHeader: () => 'Authorization: Basic safe-test-value',
          resolveBaseBranch: async () => {
            assert.fail('delivery must not independently resolve a forge base');
          },
          findExistingChangeRequest: async () => null,
          openChangeRequest: async (
            _target: unknown,
            args: { baseBranch: string },
          ) => {
            openedBaseBranch = args.baseBranch;
            return {
              number: 7,
              url: 'https://gitee.com/team/private/pulls/7',
              state: 'open',
              headBranch: `cap/task-${TASK_ID}`,
            };
          },
        };
      },
    },
    branchResolver: {
      async resolve(taskId: string) {
        return {
          taskId,
          callerBranch: null,
          resolvedBranch: 'master',
          source: 'snapshot',
          snapshotted: true,
        };
      },
    },
  });
  const internals = service as unknown as {
    deliverResult(taskId: string): Promise<void>;
  };

  await internals.deliverResult(TASK_ID);

  assert.equal(openedBaseBranch, 'master');
  assert.equal(writes.at(-1)?.deliverStatus, 'pr_opened');
});

test('delivery failures keep the exact-host credential private and redact provider errors', async () => {
  const canary = 'CAP_DELIVERY_SECRET_CANARY_8_5';
  const writes: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let providerCalls = 0;
  let serializedCredential = '';
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['workspace.git.deliver'],
    async deliverWorkspaceChanges(
      _taskId: string,
      args: { credential?: unknown },
    ) {
      providerCalls += 1;
      serializedCredential = JSON.stringify(args.credential);
      throw new Error(`provider rejected ${canary}`);
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', { sandbox });
  Object.assign(service, {
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    },
    prisma: {
      task: {
        async findUnique() {
          return { status: 'completed', deliver: 'branch', branch: null };
        },
        async update(args: { data: Record<string, unknown> }) {
          writes.push(args.data);
          return {};
        },
      },
    },
    forgeResolver: {
      async getForgeTarget() {
        return {
          kind: 'gitee',
          apiBaseUrl: 'https://gitee.com/api/v5',
          cloneUrl: 'https://gitee.com/team/private.git',
          repoId: { style: 'owner-repo', owner: 'team', repo: 'private' },
          token: canary,
        };
      },
    },
    forgeRegistry: {
      forKind() {
        return {
          kind: 'gitee',
          cloneAuthHeader: () => `Authorization: Basic ${canary}`,
        };
      },
    },
  });
  const internals = service as unknown as {
    deliverResult(taskId: string): Promise<void>;
  };

  await internals.deliverResult(TASK_ID);

  assert.equal(providerCalls, 1);
  assert.equal(serializedCredential.includes(canary), false);
  assert.match(serializedCredential, /\[REDACTED\]/);
  assert.deepEqual(writes.at(-1), { deliverStatus: 'failed' });
  assert.equal(JSON.stringify({ warnings, writes }).includes(canary), false);
  assert.deepEqual(warnings, [
    `result delivery for task ${TASK_ID} failed (provider details redacted)`,
  ]);
});

test('model rejection persistence refuses unverified structured codes for the checked pins', async () => {
  const service = buildService(async () => 'transitioned');
  const failures: TaskFailureCode[] = [];
  Object.assign(service, {
    tasks: {
      async failWithRuntimeFailure(
        _taskId: string,
        code: TaskFailureCode,
      ) {
        failures.push(code);
        return {};
      },
    },
  });

  assert.equal(
    await service.failRuntimeModelRejection(TASK_ID, {
      runtime: 'claude-code',
      cliVersion: '2.1.207',
      source: 'claude-stream-json-result',
      stableCode: 'model_not_found',
    }),
    false,
  );
  assert.deepEqual(failures, []);
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

test('startup readoption restores two confirmed survivors above ceiling one without fresh admission', async () => {
  const service = buildService(async () => 'transitioned');
  const modes: Array<string | undefined> = [];
  Object.assign(service, {
    gateway: {
      openSession(
        _connection: unknown,
        _selectedRun: unknown,
        options?: { mode?: string },
      ) {
        modes.push(options?.mode);
        return { launchDecision: Promise.resolve({ kind: 'attached' as const }) };
      },
      unregisterSession() {},
      async readSessionLogTail() {
        return '';
      },
    },
  });

  assert.equal(
    await service.readopt(TASK_ID, {
      taskId: TASK_ID,
      baseUrl: 'http://sandbox.test/one',
      wsUrl: 'ws://sandbox.test/one',
    }),
    'attached',
  );
  assert.equal(
    await service.readopt(OTHER_TASK_ID, {
      taskId: OTHER_TASK_ID,
      baseUrl: 'http://sandbox.test/two',
      wsUrl: 'ws://sandbox.test/two',
    }),
    'attached',
  );

  assert.equal(service.runningCount, 2);
  assert.equal(service.queuedCount, 0);
  assert.deepEqual(modes, ['attach-only', 'attach-only']);
});

test('attach-only absence and indeterminate failure leave no readoption state', async () => {
  for (const kind of ['absent', 'indeterminate', 'failed'] as const) {
    const service = buildService(async () => 'transitioned');
    const unregistered: string[] = [];
    Object.assign(service, {
      gateway: {
        openSession() {
          return { launchDecision: Promise.resolve({ kind }) };
        },
        unregisterSession(taskId: string) {
          unregistered.push(taskId);
        },
        async readSessionLogTail() {
          return '';
        },
      },
    });

    const attempt = service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/readopt',
        wsUrl: 'ws://sandbox.test/readopt',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
    );
    if (kind === 'absent') {
      assert.equal(await attempt, 'absent');
    } else {
      await assert.rejects(attempt, /indeterminate/);
    }

    const internals = service as unknown as {
      connections: Map<string, unknown>;
      idle: { isTracking(taskId: string): boolean };
      deadlines: { isWatching(taskId: string): boolean };
      runnerMinutes: { intervals(): Array<unknown> };
    };
    assert.equal(service.runningCount, 0, `${kind}: no slot restored`);
    assert.equal(internals.connections.has(TASK_ID), false, `${kind}: no connection`);
    assert.equal(internals.idle.isTracking(TASK_ID), false, `${kind}: no idle timer`);
    assert.equal(
      internals.deadlines.isWatching(TASK_ID),
      false,
      `${kind}: no deadline timer`,
    );
    assert.deepEqual(internals.runnerMinutes.intervals(), [], `${kind}: no accounting`);
    assert.deepEqual(unregistered, [TASK_ID], `${kind}: provisional gateway state removed`);
  }
});

test('readoption final fence false or rejection leaves no partial state', async () => {
  for (const outcome of ['false', 'throw'] as const) {
    const service = buildService(async () => 'transitioned');
    let unregisterCalls = 0;
    Object.assign(service, {
      gateway: {
        openSession() {
          return {
            launchDecision: Promise.resolve({ kind: 'attached' as const }),
          };
        },
        unregisterSession() {
          unregisterCalls += 1;
        },
        async readSessionLogTail() {
          return '';
        },
      },
    });

    const attempt = service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/fenced',
        wsUrl: 'ws://sandbox.test/fenced',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      {
        beforeCommit: async () => {
          if (outcome === 'throw') throw new Error('database fence unavailable');
          return false;
        },
      },
    );
    if (outcome === 'false') {
      assert.equal(await attempt, 'superseded');
    } else {
      await assert.rejects(attempt, /database fence unavailable/);
    }

    const internals = service as unknown as {
      connections: Map<string, unknown>;
      idle: { isTracking(taskId: string): boolean };
      deadlines: { isWatching(taskId: string): boolean };
      runnerMinutes: { intervals(): Array<unknown> };
    };
    assert.equal(service.runningCount, 0);
    assert.equal(internals.connections.has(TASK_ID), false);
    assert.equal(internals.idle.isTracking(TASK_ID), false);
    assert.equal(internals.deadlines.isWatching(TASK_ID), false);
    assert.deepEqual(internals.runnerMinutes.intervals(), []);
    assert.equal(unregisterCalls, 1);
  }
});

test('terminal transition winning during the final readoption fence prevents restoration', async () => {
  let resolveDecision!: (value: { kind: 'attached' }) => void;
  const decision = new Promise<{ kind: 'attached' }>((resolve) => {
    resolveDecision = resolve;
  });
  let resolveFence!: (value: boolean) => void;
  const fence = new Promise<boolean>((resolve) => {
    resolveFence = resolve;
  });
  let fenceStarted = false;
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    gateway: {
      openSession() {
        return { launchDecision: decision };
      },
      unregisterSession() {},
      async readSessionLogTail() {
        return '';
      },
    },
  });

  const attempt = service.readopt(
    TASK_ID,
    {
      taskId: TASK_ID,
      baseUrl: 'http://sandbox.test/race',
      wsUrl: 'ws://sandbox.test/race',
    },
    {},
    null,
    {
      beforeCommit: async () => {
        fenceStarted = true;
        return fence;
      },
    },
  );
  resolveDecision({ kind: 'attached' });
  await waitFor(() => fenceStarted);

  await service.onTerminal(TASK_ID);
  resolveFence(true);

  assert.equal(await attempt, 'superseded');
  const internals = service as unknown as {
    connections: Map<string, unknown>;
    terminalTasks: Set<string>;
    runnerMinutes: { intervals(): Array<unknown> };
  };
  assert.equal(service.runningCount, 0);
  assert.equal(internals.connections.has(TASK_ID), false);
  assert.deepEqual(internals.runnerMinutes.intervals(), []);
  assert.equal(internals.terminalTasks.has(TASK_ID), false);
});

test('remote terminal winner after readoption commit clears only local runtime accounting on exit', async () => {
  let authorityCurrent = true;
  let transitionAttempts = 0;
  let unregisterCalls = 0;
  let teardownCalls = 0;
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    tasks: {
      async transition() {
        transitionAttempts += 1;
        throw new Error('task is already terminal on another replica');
      },
    },
    sandbox: {
      async teardownSandbox() {
        teardownCalls += 1;
      },
    },
    gateway: {
      openSession() {
        return {
          launchDecision: Promise.resolve({ kind: 'attached' as const }),
        };
      },
      unregisterSession() {
        unregisterCalls += 1;
      },
      async readSessionLogTail() {
        return '';
      },
    },
  });

  assert.equal(
    await service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/remote-terminal-race',
        wsUrl: 'ws://sandbox.test/remote-terminal-race',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      { beforeCommit: async () => authorityCurrent },
    ),
    'attached',
  );
  assert.equal(service.runningCount, 1);

  // Another API instance commits terminal + owns provider/session settlement
  // after our final startup read but before this local terminal event arrives.
  authorityCurrent = false;
  service.recordExit(TASK_ID, { code: 0, abnormal: false });
  await waitFor(() => service.runningCount === 0);

  const internals = service as unknown as {
    connections: Map<string, unknown>;
    idle: { isTracking(taskId: string): boolean };
    deadlines: { isWatching(taskId: string): boolean };
    runnerMinutes: { intervals(): Array<{ endedAt: number | null }> };
    readoptionAuthorityChecks: Map<string, unknown>;
  };
  assert.equal(transitionAttempts, 1);
  assert.equal(internals.connections.has(TASK_ID), false);
  assert.equal(internals.idle.isTracking(TASK_ID), false);
  assert.equal(internals.deadlines.isWatching(TASK_ID), false);
  assert.equal(
    internals.runnerMinutes.intervals().some(({ endedAt }) => endedAt === null),
    false,
    'the restored running interval is closed, while historical accounting remains',
  );
  assert.equal(internals.readoptionAuthorityChecks.has(TASK_ID), false);
  assert.equal(unregisterCalls, 1);
  assert.equal(
    teardownCalls,
    0,
    'the remote terminal winner retains sole provider-settlement ownership',
  );
});

test('same-target remote terminal winner is detected even when transition resolves', async () => {
  let authorityCurrent = true;
  let unregisterCalls = 0;
  let teardownCalls = 0;
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    tasks: {
      // Mirrors TasksService's same-target CAS-loser branch: it returns the
      // winner response without starting terminal settlement in this process.
      async transition() {},
    },
    sandbox: {
      async teardownSandbox() {
        teardownCalls += 1;
      },
    },
    gateway: {
      openSession() {
        return {
          launchDecision: Promise.resolve({ kind: 'attached' as const }),
        };
      },
      unregisterSession() {
        unregisterCalls += 1;
      },
      async readSessionLogTail() {
        return '';
      },
    },
  });

  assert.equal(
    await service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/same-target-winner',
        wsUrl: 'ws://sandbox.test/same-target-winner',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      { beforeCommit: async () => authorityCurrent },
    ),
    'attached',
  );

  authorityCurrent = false;
  service.recordExit(TASK_ID, { code: 0, abnormal: false });
  await waitFor(() => service.runningCount === 0);

  const internals = service as unknown as {
    connections: Map<string, unknown>;
    idle: { isTracking(taskId: string): boolean };
    deadlines: { isWatching(taskId: string): boolean };
    runnerMinutes: { intervals(): Array<{ endedAt: number | null }> };
  };
  assert.equal(internals.connections.has(TASK_ID), false);
  assert.equal(internals.idle.isTracking(TASK_ID), false);
  assert.equal(internals.deadlines.isWatching(TASK_ID), false);
  assert.equal(
    internals.runnerMinutes.intervals().some(({ endedAt }) => endedAt === null),
    false,
  );
  assert.equal(unregisterCalls, 1);
  assert.equal(teardownCalls, 0);
});

test('structured remote failure winner also clears readoption accounting without provider settlement', async () => {
  let unregisterCalls = 0;
  let teardownCalls = 0;
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    tasks: {
      async classifyRuntimeOutputFailure() {
        return { code: 'runtime_auth_expired' as const };
      },
      // Mirrors TasksService observing another replica's same failed winner.
      async failWithRuntimeFailure() {},
    },
    sandbox: {
      async teardownSandbox() {
        teardownCalls += 1;
      },
    },
    gateway: {
      openSession() {
        return {
          launchDecision: Promise.resolve({ kind: 'attached' as const }),
        };
      },
      unregisterSession() {
        unregisterCalls += 1;
      },
      async readSessionLogTail() {
        return 'HTTP 401 token expired';
      },
    },
  });

  assert.equal(
    await service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/structured-remote-winner',
        wsUrl: 'ws://sandbox.test/structured-remote-winner',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      { beforeCommit: async () => true },
    ),
    'attached',
  );

  service.recordExit(TASK_ID, { code: 1, abnormal: false });
  await waitFor(() => service.runningCount === 0);

  const internals = service as unknown as {
    connections: Map<string, unknown>;
    idle: { isTracking(taskId: string): boolean };
    deadlines: { isWatching(taskId: string): boolean };
    runnerMinutes: { intervals(): Array<{ endedAt: number | null }> };
  };
  assert.equal(internals.connections.has(TASK_ID), false);
  assert.equal(internals.idle.isTracking(TASK_ID), false);
  assert.equal(internals.deadlines.isWatching(TASK_ID), false);
  assert.equal(
    internals.runnerMinutes.intervals().some(({ endedAt }) => endedAt === null),
    false,
  );
  assert.equal(unregisterCalls, 1);
  assert.equal(teardownCalls, 0);
});

test('provisional deadline fence does not make a remote terminal winner repeat provider settlement', async () => {
  let unregisterCalls = 0;
  let teardownCalls = 0;
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    tasks: {
      // Remote replica already committed the same failed target; TasksService
      // returns that winner without invoking this process's onTerminal.
      async transition() {},
    },
    sandbox: {
      async teardownSandbox() {
        teardownCalls += 1;
      },
    },
    gateway: {
      openSession() {
        return {
          launchDecision: Promise.resolve({ kind: 'attached' as const }),
        };
      },
      unregisterSession() {
        unregisterCalls += 1;
      },
      async readSessionLogTail() {
        return '';
      },
    },
  });

  assert.equal(
    await service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/deadline-remote-winner',
        wsUrl: 'ws://sandbox.test/deadline-remote-winner',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      { beforeCommit: async () => true },
    ),
    'attached',
  );

  await (
    service as unknown as {
      forceFail(taskId: string, cause: 'deadline'): Promise<void>;
    }
  ).forceFail(TASK_ID, 'deadline');

  assert.equal(service.runningCount, 0);
  assert.equal(service.connectionFor(TASK_ID), undefined);
  assert.equal(unregisterCalls, 1);
  assert.equal(
    teardownCalls,
    0,
    'the remote winner remains the only provider-settlement owner',
  );
});

test('local terminal fence retains readoption state until its own settlement finishes', async () => {
  let unregisterCalls = 0;
  let teardownCalls = 0;
  const teardownEntered = deferred<void>();
  const releaseTeardown = deferred<void>();
  const service = buildService(async () => 'transitioned');
  Object.assign(service, {
    tasks: {
      // A concurrent caller observes the same target while this process's
      // onTerminal settlement is still active.
      async transition() {},
    },
    sandbox: {
      async teardownSandbox() {
        teardownCalls += 1;
        teardownEntered.resolve();
        await releaseTeardown.promise;
      },
    },
    gateway: {
      openSession() {
        return {
          launchDecision: Promise.resolve({ kind: 'attached' as const }),
        };
      },
      unregisterSession() {
        unregisterCalls += 1;
      },
      async readSessionLogTail() {
        return '';
      },
    },
  });

  assert.equal(
    await service.readopt(
      TASK_ID,
      {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/local-terminal-winner',
        wsUrl: 'ws://sandbox.test/local-terminal-winner',
      },
      { deadlineMs: 60_000, idleTimeoutMs: 30_000 },
      null,
      { beforeCommit: async () => true },
    ),
    'attached',
  );

  const localSettlement = service.onTerminal(TASK_ID);
  await teardownEntered.promise;
  const transition = await (
    service as unknown as {
      safeTransition(taskId: string, next: TaskStatus): Promise<string>;
    }
  ).safeTransition(TASK_ID, 'completed');
  assert.equal(transition, 'transitioned');
  assert.equal(service.runningCount, 1);
  assert.equal(service.connectionFor(TASK_ID)?.taskId, TASK_ID);
  assert.equal(unregisterCalls, 0, 'remote-only cleanup must not interrupt local settlement');
  assert.equal(teardownCalls, 1);

  releaseTeardown.resolve();
  await localSettlement;
  assert.equal(service.runningCount, 0);
  assert.equal(service.connectionFor(TASK_ID), undefined);
  assert.equal(unregisterCalls, 1);
  assert.equal(teardownCalls, 1);
});
