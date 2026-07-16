import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  SandboxProvisioningStageError,
  type AgentTerminalLaunchOutcome,
  type SandboxProvisionContext,
} from '@cap/sandbox';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import {
  TaskAdmissionCoordinationError,
  TaskAdmissionLeaseLostError,
  TaskAdmissionProcessingError,
  type TaskAdmissionProcessorContext,
} from '../task-admission/task-admission.types';
import {
  GuardrailsService,
  type GuardrailsConfig,
  type ITerminalGateway,
} from './guardrails.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};
const CONNECTION = {
  taskId: TASK_ID,
  baseUrl: 'http://sandbox.test/task',
  wsUrl: 'ws://sandbox.test/task/ws',
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function buildContext(options: {
  readonly checkpoints: string[];
  readonly authorize?: () => Promise<void>;
  readonly signal?: AbortSignal;
}): TaskAdmissionProcessorContext {
  return {
    claim: {
      taskId: TASK_ID,
      leaseToken: 'lease-token',
      leaseUntil: new Date(Date.now() + 60_000),
      sourceState: 'running',
      attempt: 1,
      stage: 'sandbox_creation',
      resolvedBranch: 'main',
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'running',
      taskLifecycleVersion: 1,
    },
    lease: {
      currentTaskFence: () => ({ status: 'running', lifecycleVersion: 1 }),
      beginTaskTransition: () => {
        assert.fail('running admission must not begin a lifecycle transition');
      },
      commitTaskTransition: () => {
        assert.fail('running admission must not commit a lifecycle transition');
      },
      rollbackTaskTransition: () => {
        assert.fail('running admission must not roll back a lifecycle transition');
      },
      authorize: options.authorize ?? (async () => {}),
      renew: async () => {},
      checkpoint: async (stage) => {
        options.checkpoints.push(stage);
      },
    },
    signal: options.signal ?? new AbortController().signal,
  };
}

function buildService(
  gateway: ITerminalGateway,
  audit?: AuditRecorderPort,
  prisma?: PrismaService,
): GuardrailsService {
  const ownership = {
    ownerGeneration: 'lease-token',
    resourceGeneration: 'resource-generation',
  };
  const sandbox = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision() {
      return CONNECTION;
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    sandbox,
    CONFIG,
    undefined,
    audit,
    prisma,
  );
  Object.assign(service, {
    gateway,
    armDurableRuntime: async () => {},
    resolveProvisionPlan: async () => ({
      cloneSpec: null,
      modelIntent: { kind: 'runtime-default' },
      runtimeId: 'codex',
      executionMode: 'interactive-pty',
      resources: {},
      workspace: {
        repositoryUrl: 'https://example.test/repo.git',
        callerBranch: null,
        resolvedBranch: 'main',
        deadlineMs: 900_000,
      },
      requiredCapabilities: [],
    }),
    resolveSelectedRunStrict: async () => ({
      connection: CONNECTION,
      owner: {
        taskId: TASK_ID,
        providerId: 'sandbox-test',
        providerSandboxId: TASK_ID,
        ownership,
        status: 'running',
      },
    }),
  });
  return service;
}

function terminalTaskPrisma(
  status: 'completed' | 'failed' | 'cancelled' | 'agent_failed_to_start',
  failureCode: string | null = null,
  lifecycleVersion = 1,
): PrismaService {
  return {
    task: {
      async findUnique(args: unknown) {
        assert.deepEqual(args, {
          where: { id: TASK_ID },
          select: {
            status: true,
            lifecycleVersion: true,
            failureCode: true,
          },
        });
        return { status, lifecycleVersion, failureCode };
      },
    },
  } as unknown as PrismaService;
}

function gatewayWithDecision(
  launchDecision: Promise<AgentTerminalLaunchOutcome>,
  onOpen?: Parameters<ITerminalGateway['openSession']>[2] extends infer T
    ? (options: T) => void
    : never,
): ITerminalGateway {
  return {
    openSession(_connection, _selectedRun, options) {
      onOpen?.(options);
      return { launchDecision };
    },
    unregisterSession() {},
    async readSessionLogTail() {
      return '';
    },
  };
}

test('durable admission waits for launch authority and a launched outcome before succeeding', async () => {
  const decision = deferred<AgentTerminalLaunchOutcome>();
  const opened = deferred<void>();
  const checkpoints: string[] = [];
  let authorizationChecks = 0;
  let launchBarrier: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const service = buildService(
    gatewayWithDecision(decision.promise, (options) => {
      assert.equal(options?.signal, controller.signal);
      launchBarrier = options?.beforeAgentLaunch;
      opened.resolve();
    }),
  );
  const processing = service.processDurableAdmission(
    buildContext({
      checkpoints,
      signal: controller.signal,
      authorize: async () => {
        authorizationChecks += 1;
      },
    }),
  );
  let settled = false;
  void processing.finally(() => {
    settled = true;
  });

  await opened.promise;
  assert.equal(settled, false);
  assert.equal(typeof launchBarrier, 'function');
  const checksBeforeLaunchBarrier = authorizationChecks;
  await launchBarrier?.();
  assert.equal(authorizationChecks, checksBeforeLaunchBarrier + 1);
  assert.equal(settled, false);

  decision.resolve({ kind: 'launched' });
  assert.deepEqual(await processing, { kind: 'succeeded' });
  assert.deepEqual(checkpoints, [
    'sandbox_creation',
    'runtime_setup',
    'readiness',
    'agent_launch',
    'complete',
  ]);
  const semaphore = (
    service as unknown as {
      semaphore: { offer(taskId: string): 'running' | 'queued' };
    }
  ).semaphore;
  assert.equal(
    semaphore.offer('legacy-task-after-durable-running'),
    'queued',
    'a local legacy task cannot consume the durable running slot',
  );
});

test('a committed running reservation is mirrored before post-reservation authorization', async () => {
  const checkpoints: string[] = [];
  const postReservationAuthorizationEntered = deferred<void>();
  const releasePostReservationAuthorization = deferred<void>();
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
  );
  let fence: ReturnType<
    TaskAdmissionProcessorContext['lease']['currentTaskFence']
  > = { status: 'pending', lifecycleVersion: 0 };
  let authorizationChecks = 0;
  let reservationCalls = 0;
  let runtimeArmCalls = 0;
  Object.assign(service, {
    tasks: {
      async reserveDurableAdmissionCapacity() {
        reservationCalls += 1;
        return {
          outcome: 'running' as const,
          status: 'running' as const,
          lifecycleVersion: 1,
          transitioned: true,
        };
      },
    },
    armDurableRuntime: async () => {
      runtimeArmCalls += 1;
    },
  });

  const base = buildContext({ checkpoints });
  const context: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      taskStatus: 'pending',
      taskLifecycleVersion: 0,
    },
    lease: {
      ...base.lease,
      currentTaskFence: () => fence,
      beginTaskTransition: (targets) => {
        assert.deepEqual(targets, ['queued', 'running']);
        return 1;
      },
      commitTaskTransition: (next) => {
        fence = next;
      },
      rollbackTaskTransition: () => {
        assert.fail('a committed running reservation must not roll back');
      },
      authorize: async () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          postReservationAuthorizationEntered.resolve();
          await releasePostReservationAuthorization.promise;
          throw new TaskAdmissionLeaseLostError(TASK_ID);
        }
      },
    },
  };

  const processing = service.processDurableAdmission(context);
  await postReservationAuthorizationEntered.promise;
  assert.equal(reservationCalls, 1);
  assert.equal(authorizationChecks, 2);
  assert.equal(runtimeArmCalls, 0);
  const semaphore = (
    service as unknown as {
      semaphore: { offer(taskId: string): 'running' | 'queued' };
    }
  ).semaphore;
  assert.equal(
    semaphore.offer('legacy-task-after-authorization-loss'),
    'queued',
    'the durable DB winner must occupy local capacity before lease reauthorization',
  );
  releasePostReservationAuthorization.resolve();
  await assert.rejects(processing, TaskAdmissionLeaseLostError);
});

