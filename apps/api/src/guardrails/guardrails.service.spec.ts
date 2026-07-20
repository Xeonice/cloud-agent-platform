import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TaskProvisioningDiagnosticEventSchema,
  type TaskFailureCode,
  type TaskProvisioningDiagnosticEvent,
  type TaskStatus,
} from '@cap/contracts';
import type { ModuleRef } from '@nestjs/core';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  AdmissionTransitionIndeterminateError,
  type AdmissionTransitionResult,
} from '../tasks/tasks.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { ProvisionLookup } from '../sandbox/provision-lookup.port';
import {
  SandboxProvisioningStageError,
  SandboxRuntimeModelSetupError,
  type AgentTerminalLaunchOutcome,
  type SandboxProvisionContext,
} from '@cap/sandbox';
import { TaskBranchResolutionError } from '../forge/task-branch-resolver';
import type { TaskProvisioningDiagnosticRecorderPort } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { GuardrailsService, type GuardrailsConfig } from './guardrails.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const DIAGNOSTIC_ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function createAbortErrorForTest(): Error {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

type DiagnosticBeginRecorder = Pick<
  TaskProvisioningDiagnosticRecorderPort,
  'beginAttempt' | 'appendEvent'
>;

function diagnosticRecorder(
  recorder: DiagnosticBeginRecorder,
): TaskProvisioningDiagnosticRecorderPort {
  return recorder as unknown as TaskProvisioningDiagnosticRecorderPort;
}

function diagnosticWriteGate(
  enabled: boolean,
): TaskProvisioningDiagnosticsWriteGatePort {
  return { isEnabled: () => enabled };
}

type DiagnosticSettlementStep =
  | 'append_started'
  | 'append_terminal'
  | 'record_primary'
  | 'record_cleanup'
  | 'mark_complete';

interface DiagnosticSettlementHarness {
  readonly recorder: TaskProvisioningDiagnosticRecorderPort;
  readonly trace: string[];
  readonly events: TaskProvisioningDiagnosticEvent[];
  readonly primaryInputs: unknown[];
  readonly cleanupInputs: unknown[];
}

function diagnosticSettlementHarness(options: {
  readonly failAt?: DiagnosticSettlementStep;
  readonly trace?: string[];
} = {}): DiagnosticSettlementHarness {
  const trace = options.trace ?? [];
  const events: TaskProvisioningDiagnosticEvent[] = [];
  const primaryInputs: unknown[] = [];
  const cleanupInputs: unknown[] = [];
  let persistedPrimaryState: Exclude<
    import('@cap/contracts').TaskProvisioningDiagnosticAttemptState,
    'active'
  > | undefined;
  let persistedCleanup:
    | import('@cap/contracts').TaskProvisioningDiagnosticCleanupSummary
    | undefined;
  const failure = {
    ok: false as const,
    code: 'diagnostic_write_failed' as const,
    safeCause: 'diagnostic_write_failed' as const,
  };
  const recorder = {
    async beginAttempt(input) {
      trace.push('diagnostic_begin');
      return {
        ok: true as const,
        value: begunDiagnosticContext(input.taskId, input.admissionMode),
      };
    },
    async appendEvent(_context, candidate) {
      const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
      const step =
        event.outcome === 'started'
          ? ('append_started' as const)
          : ('append_terminal' as const);
      trace.push(step);
      if (options.failAt === step) return failure;
      events.push(event);
      return { ok: true as const, value: { event, replayed: false } };
    },
    async recordPrimary(_context, input) {
      trace.push('record_primary');
      primaryInputs.push(input);
      if (options.failAt === 'record_primary') return failure;
      persistedPrimaryState = input.state;
      return { ok: true as const, value: undefined as never };
    },
    async recordCleanup(_context, input) {
      trace.push('record_cleanup');
      cleanupInputs.push(input);
      if (options.failAt === 'record_cleanup') return failure;
      persistedCleanup = input;
      return { ok: true as const, value: undefined as never };
    },
    async resumeAttempt(input) {
      return {
        ok: true as const,
        value: {
          context: begunDiagnosticContext(input.taskId, input.admissionMode),
          state: persistedPrimaryState ?? 'active',
          providerFamily: 'unknown' as const,
          initialSequence: events.length,
          primaryPersisted: persistedPrimaryState !== undefined,
          ...(persistedCleanup === undefined
            ? {}
            : { cleanup: persistedCleanup }),
        },
      };
    },
    async markComplete() {
      trace.push('mark_complete');
      if (options.failAt === 'mark_complete') return failure;
      return { ok: true as const, value: undefined as never };
    },
  } satisfies Pick<
    TaskProvisioningDiagnosticRecorderPort,
    | 'beginAttempt'
    | 'appendEvent'
    | 'recordPrimary'
    | 'recordCleanup'
    | 'resumeAttempt'
    | 'markComplete'
  >;

  return {
    recorder: recorder as unknown as TaskProvisioningDiagnosticRecorderPort,
    trace,
    events,
    primaryInputs,
    cleanupInputs,
  };
}

function begunDiagnosticContext(
  taskId: string,
  admissionMode: 'legacy' | 'durable',
  attempt = 1,
) {
  return {
    taskId,
    attemptId: DIAGNOSTIC_ATTEMPT_ID,
    attempt,
    admissionMode,
  } as const;
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

test('legacy diagnostics stay disabled when the deployment write gate is closed', async () => {
  let beginCalls = 0;
  const provisionContexts: SandboxProvisionContext[] = [];
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      provisionContexts.push(context);
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const recorder = diagnosticRecorder({
    async beginAttempt() {
      beginCalls += 1;
      return { ok: true, value: begunDiagnosticContext(TASK_ID, 'legacy') };
    },
    async appendEvent() {
      assert.fail('a provider emitted an unexpected diagnostic event');
    },
  });
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(false),
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(beginCalls, 0);
  assert.equal(provisionContexts.length, 1);
  assert.equal(provisionContexts[0]?.diagnostics, undefined);
});

test('legacy samples the diagnostic write gate once per running boundary and ignores gate errors', async () => {
  for (const gateBehavior of ['enabled', 'throw'] as const) {
    let gateCalls = 0;
    let beginCalls = 0;
    const provisionContexts: SandboxProvisionContext[] = [];
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        provisionContexts.push(context);
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const recorder = diagnosticRecorder({
      async beginAttempt() {
        beginCalls += 1;
        return { ok: true, value: begunDiagnosticContext(TASK_ID, 'legacy') };
      },
      async appendEvent() {
        assert.fail('the focused provider does not emit operation diagnostics');
      },
    });
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: recorder,
      provisioningDiagnosticWriteGate: {
        isEnabled() {
          gateCalls += 1;
          if (gateBehavior === 'throw') {
            throw new Error('write gate unavailable');
          }
          return true;
        },
      },
    });

    assert.equal(await service.admit(TASK_ID), 'running', gateBehavior);
    assert.equal(gateCalls, 1, gateBehavior);
    assert.equal(beginCalls, gateBehavior === 'enabled' ? 1 : 0, gateBehavior);
    assert.equal(provisionContexts.length, 1, gateBehavior);
    assert.equal(
      provisionContexts[0]?.diagnostics?.mode,
      gateBehavior === 'enabled' ? 'task' : undefined,
      gateBehavior,
    );
  }
});