test('provider-composite progress reaches audit without blocking provisioning', async () => {
  const provisionEntered = deferred<void>();
  const releaseProvision = deferred<void>();
  const neverSettles = deferred<void>();
  const auditCalls: Array<[string, string, number]> = [];
  const audit = {
    recordProvisioningProgress(taskId: string, stage: string, attempt: number) {
      auditCalls.push([taskId, stage, attempt]);
      return neverSettles.promise;
    },
  } as unknown as AuditRecorderPort;
  const checkpoints: string[] = [];
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    audit,
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        context.onProvisioningProgress?.({
          status: 'started',
          stage: 'readiness',
        });
        await context.beforeProvisioningBoundary?.({
          stage: 'runtime_setup',
        });
        context.onProvisioningProgress?.({
          status: 'started',
          stage: 'runtime_setup',
        });
        provisionEntered.resolve();
        await releaseProvision.promise;
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });

  let settled = false;
  const processing = service
    .processDurableAdmission(buildContext({ checkpoints }))
    .finally(() => {
      settled = true;
    });
  await provisionEntered.promise;
  assert.deepEqual(auditCalls, [
    [TASK_ID, 'readiness', 1],
    [TASK_ID, 'runtime_setup', 1],
  ]);
  assert.deepEqual(checkpoints, ['sandbox_creation', 'runtime_setup']);
  assert.equal(settled, false);
  releaseProvision.resolve();
  assert.deepEqual(await processing, { kind: 'succeeded' });
});