test('legacy diagnostics begin after the running fence and before resolution or provider selection', async () => {
  const events: string[] = [];
  let runningTransitionCommitted = false;
  let currentChecks = 0;
  let provisionContext: SandboxProvisionContext | undefined;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities() {
      events.push('provider-select');
      return ['terminal.websocket'];
    },
    async provision(context: SandboxProvisionContext) {
      events.push('provider-boundary');
      provisionContext = context;
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const recorder = diagnosticRecorder({
    async beginAttempt(input) {
      assert.equal(runningTransitionCommitted, true);
      assert.ok(currentChecks >= 1);
      assert.equal(events.includes('resolve-plan'), false);
      assert.equal(events.includes('provider-select'), false);
      events.push('diagnostic-begin');
      assert.deepEqual(input, {
        taskId: TASK_ID,
        admissionMode: 'legacy',
        providerFamily: 'unknown',
        stage: 'provider_selection',
      });
      return { ok: true, value: begunDiagnosticContext(TASK_ID, 'legacy') };
    },
    async appendEvent() {
      assert.fail('a provider emitted an unexpected diagnostic event');
    },
  });
  const service = buildService(
    async (_taskId, next) => {
      if (next === 'running') runningTransitionCommitted = true;
      return 'transitioned';
    },
    {
      sandbox,
      isCurrent: async () => {
        currentChecks += 1;
        return true;
      },
      provisionLookup: {
        ...DEFAULT_PROVISION_LOOKUP,
        async getTaskLaunchContext() {
          events.push('resolve-plan');
          return DEFAULT_PROVISION_LOOKUP.getTaskLaunchContext(TASK_ID);
        },
      },
      provisioningDiagnosticRecorder: recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    },
  );

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.ok(events.indexOf('diagnostic-begin') < events.indexOf('resolve-plan'));
  assert.ok(events.indexOf('diagnostic-begin') < events.indexOf('provider-select'));
  assert.equal(provisionContext?.diagnostics?.mode, 'task');
  assert.deepEqual(provisionContext?.diagnostics?.attemptContext, {
    schemaVersion: 1,
    taskId: TASK_ID,
    attemptId: DIAGNOSTIC_ATTEMPT_ID,
    attempt: 1,
    admissionMode: 'legacy',
    providerFamily: 'unknown',
  });
});

test('a queued legacy task opens exactly one diagnostic attempt only after promotion', async () => {
  const beginTaskIds: string[] = [];
  const provisionTaskIds: string[] = [];
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      provisionTaskIds.push(context.taskId);
      return { taskId: context.taskId, wsUrl: `ws://127.0.0.1/${context.taskId}` };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const recorder = diagnosticRecorder({
    async beginAttempt(input) {
      beginTaskIds.push(input.taskId);
      return {
        ok: true,
        value: begunDiagnosticContext(input.taskId, 'legacy'),
      };
    },
    async appendEvent() {
      assert.fail('a provider emitted an unexpected diagnostic event');
    },
  });
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(await service.admit(OTHER_TASK_ID), 'queued');
  assert.deepEqual(beginTaskIds, [TASK_ID]);
  assert.deepEqual(provisionTaskIds, [TASK_ID]);

  await service.onTerminal(TASK_ID);
  await waitFor(() => beginTaskIds.includes(OTHER_TASK_ID));
  assert.deepEqual(beginTaskIds, [TASK_ID, OTHER_TASK_ID]);
  assert.deepEqual(provisionTaskIds, [TASK_ID, OTHER_TASK_ID]);
});

test('legacy diagnostic begin failure or timeout never blocks provisioning or leaks an unusable emitter', async () => {
  for (const failure of ['result', 'throw', 'timeout'] as const) {
    let beginCalls = 0;
    const provisionContexts: SandboxProvisionContext[] = [];
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        provisionContexts.push(context);
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const recorder = diagnosticRecorder({
      async beginAttempt() {
        beginCalls += 1;
        if (failure === 'throw') throw new Error('diagnostic store unavailable');
        if (failure === 'timeout') return new Promise<never>(() => {});
        return {
          ok: false,
          code: 'diagnostic_write_failed',
          safeCause: 'diagnostic_write_failed',
        } as const;
      },
      async appendEvent() {
        assert.fail('a failed begin cannot emit provider diagnostics');
      },
    });
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });

    let admissionSettled = false;
    const admission = service.admit(TASK_ID).then((result) => {
      admissionSettled = true;
      return result;
    });
    if (failure === 'timeout') {
      await waitFor(() => admissionSettled);
    }
    assert.equal(await admission, 'running', failure);
    assert.equal(beginCalls, 1, failure);
    assert.equal(provisionContexts.length, 1, failure);
    assert.equal(provisionContexts[0]?.diagnostics, undefined, failure);
  }
});

test('legacy late diagnostic begin success retires its detached attempt without reaching the provider', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const lateBegin = deferred<{
    readonly ok: true;
    readonly value: ReturnType<typeof begunDiagnosticContext>;
  }>();
  const provisionContexts: SandboxProvisionContext[] = [];
  const recorder = {
    ...diagnostics.recorder,
    async beginAttempt() {
      return lateBegin.promise;
    },
  } as TaskProvisioningDiagnosticRecorderPort;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      provisionContexts.push(context);
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });

  const admission = service.admit(TASK_ID);
  await waitFor(() => provisionContexts.length === 1);

  assert.equal(await admission, 'running');
  assert.equal(provisionContexts[0]?.diagnostics, undefined);
  assert.equal(diagnostics.events.length, 0);
  assert.equal(diagnostics.primaryInputs.length, 0);

  lateBegin.resolve({
    ok: true,
    value: begunDiagnosticContext(TASK_ID, 'legacy'),
  });
  await waitFor(() => diagnostics.primaryInputs.length === 1);

  assert.deepEqual(
    diagnostics.events.map((event) => ({
      stage: event.stage,
      operation: event.operation,
      outcome: event.outcome,
      ...(event.outcome === 'started'
        ? {}
        : { cause: event.cause, retryable: event.retryable }),
    })),
    [
      {
        stage: 'provider_selection',
        operation: 'provider_select',
        outcome: 'started',
      },
      {
        stage: 'provider_selection',
        operation: 'provider_select',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
      },
    ],
  );
  assert.deepEqual(
    diagnostics.primaryInputs.map((input) => {
      const primary = input as {
        readonly state: string;
        readonly stage: string;
        readonly primary: {
          readonly outcome: string;
          readonly cause: string | null;
          readonly retryable: boolean;
        };
      };
      return {
        state: primary.state,
        stage: primary.stage,
        outcome: primary.primary.outcome,
        cause: primary.primary.cause,
        retryable: primary.primary.retryable,
      };
    }),
    [
      {
        state: 'interrupted',
        stage: 'provider_selection',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
      },
    ],
  );
  assert.deepEqual(diagnostics.cleanupInputs, [
    {
      state: 'not_required',
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    },
  ]);
  assert.equal(diagnostics.trace.includes('mark_complete'), true);
  assert.equal(
    diagnostics.trace.filter((step) => step === 'record_primary').length,
    1,
  );
});