test('durable admission also accepts an attached session', async () => {
  const checkpoints: string[] = [];
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
  );

  assert.deepEqual(
    await service.processDurableAdmission(buildContext({ checkpoints })),
    { kind: 'succeeded' },
  );
  assert.equal(checkpoints.at(-1), 'complete');
});

test('cancelled terminal recovery confirms audit before exact cleanup', async () => {
  const events: string[] = [];
  let cleanupOptions: unknown;
  const audit = {
    async recordTaskCancellation(taskId: string) {
      events.push(`audit:${taskId}`);
      return true;
    },
  } as unknown as AuditRecorderPort;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    audit,
    terminalTaskPrisma('cancelled'),
  );
  Object.assign(service, {
    onDurableAdmissionTerminal: async (
      taskId: string,
      owner: string,
      options: unknown,
    ) => {
      events.push(`cleanup:${taskId}:${owner}`);
      cleanupOptions = options;
    },
  });
  const context = buildContext({ checkpoints: [] });
  const cancelled = {
    ...context,
    claim: { ...context.claim, taskStatus: 'cancelled' as const },
  };

  assert.deepEqual(await service.recoverDurableTerminalAdmission(cancelled), {
    state: 'cancelled',
    stage: 'sandbox_creation',
  });
  assert.deepEqual(events, [
    `audit:${TASK_ID}`,
    `cleanup:${TASK_ID}:lease-token`,
  ]);
  assert.deepEqual(cleanupOptions, {
    disposition: 'superseded-remove',
    sessionReason: 'failed',
    captureTranscript: true,
  });
});

test('completed and runtime-failed recovery retain history and settle only proven complete admission', async () => {
  for (const scenario of [
    {
      status: 'completed' as const,
      failureCode: null,
      stage: 'complete' as const,
      expected: { state: 'succeeded' as const, stage: 'complete' as const },
      cleanup: {
        disposition: 'terminal-retain',
        sessionReason: 'completed',
        captureTranscript: true,
        deliverWorkspace: true,
      },
    },
    {
      status: 'completed' as const,
      failureCode: null,
      stage: 'agent_launch' as const,
      expected: { state: 'cancelled' as const, stage: 'agent_launch' as const },
      cleanup: {
        disposition: 'terminal-retain',
        sessionReason: 'completed',
        captureTranscript: true,
        deliverWorkspace: true,
      },
    },
    {
      status: 'failed' as const,
      failureCode: 'runtime_auth_expired',
      stage: 'complete' as const,
      expected: { state: 'succeeded' as const, stage: 'complete' as const },
      cleanup: {
        disposition: 'terminal-retain',
        sessionReason: 'failed',
        captureTranscript: true,
      },
    },
    {
      status: 'failed' as const,
      failureCode: null,
      stage: 'readiness' as const,
      expected: { state: 'cancelled' as const, stage: 'readiness' as const },
      cleanup: {
        disposition: 'terminal-retain',
        sessionReason: 'failed',
        captureTranscript: true,
      },
    },
  ]) {
    const cleanupCalls: unknown[][] = [];
    const audit = {
      async recordProvisioningFailure() {
        assert.fail('retained runtime/ordinary terminal recovery is not provisioning audit');
      },
    } as unknown as AuditRecorderPort;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
      audit,
      terminalTaskPrisma(scenario.status, scenario.failureCode),
    );
    Object.assign(service, {
      async onDurableAdmissionTerminal(...args: unknown[]) {
        cleanupCalls.push(args);
      },
    });
    const base = buildContext({ checkpoints: [] });
    const terminal: TaskAdmissionProcessorContext = {
      ...base,
      claim: {
        ...base.claim,
        taskStatus: scenario.status,
        stage: scenario.stage,
      },
    };

    assert.deepEqual(
      await service.recoverDurableTerminalAdmission(terminal),
      scenario.expected,
    );
    assert.deepEqual(cleanupCalls, [
      [TASK_ID, 'lease-token', scenario.cleanup],
    ]);
  }
});

test('agent start failure retains history but settles admission failed at agent launch', async () => {
  const cleanupCalls: unknown[][] = [];
  const audit = {
    async recordProvisioningFailure() {
      assert.fail('agent_failed_to_start must not fabricate provisioning detail');
    },
  } as unknown as AuditRecorderPort;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    audit,
    terminalTaskPrisma('agent_failed_to_start'),
  );
  Object.assign(service, {
    async onDurableAdmissionTerminal(...args: unknown[]) {
      cleanupCalls.push(args);
    },
  });
  const base = buildContext({ checkpoints: [] });
  const terminal: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      taskStatus: 'agent_failed_to_start',
      stage: 'readiness',
    },
  };

  assert.deepEqual(await service.recoverDurableTerminalAdmission(terminal), {
    state: 'failed',
    stage: 'agent_launch',
    causeCode: 'provisioning_unknown',
  });
  assert.deepEqual(cleanupCalls, [
    [
      TASK_ID,
      'lease-token',
      {
        disposition: 'terminal-retain',
        sessionReason: 'failed',
        captureTranscript: true,
      },
    ],
  ]);
});

test('work or Task provisioning causes audit then remove exact ownership', async () => {
  for (const workCause of [
    'provisioning_capacity_exhausted',
    undefined,
  ] as const) {
    const events: string[] = [];
    const audit = {
      async recordProvisioningFailure(
        taskId: string,
        stage: string,
        attempt: number,
        failure: { readonly code: string },
      ) {
        events.push(`audit:${taskId}:${stage}:${attempt}:${failure.code}`);
        return true;
      },
    } as unknown as AuditRecorderPort;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
      audit,
      terminalTaskPrisma('failed', 'provisioning_capacity_exhausted'),
    );
    Object.assign(service, {
      async onDurableAdmissionTerminal(taskId: string, owner: string) {
        events.push(`cleanup:${taskId}:${owner}`);
      },
    });
    const base = buildContext({ checkpoints: [] });
    const terminal: TaskAdmissionProcessorContext = {
      ...base,
      claim: {
        ...base.claim,
        taskStatus: 'failed',
        ...(workCause === undefined ? {} : { causeCode: workCause }),
        stage: 'workspace_transfer',
      },
    };

    assert.deepEqual(await service.recoverDurableTerminalAdmission(terminal), {
      state: 'failed',
      stage: 'workspace_transfer',
      causeCode: 'provisioning_capacity_exhausted',
    });
    assert.deepEqual(events, [
      `audit:${TASK_ID}:workspace_transfer:1:provisioning_capacity_exhausted`,
      `cleanup:${TASK_ID}:lease-token`,
    ]);
  }
});

test('conflicting Task and work provisioning causes fail closed before audit or cleanup', async () => {
  for (const taskFailureCode of [null, 'provisioning_ref_not_found']) {
    let auditCalls = 0;
    let cleanupCalls = 0;
    const audit = {
      async recordProvisioningFailure() {
        auditCalls += 1;
        return true;
      },
    } as unknown as AuditRecorderPort;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
      audit,
      terminalTaskPrisma('failed', taskFailureCode),
    );
    Object.assign(service, {
      async onDurableAdmissionTerminal() {
        cleanupCalls += 1;
      },
    });
    const base = buildContext({ checkpoints: [] });
    const terminal: TaskAdmissionProcessorContext = {
      ...base,
      claim: {
        ...base.claim,
        taskStatus: 'failed',
        causeCode: 'provisioning_capacity_exhausted',
      },
    };

    await assert.rejects(
      service.recoverDurableTerminalAdmission(terminal),
      TaskAdmissionCoordinationError,
    );
    assert.equal(auditCalls, 0);
    assert.equal(cleanupCalls, 0);
  }
});