test('legacy admission does not await launch proof and records primary success only after launched or attached', async () => {
  for (const kind of ['launched', 'attached'] as const) {
    const trace: string[] = [];
    const diagnostics = diagnosticSettlementHarness({ trace });
    const decision = deferred<AgentTerminalLaunchOutcome>();
    const gatewayOpened = deferred<void>();
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        trace.push('provider');
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    Object.assign(service, {
      gateway: {
        openSession() {
          trace.push('gateway');
          gatewayOpened.resolve();
          return { launchDecision: decision.promise };
        },
        unregisterSession() {},
      },
    });

    let admissionSettled = false;
    const admission = service.admit(TASK_ID).then((result) => {
      admissionSettled = true;
      return result;
    });
    await gatewayOpened.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      admissionSettled,
      true,
      `${kind}: admission must not wait for launchDecision`,
    );
    assert.equal(await admission, 'running', kind);
    assert.deepEqual(
      trace,
      ['diagnostic_begin', 'provider', 'gateway'],
      `${kind}: session registration is not launch proof`,
    );
    assert.equal(diagnostics.primaryInputs.length, 0, kind);

    decision.resolve({ kind });
    await waitFor(() => diagnostics.primaryInputs.length === 1);

    assert.deepEqual(
      diagnostics.events.map((event) => ({
        stage: event.stage,
        operation: event.operation,
        outcome: event.outcome,
        commandKind: event.commandKind,
        ...(event.outcome === 'started'
          ? {}
          : { cause: event.cause, retryable: event.retryable }),
      })),
      [
        {
          stage: 'agent_launch',
          operation: 'agent_launch',
          outcome: 'started',
          commandKind: 'agent_launch',
        },
        {
          stage: 'agent_launch',
          operation: 'agent_launch',
          outcome: 'succeeded',
          commandKind: 'agent_launch',
          cause: null,
          retryable: false,
        },
      ],
      kind,
    );
    assert.equal(diagnostics.primaryInputs.length, 1, kind);
    assert.deepEqual(diagnostics.cleanupInputs, [], kind);
    assert.equal(diagnostics.trace.includes('mark_complete'), false, kind);
    assert.equal(service.runningCount, 1, kind);
  }
});