test('terminal recovery rejects a Task status/version snapshot that no longer matches its claim', async () => {
  let auditCalls = 0;
  let cleanupCalls = 0;
  const audit = {
    async recordTaskCancellation() {
      auditCalls += 1;
      return true;
    },
  } as unknown as AuditRecorderPort;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    audit,
    terminalTaskPrisma('cancelled', null, 2),
  );
  Object.assign(service, {
    async onDurableAdmissionTerminal() {
      cleanupCalls += 1;
    },
  });
  const base = buildContext({ checkpoints: [] });
  const terminal: TaskAdmissionProcessorContext = {
    ...base,
    claim: { ...base.claim, taskStatus: 'cancelled' },
  };

  await assert.rejects(
    service.recoverDurableTerminalAdmission(terminal),
    TaskAdmissionCoordinationError,
  );
  assert.equal(auditCalls, 0);
  assert.equal(cleanupCalls, 0);
});

test('unfinished durable terminal work retains its slot until exact recovery cleanup', async () => {
  const events: string[] = [];
  const ownership = {
    ownerGeneration: 'lease-token',
    resourceGeneration: 'resource-generation',
  };
  const prisma = {
    taskAdmissionWork: {
      async findUnique() {
        return { state: 'running' };
      },
    },
  } as unknown as PrismaService;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    undefined,
    prisma,
  );
  Object.assign(service, {
    transcripts: {
      async capture(taskId: string) {
        events.push(`capture:${taskId}`);
      },
    },
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership(taskId: string, ownerGeneration: string) {
        events.push(`claim:${taskId}:${ownerGeneration}`);
        return {
          kind: 'generation' as const,
          taskId,
          providerId: 'sandbox-test',
          ownership,
        };
      },
      async teardownSandbox(
        taskId: string,
        options: { readonly disposition?: string },
      ) {
        events.push(`teardown:${taskId}:${options.disposition}`);
      },
    } as unknown as SandboxProvider,
    onAdmit: async (taskId: string) => {
      events.push(`promote:${taskId}`);
    },
  });
  const semaphore = (
    service as unknown as {
      semaphore: {
        offer(taskId: string): 'running' | 'queued';
        readonly runningCount: number;
        readonly queuedCount: number;
      };
    }
  ).semaphore;
  service.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await service.onTerminal(TASK_ID);
  assert.deepEqual(events, []);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);

  await service.onDurableAdmissionTerminal(TASK_ID, 'lease-token', {
    disposition: 'superseded-remove',
    sessionReason: 'failed',
    captureTranscript: true,
  });
  assert.deepEqual(events, [
    `capture:${TASK_ID}`,
    `claim:${TASK_ID}:lease-token`,
    `teardown:${TASK_ID}:superseded-remove`,
    'promote:legacy-waiter',
  ]);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 0);
});

test('exact durable terminal-retain cleanup releases only after provider confirmation', async () => {
  const events: string[] = [];
  const ownership = {
    ownerGeneration: 'lease-token',
    resourceGeneration: 'resource-generation',
  };
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership(taskId: string, ownerGeneration: string) {
        events.push(`claim:${taskId}:${ownerGeneration}`);
        return {
          kind: 'generation' as const,
          taskId,
          providerId: 'sandbox-test',
          ownership,
        };
      },
      async teardownSandbox(
        taskId: string,
        options: { readonly disposition?: string },
      ) {
        events.push(`teardown:${taskId}:${options.disposition}`);
      },
    } as unknown as SandboxProvider,
    onAdmit: async (taskId: string) => {
      events.push(`promote:${taskId}`);
    },
  });
  const semaphore = (
    service as unknown as {
      semaphore: {
        offer(taskId: string): 'running' | 'queued';
        readonly queuedCount: number;
      };
    }
  ).semaphore;
  service.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await service.onDurableAdmissionTerminal(TASK_ID, 'lease-token', {
    disposition: 'terminal-retain',
    sessionReason: 'completed',
    captureTranscript: true,
    deliverWorkspace: true,
  });
  assert.deepEqual(events, [
    `claim:${TASK_ID}:lease-token`,
    `teardown:${TASK_ID}:terminal-retain`,
    'promote:legacy-waiter',
  ]);
  assert.equal(semaphore.queuedCount, 0);
});

test('failed exact remove or retain cleanup never releases the mirrored slot', async () => {
  for (const disposition of [
    'superseded-remove',
    'terminal-retain',
  ] as const) {
    let captureCalls = 0;
    const ownership = {
      ownerGeneration: 'lease-token',
      resourceGeneration: 'resource-generation',
    };
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    );
    Object.assign(service, {
      transcripts: {
        async capture() {
          captureCalls += 1;
        },
      },
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async claimSandboxCleanupOwnership(taskId: string) {
          return {
            kind: 'generation' as const,
            taskId,
            providerId: 'sandbox-test',
            ownership,
          };
        },
        async teardownSandbox() {
          throw new Error('provider cleanup remains pending');
        },
      } as unknown as SandboxProvider,
    });
    const semaphore = (
      service as unknown as {
        semaphore: {
          offer(taskId: string): 'running' | 'queued';
          readonly runningCount: number;
          readonly queuedCount: number;
        };
      }
    ).semaphore;
    service.restoreDurableAdmissionSlot(TASK_ID);
    assert.equal(semaphore.offer('legacy-waiter'), 'queued');

    await assert.rejects(
      service.onDurableAdmissionTerminal(TASK_ID, 'lease-token', {
        disposition,
      }),
      /provider cleanup remains pending/,
    );
    assert.equal(captureCalls, 1);
    assert.equal(semaphore.runningCount, 1);
    assert.equal(semaphore.queuedCount, 1);
  }
});

test('succeeded or absent admission work uses ordinary terminal cleanup and release', async () => {
  for (const work of [{ state: 'succeeded' }, null]) {
    const events: string[] = [];
    const prisma = {
      taskAdmissionWork: {
        async findUnique() {
          return work;
        },
      },
    } as unknown as PrismaService;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
      undefined,
      prisma,
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async teardownSandbox(
          taskId: string,
          options: { readonly disposition?: string },
        ) {
          events.push(`teardown:${taskId}:${options.disposition}`);
        },
      } as unknown as SandboxProvider,
      onAdmit: async (taskId: string) => {
        events.push(`promote:${taskId}`);
      },
    });
    const semaphore = (
      service as unknown as {
        semaphore: {
          offer(taskId: string): 'running' | 'queued';
          readonly queuedCount: number;
        };
      }
    ).semaphore;
    service.restoreDurableAdmissionSlot(TASK_ID);
    assert.equal(semaphore.offer('legacy-waiter'), 'queued');

    await service.onTerminal(TASK_ID);
    assert.deepEqual(events, [
      `teardown:${TASK_ID}:terminal-retain`,
      'promote:legacy-waiter',
    ]);
    assert.equal(semaphore.queuedCount, 0);
  }
});

test('an indeterminate admission-state read fails closed without teardown or release', async () => {
  let teardownCalls = 0;
  const prisma = {
    taskAdmissionWork: {
      async findUnique() {
        throw new Error('unsafe database canary');
      },
    },
  } as unknown as PrismaService;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    undefined,
    prisma,
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async teardownSandbox() {
        teardownCalls += 1;
      },
    } as unknown as SandboxProvider,
  });
  const semaphore = (
    service as unknown as {
      semaphore: {
        offer(taskId: string): 'running' | 'queued';
        readonly runningCount: number;
        readonly queuedCount: number;
      };
    }
  ).semaphore;
  service.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await service.onTerminal(TASK_ID);
  assert.equal(teardownCalls, 0);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);
});

test('cancelled terminal recovery fails closed before cleanup when audit is pending', async () => {
  let cleanupCalls = 0;
  const audit = {
    async recordTaskCancellation() {
      return false;
    },
  } as unknown as AuditRecorderPort;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    audit,
    terminalTaskPrisma('cancelled'),
  );
  Object.assign(service, {
    onDurableAdmissionTerminal: async () => {
      cleanupCalls += 1;
    },
  });
  const context = buildContext({ checkpoints: [] });
  const cancelled = {
    ...context,
    claim: { ...context.claim, taskStatus: 'cancelled' as const },
  };

  await assert.rejects(
    service.recoverDurableTerminalAdmission(cancelled),
    TaskAdmissionCoordinationError,
  );
  assert.equal(cleanupCalls, 0);
});