test('legacy diagnostic settlement write failure cannot change provider gateway or slot success', async () => {
  const trace: string[] = [];
  const diagnostics = diagnosticSettlementHarness({
    trace,
    failAt: 'record_primary',
  });
  const decision = deferred<AgentTerminalLaunchOutcome>();
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      trace.push('provider');
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: diagnostics.recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });
  Object.assign(service, {
    gateway: {
      openSession() {
        trace.push('gateway');
        return { launchDecision: decision.promise };
      },
      unregisterSession() {},
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.deepEqual(trace, ['diagnostic_begin', 'provider', 'gateway']);
  decision.resolve({ kind: 'launched' });
  await waitFor(() => diagnostics.trace.includes('record_primary'));
  assert.deepEqual(trace, [
    'diagnostic_begin',
    'provider',
    'gateway',
    'append_started',
    'append_terminal',
    'record_primary',
  ]);
  assert.equal(service.runningCount, 1);
});

test('legacy failed absent or indeterminate launch proof records a partial failure without changing lifecycle ownership', async () => {
  for (const kind of ['failed', 'absent', 'indeterminate'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    Object.assign(service, {
      gateway: {
        openSession() {
          return { launchDecision: Promise.resolve({ kind }) };
        },
        unregisterSession() {},
      },
    });

    assert.equal(await service.admit(TASK_ID), 'running', kind);
    await waitFor(() => diagnostics.primaryInputs.length === 1);

    const terminal = diagnostics.events.find(
      (event) => event.outcome !== 'started',
    );
    assert.deepEqual(
      terminal && {
        stage: terminal.stage,
        operation: terminal.operation,
        commandKind: terminal.commandKind,
        outcome: terminal.outcome,
        cause: terminal.cause,
      },
      {
        stage: 'agent_launch',
        operation: 'agent_launch',
        commandKind: 'agent_launch',
        outcome: kind === 'indeterminate' ? 'indeterminate' : 'failed',
        cause: 'unknown',
      },
      kind,
    );
    assert.equal(diagnostics.cleanupInputs.length, 0, kind);
    assert.equal(diagnostics.trace.includes('mark_complete'), false, kind);
    assert.equal(service.runningCount, 1, kind);
    assert.equal(service.connectionFor(TASK_ID)?.taskId, TASK_ID, kind);
  }
});

test('legacy fenced launch proof leaves diagnostics unsettled and preserves the running owner', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const decision = deferred<AgentTerminalLaunchOutcome>();
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: diagnostics.recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });
  Object.assign(service, {
    gateway: {
      openSession() {
        return { launchDecision: decision.promise };
      },
      unregisterSession() {},
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  decision.resolve({ kind: 'fenced' });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(diagnostics.events, []);
  assert.equal(diagnostics.primaryInputs.length, 0);
  assert.equal(diagnostics.cleanupInputs.length, 0);
  assert.equal(diagnostics.trace.includes('mark_complete'), false);
  assert.equal(service.runningCount, 1);
  assert.equal(service.connectionFor(TASK_ID)?.taskId, TASK_ID);
});

test('legacy launch observer retires the attempt without writing success after the running fence is superseded', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const decision = deferred<AgentTerminalLaunchOutcome>();
  let current = true;
  let currentChecks = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => {
      currentChecks += 1;
      return current;
    },
    provisioningDiagnosticRecorder: diagnostics.recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });
  Object.assign(service, {
    gateway: {
      openSession() {
        return { launchDecision: decision.promise };
      },
      unregisterSession() {},
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  const checksBeforeDecision = currentChecks;
  current = false;
  decision.resolve({ kind: 'launched' });
  await waitFor(() => currentChecks > checksBeforeDecision);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(
    diagnostics.events.map((event) => ({
      stage: event.stage,
      operation: event.operation,
      outcome: event.outcome,
      ...(event.outcome === 'started' ? {} : { cause: event.cause }),
    })),
    [
      {
        stage: 'agent_launch',
        operation: 'agent_launch',
        outcome: 'started',
      },
      {
        stage: 'agent_launch',
        operation: 'agent_launch',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
      },
    ],
  );
  assert.equal(diagnostics.primaryInputs.length, 1);
  assert.deepEqual(diagnostics.cleanupInputs, []);
  assert.equal(diagnostics.trace.includes('mark_complete'), false);
});

test('legacy missing or synchronously failing terminal gateway records safe partial launch evidence', async () => {
  for (const variant of ['missing', 'throw'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    if (variant === 'throw') {
      Object.assign(service, {
        gateway: {
          openSession() {
            throw new Error('gateway transport unavailable');
          },
          unregisterSession() {},
        },
      });
    }

    assert.equal(await service.admit(TASK_ID), 'running', variant);
    await waitFor(() => diagnostics.primaryInputs.length === 1);
    const terminal = diagnostics.events.find(
      (event) => event.outcome !== 'started',
    );
    assert.deepEqual(
      terminal && {
        stage: terminal.stage,
        operation: terminal.operation,
        commandKind: terminal.commandKind,
        outcome: terminal.outcome,
        cause: terminal.cause,
      },
      {
        stage: 'agent_launch',
        operation: 'agent_launch',
        commandKind: 'agent_launch',
        outcome: 'failed',
        cause: variant === 'missing' ? 'provider_unavailable' : 'unknown',
      },
      variant,
    );
    assert.equal(diagnostics.primaryInputs.length, 1, variant);
    assert.equal(diagnostics.cleanupInputs.length, 0, variant);
    assert.equal(diagnostics.trace.includes('mark_complete'), false, variant);
    assert.equal(service.runningCount, 1, variant);
    assert.equal(service.connectionFor(TASK_ID)?.taskId, TASK_ID, variant);
  }
});

test('legacy admission remains authoritative when diagnostic append or primary persistence never settles', async () => {
  for (const hungAt of ['append_started', 'record_primary'] as const) {
    const entered = deferred<void>();
    const neverSettles = new Promise<never>(() => {});
    const recorder = {
      async beginAttempt(input) {
        return {
          ok: true as const,
          value: begunDiagnosticContext(input.taskId, input.admissionMode),
        };
      },
      async appendEvent(_context, candidate) {
        const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
        if (hungAt === 'append_started' && event.outcome === 'started') {
          entered.resolve();
          return neverSettles;
        }
        return { ok: true as const, value: { event, replayed: false } };
      },
      async recordPrimary() {
        if (hungAt === 'record_primary') {
          entered.resolve();
          return neverSettles;
        }
        assert.fail('recordPrimary cannot follow a hung append');
      },
      async recordCleanup() {
        assert.fail('a partial agent-launch diagnostic cannot record cleanup');
      },
      async markComplete() {
        assert.fail('a partial agent-launch diagnostic cannot mark complete');
      },
    } satisfies Pick<
      TaskProvisioningDiagnosticRecorderPort,
      | 'beginAttempt'
      | 'appendEvent'
      | 'recordPrimary'
      | 'recordCleanup'
      | 'markComplete'
    >;
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        return { taskId: context.taskId, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder:
        recorder as unknown as TaskProvisioningDiagnosticRecorderPort,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });

    let admissionSettled = false;
    const admission = service.admit(TASK_ID).then((result) => {
      admissionSettled = true;
      return result;
    });
    await entered.promise;
    await waitFor(() => admissionSettled);

    assert.equal(admissionSettled, true, hungAt);
    assert.equal(await admission, 'running', hungAt);
    assert.equal(service.runningCount, 1, hungAt);
    assert.equal(service.connectionFor(TASK_ID)?.taskId, TASK_ID, hungAt);
  }
});

test('legacy missing sandbox records provider-unavailable evidence only after the failed Task CAS', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const service = buildService(async () => 'transitioned', {
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: diagnostics.recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });
  installConfirmedTerminalCas(service, { trace: diagnostics.trace });

  assert.equal(await service.admit(TASK_ID), 'running');
  await waitFor(() => diagnostics.trace.includes('mark_complete'));
  const terminal = diagnostics.events.find(
    (event) => event.outcome !== 'started',
  );
  assert.deepEqual(
    terminal && {
      stage: terminal.stage,
      operation: terminal.operation,
      commandKind: terminal.commandKind,
      outcome: terminal.outcome,
      cause: terminal.cause,
    },
    {
      stage: 'provider_selection',
      operation: 'provider_select',
      commandKind: undefined,
      outcome: 'failed',
      cause: 'provider_unavailable',
    },
  );
  assert.equal(diagnostics.primaryInputs.length, 1);
  assert.equal(diagnostics.cleanupInputs.length, 1);
  assert.equal(diagnostics.trace.includes('mark_complete'), true);
  assert.ok(
    diagnostics.trace.indexOf('task_cas') <
      diagnostics.trace.indexOf('record_primary'),
  );
  assert.equal(service.runningCount, 0);
  assert.equal(service.connectionFor(TASK_ID), undefined);
});

test('legacy pre-provider plan and selection failures settle complete evidence after the failed Task CAS', async () => {
  for (const variant of ['plan', 'selection'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const taskFailures: string[] = [];
    const taskStatuses: TaskStatus[] = [];
    let providerCalls = 0;
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities() {
        if (variant === 'selection') throw new Error('selection unavailable');
        return ['terminal.websocket'];
      },
      async provision() {
        providerCalls += 1;
        return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisionLookup: {
        ...DEFAULT_PROVISION_LOOKUP,
        async getTaskLaunchContext() {
          if (variant === 'plan') {
            throw new TaskBranchResolutionError('branch_not_found');
          }
          return DEFAULT_PROVISION_LOOKUP.getTaskLaunchContext(TASK_ID);
        },
      },
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    installConfirmedTerminalCas(service, {
      trace: diagnostics.trace,
      statuses: taskStatuses,
      provisioningFailures: taskFailures,
    });

    assert.equal(await service.admit(TASK_ID), 'running', variant);
    assert.equal(providerCalls, 0, variant);
    await waitFor(() => diagnostics.trace.includes('mark_complete'));
    const terminal = diagnostics.events.find(
      (event) => event.outcome !== 'started',
    );
    assert.deepEqual(
      terminal && {
        stage: terminal.stage,
        operation: terminal.operation,
        commandKind: terminal.commandKind,
        outcome: terminal.outcome,
        cause: terminal.cause,
      },
      variant === 'plan'
        ? {
            stage: 'remote_ref_resolution',
            operation: 'remote_ref_resolve',
            commandKind: 'git_remote_ref',
            outcome: 'failed',
            cause: 'ref_not_found',
          }
        : {
            stage: 'provider_selection',
            operation: 'provider_select',
            commandKind: undefined,
            outcome: 'failed',
            cause: 'provider_unavailable',
          },
      variant,
    );
    assert.equal(diagnostics.cleanupInputs.length, 1, variant);
    assert.equal(
      diagnostics.trace.filter((step) => step === 'mark_complete').length,
      1,
      variant,
    );
    assert.ok(
      diagnostics.trace.indexOf('task_cas') <
        diagnostics.trace.indexOf('record_primary'),
      `${variant}: failed Task CAS precedes diagnostic primary`,
    );
    assert.deepEqual(
      taskFailures,
      variant === 'plan'
        ? ['provisioning_ref_not_found']
        : [],
      variant,
    );
    assert.deepEqual(taskStatuses, ['failed'], variant);
  }
});

test('remote same-target failed winner releases only the local legacy admission across plan selection and provider failures', async () => {
  for (const variant of ['plan', 'selection', 'provider'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    let terminalTransitionCalls = 0;
    let providerCalls = 0;
    let teardownCalls = 0;
    let unregisterCalls = 0;
    let forceFailureAuditCalls = 0;
    const failureLogs: string[] = [];
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities() {
        if (variant === 'selection') throw new Error('selection unavailable');
        return ['terminal.websocket'];
      },
      async provision() {
        providerCalls += 1;
        throw new SandboxProvisioningStageError('runtime_setup');
      },
      async teardownSandbox() {
        teardownCalls += 1;
      },
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisionLookup: {
        ...DEFAULT_PROVISION_LOOKUP,
        async getTaskLaunchContext() {
          if (variant === 'plan') {
            throw new TaskBranchResolutionError('branch_not_found');
          }
          return DEFAULT_PROVISION_LOOKUP.getTaskLaunchContext(TASK_ID);
        },
      },
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    const tasks = (service as unknown as { tasks: Record<string, unknown> })
      .tasks;
    Object.assign(tasks, {
      async transition() {
        terminalTransitionCalls += 1;
        return { status: 'failed' };
      },
      async failWithProvisioningFailure() {
        terminalTransitionCalls += 1;
        return { status: 'failed' };
      },
    });
    Object.assign(service, {
      prisma: {
        task: {
          async findUnique() {
            return { status: 'failed' };
          },
        },
      },
      audit: {
        async recordForceFailed() {
          forceFailureAuditCalls += 1;
        },
      },
      logger: {
        debug() {},
        error(message: unknown) {
          failureLogs.push(String(message));
        },
        log() {},
        warn(message: unknown) {
          failureLogs.push(String(message));
        },
      },
      gateway: {
        openSession() {
          assert.fail('a failed remote winner cannot open a local session');
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
      await service.admit(TASK_ID, {
        deadlineMs: 60_000,
        idleTimeoutMs: 30_000,
      }),
      'running',
      variant,
    );

    const primary = diagnostics.primaryInputs[0] as {
      readonly state: string;
      readonly primary: {
        readonly outcome: string;
        readonly cause: string | null;
      };
    };
    assert.deepEqual(
      {
        state: primary?.state,
        outcome: primary?.primary.outcome,
        cause: primary?.primary.cause,
      },
      {
        state: 'interrupted',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
      },
      `${variant}: remote winner cannot persist the local provider failure`,
    );
    assert.equal(diagnostics.primaryInputs.length, 1, variant);
    assert.equal(terminalTransitionCalls, 1, variant);
    assert.equal(providerCalls, variant === 'provider' ? 1 : 0, variant);
    assert.equal(teardownCalls, 0, variant);
    assert.equal(forceFailureAuditCalls, 0, variant);
    assert.deepEqual(failureLogs, [], variant);
    assert.equal(unregisterCalls, 1, variant);
    assert.equal(service.runningCount, 0, variant);
    assert.equal(service.queuedCount, 0, variant);
    const internals = service as unknown as {
      idle: { isTracking(taskId: string): boolean };
      deadlines: { isWatching(taskId: string): boolean };
      runnerMinutes: { intervals(): Array<{ endedAt: number | null }> };
    };
    assert.equal(internals.idle.isTracking(TASK_ID), false, variant);
    assert.equal(internals.deadlines.isWatching(TASK_ID), false, variant);
    assert.equal(
      internals.runnerMinutes
        .intervals()
        .some(({ endedAt }) => endedAt === null),
      false,
      variant,
    );
  }
});

test('legacy terminal authority preserves failed or indeterminate physical cleanup diagnostics', async () => {
  for (const variant of ['typed-throw', 'undefined'] as const) {
    const diagnostics = diagnosticSettlementHarness({
      failAt: variant === 'typed-throw' ? 'record_primary' : undefined,
    });
    const taskTransitions: TaskStatus[] = [];
    let gatewayCalls = 0;
    const sandbox = {
      getSandboxMode: () => 'danger-full-access',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        if (variant === 'typed-throw') {
          throw new SandboxProvisioningStageError('runtime_setup');
        }
        return undefined;
      },
      async teardownSandbox() {
        return variant === 'typed-throw'
          ? {
              outcome: 'failed' as const,
              proof: null,
              cause: 'cleanup_failed' as const,
              retryable: false,
            }
          : undefined;
      },
      async getSandboxCleanupAuthority() {
        const failed = variant === 'typed-throw';
        return {
          state: 'not_required' as const,
          ownershipKind: 'legacy' as const,
          orphanState: 'none' as const,
          status: 'terminal' as const,
          attemptCount: 1,
          lastAttemptOutcome: failed
            ? ('failed' as const)
            : ('indeterminate' as const),
          lastAttemptProof: null,
          lastAttemptCause: failed
            ? ('cleanup_failed' as const)
            : ('cleanup_unconfirmed' as const),
          lastAttemptRetryable: !failed,
          lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
        };
      },
    } as unknown as SandboxProvider;
    const service = buildService(async () => 'transitioned', {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    });
    installConfirmedTerminalCas(service, {
      trace: diagnostics.trace,
      statuses: taskTransitions,
    });
    Object.assign(service, {
      gateway: {
        openSession() {
          gatewayCalls += 1;
        },
        unregisterSession() {},
      },
    });

    assert.equal(await service.admit(TASK_ID), 'running', variant);
    await waitFor(() => diagnostics.primaryInputs.length >= 1);
    const terminal = diagnostics.events.find(
      (event) => event.outcome !== 'started',
    );
    assert.deepEqual(
      terminal && {
        stage: terminal.stage,
        operation: terminal.operation,
        commandKind: terminal.commandKind,
        outcome: terminal.outcome,
        cause: terminal.cause,
      },
      variant === 'typed-throw'
        ? {
            stage: 'runtime_setup',
            operation: 'runtime_setup',
            commandKind: 'runtime_setup',
            outcome: 'failed',
            cause: 'command_failed',
          }
        : {
            stage: 'sandbox_creation',
            operation: 'sandbox_create',
            commandKind: undefined,
            outcome: 'failed',
            cause: 'unknown',
          },
      variant,
    );
    assert.equal(
      diagnostics.primaryInputs.length,
      variant === 'typed-throw' ? 2 : 1,
      variant,
    );
    assert.equal(diagnostics.cleanupInputs.length, 1, variant);
    assert.deepEqual(
      diagnostics.cleanupInputs.map((input) => {
        const cleanup = input as {
          readonly state: string;
          readonly cause: string | null;
          readonly attemptCount: number;
          readonly lastAttemptOutcome: string | null;
          readonly observedAt: Date | null;
        };
        return {
          state: cleanup.state,
          cause: cleanup.cause,
          attemptCount: cleanup.attemptCount,
          lastAttemptOutcome: cleanup.lastAttemptOutcome,
          observed: cleanup.observedAt instanceof Date,
        };
      }),
      [
        variant === 'typed-throw'
          ? {
              state: 'failed',
              cause: 'cleanup_failed',
              attemptCount: 1,
              lastAttemptOutcome: 'failed',
              observed: true,
            }
          : {
              state: 'pending',
              cause: 'cleanup_unconfirmed',
              attemptCount: 1,
              lastAttemptOutcome: 'indeterminate',
              observed: true,
            },
      ],
      variant,
    );
    assert.equal(diagnostics.trace.includes('mark_complete'), false, variant);
    assert.deepEqual(taskTransitions, ['failed'], variant);
    assert.equal(gatewayCalls, 0, variant);
    assert.equal(service.runningCount, 0, variant);
    assert.ok(
      diagnostics.trace.indexOf('task_cas') <
        diagnostics.trace.indexOf('record_primary'),
      `${variant}: failed Task CAS precedes diagnostic primary`,
    );
  }
});

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

test('provision forwards the immutable resource snapshot in the provider context', async () => {
  const provisionContexts: unknown[] = [];
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => [
      'terminal.websocket',
      'resource.disk-size-gb',
    ],
    async provision(context: unknown) {
      provisionContexts.push(context);
      return {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/task',
        wsUrl: 'ws://sandbox.test/task/ws',
      };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisionLookup: {
      ...DEFAULT_PROVISION_LOOKUP,
      async getTaskLaunchContext() {
        return {
          modelIntent: { kind: 'explicit', selector: 'gpt-5.4' },
          ownerUserId: USER_ID,
          runtimeId: 'codex',
          executionMode: 'interactive-pty',
          workspaceMaterializationDeadlineMs: 900_000,
          environment: {
            providerId: 'sandbox-test',
            providerFamily: 'aio',
            runtimeId: 'codex',
            sourceKind: 'aio-docker-image',
            sourceRef: 'example.test/cap-aio@sha256:image',
            cliArtifactChecksum: `sha256:${'a'.repeat(64)}`,
            resources: { diskSizeGb: 8 },
          },
        };
      },
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(provisionContexts.length, 1);
  const context = provisionContexts[0] as {
    resources?: { diskSizeGb?: number };
    environment?: { resources?: { diskSizeGb?: number } };
  };
  assert.deepEqual(context.resources, { diskSizeGb: 8 });
  assert.equal(Object.isFrozen(context.resources), true);
  assert.equal(context.environment?.resources, context.resources);
});

test('provision forwards the canonical resolved branch workspace plan to the provider', async () => {
  const provisionContexts: unknown[] = [];
  let legacyCloneLookups = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => [
      'terminal.websocket',
      'workspace.git.materialize',
    ],
    async provision(context: unknown) {
      provisionContexts.push(context);
      return {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/task',
        wsUrl: 'ws://sandbox.test/task/ws',
      };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisionLookup: {
      ...DEFAULT_PROVISION_LOOKUP,
      async getCloneSpec() {
        legacyCloneLookups += 1;
        return {
          url: 'https://gitee.com/team/private.git',
          authHeader: 'Authorization: Basic legacy-compat-secret',
        };
      },
      async getTaskWorkspacePlan() {
        return {
          repositoryUrl: 'https://gitee.com/team/private.git',
          callerBranch: null,
          resolvedBranch: 'master',
          deadlineMs: 15 * 60_000,
        };
      },
    },
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(provisionContexts.length, 1);
  const context = provisionContexts[0] as {
    cloneSpec?: unknown;
    workspace?: {
      repositoryUrl: string;
      callerBranch: string | null;
      resolvedBranch: string;
      deadlineMs: number;
    };
  };
  assert.equal(context.cloneSpec, null);
  assert.equal(legacyCloneLookups, 0);
  assert.deepEqual(context.workspace, {
    repositoryUrl: 'https://gitee.com/team/private.git',
    callerBranch: null,
    resolvedBranch: 'master',
    deadlineMs: 15 * 60_000,
  });
  assert.equal(Object.isFrozen(context.workspace), true);
});

test('legacy provisioning forwards workspace progress through the same shared chain as durable admission', async () => {
  const provisionContexts: unknown[] = [];
  const forwarded: unknown[] = [];
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => [
      'terminal.websocket',
      'workspace.git.materialize',
    ],
    async provision(context: unknown) {
      provisionContexts.push(context);
      return {
        taskId: TASK_ID,
        baseUrl: 'http://sandbox.test/task',
        wsUrl: 'ws://sandbox.test/task/ws',
      };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
  });
  Object.assign(service, {
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
      onWorkspaceProgress: async (event: unknown) => {
        forwarded.push(event);
        // Best-effort forwarding: a throwing reporter never fails the chain.
        throw new Error('progress reporter unavailable');
      },
    }),
  });

  assert.equal(await service.admit(TASK_ID), 'running');
  assert.equal(provisionContexts.length, 1);
  const context = provisionContexts[0] as {
    onWorkspaceProgress?: (event: unknown) => void | Promise<void>;
  };
  // detach-workspace-clone D11: the legacy chain no longer forwards the raw
  // plan reporter — it carries the same shared workspace-progress chain as the
  // durable admission context, so additive progress variants (the detached
  // clone percent/objects/bytes event) flow through both without drift.
  assert.equal(typeof context.onWorkspaceProgress, 'function');
  await context.onWorkspaceProgress?.({
    status: 'started',
    stage: 'workspace_transfer',
  });
  await context.onWorkspaceProgress?.({
    status: 'progress',
    stage: 'workspace_transfer',
    percent: 42,
  });
  await context.onWorkspaceProgress?.({
    status: 'succeeded',
    stage: 'workspace_transfer',
  });
  assert.deepEqual(forwarded, [
    { status: 'started', stage: 'workspace_transfer' },
    { status: 'progress', stage: 'workspace_transfer', percent: 42 },
    { status: 'succeeded', stage: 'workspace_transfer' },
  ]);
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
  let diagnosticBeginCalls = 0;
  const recorder = diagnosticRecorder({
    async beginAttempt() {
      diagnosticBeginCalls += 1;
      return { ok: true, value: begunDiagnosticContext(TASK_ID, 'legacy') };
    },
    async appendEvent() {
      assert.fail('a superseded running winner cannot emit diagnostics');
    },
  });
  const service = buildService(
    async () => {
      transitionStarted = true;
      await transitionGate;
      return 'transitioned';
    },
    {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    },
  );

  const admission = service.admit(TASK_ID);
  await waitFor(() => transitionStarted);
  await service.onTerminal(TASK_ID);
  releaseTransition?.();
  assert.equal(await admission, 'running');
  assert.equal(provisionCalls, 0);
  assert.equal(diagnosticBeginCalls, 0);
  assert.equal(service.runningCount, 0);
});

test('operator stop while diagnostic begin is pending prevents stale provider start', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const beginEntered = deferred<void>();
  const beginResult = deferred<{
    readonly ok: true;
    readonly value: ReturnType<typeof begunDiagnosticContext>;
  }>();
  let provisionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision() {
      provisionCalls += 1;
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const recorder = {
    ...diagnostics.recorder,
    async beginAttempt() {
      beginEntered.resolve();
      return beginResult.promise;
    },
  } as TaskProvisioningDiagnosticRecorderPort;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });

  const admission = service.admit(TASK_ID);
  await beginEntered.promise;
  await service.onTerminal(TASK_ID, 'cancelled');
  beginResult.resolve({
    ok: true,
    value: begunDiagnosticContext(TASK_ID, 'legacy'),
  });

  assert.equal(await admission, 'running');
  await waitFor(() => diagnostics.primaryInputs.length === 1);
  const primary = diagnostics.primaryInputs[0] as {
    readonly state: string;
    readonly stage: string;
    readonly primary: { readonly outcome: string; readonly cause: string | null };
  };
  assert.deepEqual(
    {
      state: primary.state,
      stage: primary.stage,
      outcome: primary.primary.outcome,
      cause: primary.primary.cause,
    },
    {
      state: 'cancelled',
      stage: 'provider_selection',
      outcome: 'cancelled',
      cause: 'cancelled',
    },
  );
  assert.equal(diagnostics.trace.includes('mark_complete'), true);
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

test('legacy provider rejection after stop records cancelled complete evidence without force-fail', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const provisionEntered = deferred<void>();
  const releaseProvision = deferred<void>();
  let provisionContext: SandboxProvisionContext | undefined;
  let teardownCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      provisionContext = context;
      const operationId = context.diagnostics?.createOperationId();
      if (operationId && context.diagnostics) {
        await context.diagnostics.emit({
          operationId,
          stage: 'runtime_setup',
          operation: 'runtime_setup',
          channel: 'primary',
          commandKind: 'runtime_setup',
          outcome: 'started',
        });
      }
      provisionEntered.resolve();
      await releaseProvision.promise;
      throw new SandboxProvisioningStageError('runtime_setup');
    },
    async teardownSandbox() {
      teardownCalls += 1;
      return {
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
      } as const;
    },
  } as unknown as SandboxProvider;
  const transitions: string[] = [];
  const service = buildService(
    async (_taskId, next) => {
      transitions.push(next);
      return 'transitioned';
    },
    {
      sandbox,
      isCurrent: async () => true,
      provisioningDiagnosticRecorder: diagnostics.recorder,
      provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
    },
  );
  const errorLogs: string[] = [];
  let failProvisioningCalls = 0;
  Object.assign(service, {
    logger: {
      debug() {},
      error(message: unknown) {
        errorLogs.push(String(message));
      },
      log() {},
      warn() {},
    },
    async failProvisioning() {
      failProvisioningCalls += 1;
    },
  });

  const admission = service.admit(TASK_ID);
  await provisionEntered.promise;
  assert.equal(provisionContext?.cancellationSignal?.aborted, false);
  const terminal = service.onTerminal(TASK_ID, 'cancelled');
  assert.equal(
    provisionContext?.cancellationSignal?.aborted,
    true,
    'the terminal fence aborts provider work synchronously',
  );
  const externalBoundaryGuard = provisionContext?.externalBoundaryGuard;
  assert.ok(externalBoundaryGuard);
  await assert.rejects(
    externalBoundaryGuard({
      taskId: TASK_ID,
      action: 'sandbox.create',
      position: 'before',
    }),
    { name: 'AbortError' },
  );
  await terminal;
  releaseProvision.resolve();

  assert.equal(await admission, 'running');
  assert.deepEqual(
    diagnostics.events.map((event) => ({
      stage: event.stage,
      operation: event.operation,
      outcome: event.outcome,
      cause: event.outcome === 'started' ? undefined : event.cause,
    })),
    [
      {
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        outcome: 'started',
        cause: undefined,
      },
      {
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        outcome: 'started',
        cause: undefined,
      },
      {
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        outcome: 'cancelled',
        cause: 'cancelled',
      },
    ],
  );
  assert.deepEqual(
    diagnostics.primaryInputs.map((input) => {
      const primary = input as {
        readonly state: string;
        readonly stage: string;
        readonly primary: {
          readonly outcome: string;
          readonly cause: string | null;
        };
      };
      return {
        state: primary.state,
        stage: primary.stage,
        outcome: primary.primary.outcome,
        cause: primary.primary.cause,
      };
    }),
    [
      {
        state: 'cancelled',
        stage: 'runtime_setup',
        outcome: 'cancelled',
        cause: 'cancelled',
      },
    ],
  );
  assert.equal(diagnostics.cleanupInputs.length, 1);
  assert.deepEqual(
    (() => {
      const cleanup = diagnostics.cleanupInputs[0] as {
        readonly state: string;
        readonly cause: string | null;
        readonly attemptCount: number;
        readonly lastAttemptOutcome: string | null;
        readonly observedAt: Date | null;
      };
      return {
        state: cleanup.state,
        cause: cleanup.cause,
        attemptCount: cleanup.attemptCount,
        lastAttemptOutcome: cleanup.lastAttemptOutcome,
        observed: cleanup.observedAt instanceof Date,
      };
    })(),
    {
      state: 'succeeded',
      cause: null,
      attemptCount: 1,
      lastAttemptOutcome: 'succeeded',
      observed: true,
    },
  );
  assert.equal(diagnostics.trace.includes('mark_complete'), true);
  assert.equal(teardownCalls, 1, 'only the terminal owner performs cleanup');
  assert.deepEqual(transitions, ['running']);
  assert.equal(errorLogs.length, 0);
  assert.equal(failProvisioningCalls, 0);
  assert.equal(service.runningCount, 0);
});

test('cancelled Task CAS winner suppresses provision-failure primary log and audit', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const transitionEntered = deferred<void>();
  const releaseFailedTransition = deferred<void>();
  const failureLogs: string[] = [];
  let forceFailAudits = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision() {
      throw new SandboxProvisioningStageError('runtime_setup');
    },
    async teardownSandbox() {
      return {
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
      } as const;
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
    provisioningDiagnosticRecorder: diagnostics.recorder,
    provisioningDiagnosticWriteGate: diagnosticWriteGate(true),
  });
  const tasks = (service as unknown as { tasks: Record<string, unknown> }).tasks;
  Object.assign(tasks, {
    async transition() {
      transitionEntered.resolve();
      await releaseFailedTransition.promise;
      throw new Error('failed transition lost to cancelled');
    },
  });
  Object.assign(service, {
    logger: {
      debug() {},
      error(message: unknown) {
        failureLogs.push(String(message));
      },
      log() {},
      warn(message: unknown) {
        failureLogs.push(String(message));
      },
    },
    audit: {
      async recordForceFailed() {
        forceFailAudits += 1;
      },
    },
  });

  const admission = service.admit(TASK_ID);
  await transitionEntered.promise;
  service.fenceTerminal(TASK_ID, 'cancelled');
  const cancelledSettlement = service.onTerminal(TASK_ID, 'cancelled');
  releaseFailedTransition.resolve();

  assert.equal(await admission, 'running');
  await cancelledSettlement;
  assert.equal(diagnostics.primaryInputs.length, 1);
  const primary = diagnostics.primaryInputs[0] as {
    readonly state: string;
    readonly primary: { readonly outcome: string; readonly cause: string | null };
  };
  assert.deepEqual(
    {
      state: primary.state,
      outcome: primary.primary.outcome,
      cause: primary.primary.cause,
    },
    { state: 'cancelled', outcome: 'cancelled', cause: 'cancelled' },
  );
  assert.equal(forceFailAudits, 0);
  assert.equal(
    failureLogs.some((message) => message.includes('provision sandbox')),
    false,
  );
  assert.equal(
    failureLogs.some((message) => message.includes('force-failing')),
    false,
  );
});

test('legacy provisioning composes the plan cancellation signal with its terminal signal', async () => {
  const contextEntered = deferred<SandboxProvisionContext>();
  const releaseProvision = deferred<void>();
  const planCancellation = new AbortController();
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      contextEntered.resolve(context);
      await releaseProvision.promise;
      return { taskId: TASK_ID, wsUrl: 'ws://127.0.0.1:1' };
    },
    async teardownSandbox() {
      return {
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
      } as const;
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
  });
  Object.assign(service, {
    async resolveProvisionPlan() {
      return {
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' as const },
        runtimeId: 'codex',
        executionMode: 'interactive-pty' as const,
        cancellationSignal: planCancellation.signal,
        requiredCapabilities: ['terminal.websocket'],
        featureCapabilities: ['terminal.websocket'],
      };
    },
  });

  const admission = service.admit(TASK_ID);
  const context = await contextEntered.promise;
  assert.equal(context.cancellationSignal?.aborted, false);

  planCancellation.abort();
  assert.equal(
    context.cancellationSignal?.aborted,
    true,
    'either source aborts the composed provider signal',
  );

  releaseProvision.resolve();
  assert.equal(await admission, 'running');
  await service.onTerminal(TASK_ID);
  assert.equal(service.runningCount, 0);
});

test('legacy external boundary guard aborts immediately while the running-fence read is stalled', async () => {
  const contextEntered = deferred<SandboxProvisionContext>();
  const releaseProvision = deferred<void>();
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(context: SandboxProvisionContext) {
      contextEntered.resolve(context);
      await releaseProvision.promise;
      throw createAbortErrorForTest();
    },
    async teardownSandbox() {
      return {
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
      } as const;
    },
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', {
    sandbox,
    isCurrent: async () => true,
  });

  const admission = service.admit(TASK_ID);
  const context = await contextEntered.promise;
  const tasks = (service as unknown as { tasks: Record<string, unknown> }).tasks;
  Object.assign(tasks, {
    async isAdmissionTransitionCurrent() {
      return new Promise<boolean>(() => undefined);
    },
  });

  const guard = context.externalBoundaryGuard;
  assert.ok(guard);
  const guarded = guard({
    taskId: TASK_ID,
    action: 'sandbox.create',
    position: 'before',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const terminal = service.onTerminal(TASK_ID, 'cancelled');
  await assert.rejects(
    Promise.race([
      guarded,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('boundary guard did not abort')), 100),
      ),
    ]),
    { name: 'AbortError' },
  );

  releaseProvision.resolve();
  await terminal;
  assert.equal(await admission, 'running');
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