test('provider-neutral readiness failure keeps its safe active stage', async () => {
  const checkpoints: string[] = [];
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        throw new SandboxProvisioningStageError('readiness');
      },
      async teardownSandbox() {},
    },
  });

  await assert.rejects(
    service.processDurableAdmission(buildContext({ checkpoints })),
    (error: unknown) =>
      error instanceof TaskAdmissionProcessingError &&
      error.causeCode === 'provisioning_unknown' &&
      error.stage === 'readiness' &&
      error.retryable === false,
  );
  assert.deepEqual(checkpoints, ['sandbox_creation']);
});

test('a persisted selected run never bypasses provider idempotent initialization', async () => {
  const checkpoints: string[] = [];
  const provisionEntered = deferred<void>();
  const releaseProvision = deferred<void>();
  let provisionCalls = 0;
  let sessionOpenCalls = 0;
  const launchGateway = gatewayWithDecision(
    Promise.resolve({ kind: 'attached' }),
  );
  const service = buildService({
    ...launchGateway,
    openSession(connection, selectedRun, options) {
      sessionOpenCalls += 1;
      return launchGateway.openSession(connection, selectedRun, options);
    },
  });
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        provisionCalls += 1;
        provisionEntered.resolve();
        await releaseProvision.promise;
        return CONNECTION;
      },
      async teardownSandbox() {},
    },
  });

  const processing = service.processDurableAdmission(
    buildContext({ checkpoints }),
  );
  await provisionEntered.promise;
  assert.equal(provisionCalls, 1);
  assert.equal(sessionOpenCalls, 0);

  releaseProvision.resolve();
  assert.deepEqual(await processing, { kind: 'succeeded' });
  assert.equal(sessionOpenCalls, 1);
});

test('durable admission rejects a mutable provision plan that differs from its claim snapshot', async () => {
  for (const mismatch of [
    { resources: { diskSizeGb: 8 }, branch: 'main', deadlineMs: 900_000 },
    { resources: {}, branch: 'other', deadlineMs: 900_000 },
    { resources: {}, branch: 'main', deadlineMs: 800_000 },
  ]) {
    const checkpoints: string[] = [];
    let provisionCalls = 0;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async provision() {
          provisionCalls += 1;
          return CONNECTION;
        },
        async teardownSandbox() {},
      },
      resolveProvisionPlan: async () => ({
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        resources: mismatch.resources,
        workspace: {
          repositoryUrl: 'https://example.test/repo.git',
          callerBranch: null,
          resolvedBranch: mismatch.branch,
          deadlineMs: mismatch.deadlineMs,
        },
        requiredCapabilities: [],
      }),
    });

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints })),
      (error: unknown) =>
        error instanceof TaskAdmissionProcessingError &&
        error.retryable === false,
    );
    assert.equal(provisionCalls, 0);
  }
});

test('lease loss after provider return preserves the acquired generation for recovery', async () => {
  const checkpoints: string[] = [];
  let providerReturned = false;
  const teardownOwnership: unknown[] = [];
  const ownership = {
    ownerGeneration: 'lease-token',
    resourceGeneration: 'resource-generation',
  };
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        providerReturned = true;
        return CONNECTION;
      },
      async teardownSandbox(_taskId: string, options: { ownership?: unknown }) {
        teardownOwnership.push(options.ownership);
      },
    },
    resolveSelectedRunStrict: async () => ({
      connection: CONNECTION,
      owner: {
        taskId: TASK_ID,
        providerId: 'sandbox-test',
        providerSandboxId: TASK_ID,
        ownership,
        status: 'running',
      },
    }),
  });
  await assert.rejects(
    service.processDurableAdmission(buildContext({
      checkpoints,
      authorize: async () => {
        if (providerReturned) throw new TaskAdmissionLeaseLostError(TASK_ID);
      },
    })),
    TaskAdmissionLeaseLostError,
  );
  assert.deepEqual(teardownOwnership, []);
  assert.equal(checkpoints.includes('agent_launch'), false);
});

for (const outcome of ['fenced', 'failed'] as const) {
  test(`durable admission cannot succeed after a ${outcome} launch outcome`, async () => {
    const checkpoints: string[] = [];
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: outcome })),
    );

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints })),
      (error: unknown) =>
        outcome === 'fenced'
          ? error instanceof TaskAdmissionLeaseLostError
          : error instanceof TaskAdmissionProcessingError &&
            error.stage === 'agent_launch' &&
            error.retryable === false,
    );
    assert.equal(checkpoints.includes('complete'), false);
  });
}