test('structured model setup errors persist the dedicated safe failure before generic provisioning failure', async () => {
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
  const internals = service as unknown as {
    failProvisioning(taskId: string, error: unknown): Promise<void>;
  };

  await internals.failProvisioning(
    TASK_ID,
    new SandboxRuntimeModelSetupError('material-verify'),
  );
  assert.deepEqual(failures, ['runtime_model_setup_failed']);
});

test('typed branch resolution failures persist the canonical provisioning cause', async () => {
  const service = buildService(async () => 'transitioned');
  const failures: TaskFailureCode[] = [];
  Object.assign(service, {
    tasks: {
      async failWithProvisioningFailure(
        _taskId: string,
        code: TaskFailureCode,
      ) {
        failures.push(code);
        return {};
      },
    },
  });
  const internals = service as unknown as {
    failProvisioning(taskId: string, error: unknown): Promise<void>;
  };

  await internals.failProvisioning(
    TASK_ID,
    new TaskBranchResolutionError('branch_not_found'),
  );

  assert.deepEqual(failures, ['provisioning_ref_not_found']);
});

test('legacy provisioning logs redact provider failure details', async () => {
  const canary = 'CAP_PROVISION_SECRET_CANARY_8_5';
  const messages: string[] = [];
  let provisionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'danger-full-access',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision() {
      provisionCalls += 1;
      throw new Error(`clone failed with ${canary}`);
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
  const service = buildService(async () => 'transitioned', { sandbox });
  const record = (message: unknown) => messages.push(String(message));
  Object.assign(service, {
    logger: {
      debug: record,
      error: record,
      log: record,
      warn: record,
    },
  });
  installConfirmedTerminalCas(service);

  assert.equal(await service.admit(TASK_ID), 'running');

  assert.equal(provisionCalls, 1);
  assert.equal(messages.some((message) => message.includes(canary)), false);
  assert.ok(
    messages.includes(
      `provision sandbox for task ${TASK_ID} failed (provider details redacted)`,
    ),
  );
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
