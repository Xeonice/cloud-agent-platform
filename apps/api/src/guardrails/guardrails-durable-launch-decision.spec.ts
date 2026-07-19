import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticAttemptState,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningDiagnosticProviderFamily,
} from '@cap/contracts';
import {
  SandboxCleanupCoordinationPendingError,
  SandboxCleanupPendingError,
  SandboxProvisioningStageError,
  type AgentTerminalLaunchOutcome,
  type SandboxProvisionContext,
  type SandboxRunCleanupAuthorityProjection,
} from '@cap/sandbox';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { getTaskLogContext } from '../observability/log-context';
import { TaskBranchResolutionError } from '../forge/task-branch-resolver';
import type { TaskProvisioningDiagnosticRecorderPort } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
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
const DIAGNOSTIC_ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE_TOKEN_CANARY = 'lease-token';
const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 10,
};
const CONNECTION = {
  taskId: TASK_ID,
  baseUrl: 'http://sandbox.test/task',
  wsUrl: 'ws://sandbox.test/task/ws',
};

function pendingGenerationCleanupAuthority(
  overrides: Partial<SandboxRunCleanupAuthorityProjection> = {},
): SandboxRunCleanupAuthorityProjection {
  return {
    state: 'pending',
    ownershipKind: 'generation',
    orphanState: 'unknown',
    status: 'deleting',
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
    ...overrides,
  };
}

function succeededGenerationCleanupAuthority(
  status: 'removed' = 'removed',
): SandboxRunCleanupAuthorityProjection {
  return pendingGenerationCleanupAuthority({
    state: 'succeeded',
    orphanState: 'none',
    status,
    attemptCount: 1,
    lastAttemptOutcome: 'succeeded',
    lastAttemptProof: 'already-absent',
    lastAttemptCause: null,
    lastAttemptRetryable: false,
    lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
  });
}

function retainedTerminalCleanupAuthority(): SandboxRunCleanupAuthorityProjection {
  return pendingGenerationCleanupAuthority({
    state: 'not_required',
    orphanState: 'none',
    status: 'terminal',
    attemptCount: 1,
    lastAttemptOutcome: 'succeeded',
    lastAttemptProof: 'found-and-cleaned',
    lastAttemptCause: null,
    lastAttemptRetryable: false,
    lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
  });
}

function absentCleanupAuthority(): SandboxRunCleanupAuthorityProjection {
  return {
    state: 'not_required',
    ownershipKind: 'none',
    orphanState: 'none',
    status: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    lastAttemptProof: null,
    lastAttemptCause: null,
    lastAttemptRetryable: null,
    lastAttemptObservedAt: null,
  };
}

function failedGenerationCleanupAuthority(): SandboxRunCleanupAuthorityProjection {
  return pendingGenerationCleanupAuthority({
    state: 'failed',
    status: 'failed',
    attemptCount: 2,
    lastAttemptOutcome: 'failed',
    lastAttemptProof: null,
    lastAttemptCause: 'cleanup_failed',
    lastAttemptRetryable: false,
    lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
  });
}

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
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
  readonly initialPrimaryState?: TaskProvisioningDiagnosticAttemptState;
  readonly providerFamily?: TaskProvisioningDiagnosticProviderFamily | null;
} = {}): DiagnosticSettlementHarness {
  const trace = options.trace ?? [];
  const events: TaskProvisioningDiagnosticEvent[] = [];
  const primaryInputs: unknown[] = [];
  const cleanupInputs: unknown[] = [];
  let persistedPrimaryState = options.initialPrimaryState ?? 'active';
  let persistedCleanup: TaskProvisioningDiagnosticCleanupSummary = {
    state: 'not_required',
    cause: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    observedAt: null,
  };
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
        value: begunDiagnosticContext(input.expectedAttempt ?? 1),
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
    async resumeAttempt(input) {
      return {
        ok: true as const,
        value: {
          context: begunDiagnosticContext(input.attempt),
          state: persistedPrimaryState,
          providerFamily: options.providerFamily ?? 'unknown',
          initialSequence: events.length,
          primaryPersisted: persistedPrimaryState !== 'active',
          cleanup: persistedCleanup,
        },
      };
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
    async markComplete() {
      trace.push('mark_complete');
      if (options.failAt === 'mark_complete') return failure;
      return { ok: true as const, value: undefined as never };
    },
  } satisfies Pick<
    TaskProvisioningDiagnosticRecorderPort,
    | 'beginAttempt'
    | 'appendEvent'
    | 'resumeAttempt'
    | 'recordPrimary'
    | 'recordCleanup'
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

function begunDiagnosticContext(attempt = 1) {
  return {
    taskId: TASK_ID,
    attemptId: DIAGNOSTIC_ATTEMPT_ID,
    attempt,
    admissionMode: 'durable',
  } as const;
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
  provisioningDiagnosticRecorder?: TaskProvisioningDiagnosticRecorderPort,
  provisioningDiagnosticWriteGate?: TaskProvisioningDiagnosticsWriteGatePort,
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
    undefined,
    provisioningDiagnosticRecorder,
    provisioningDiagnosticWriteGate,
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

test('one durable claim coalesces concurrent and completed replays without resuming ordinary processing', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const beginInputs: unknown[] = [];
  let resumeCalls = 0;
  let provisionCalls = 0;
  let sessionCalls = 0;
  const provisionEntered = deferred<void>();
  const releaseProvision = deferred<void>();
  const recorder = {
    ...diagnostics.recorder,
    async beginAttempt(input) {
      beginInputs.push(input);
      return { ok: true as const, value: begunDiagnosticContext(1) };
    },
    async resumeAttempt(
      input: Parameters<
        TaskProvisioningDiagnosticRecorderPort['resumeAttempt']
      >[0],
    ) {
      resumeCalls += 1;
      return diagnostics.recorder.resumeAttempt(input);
    },
  } as TaskProvisioningDiagnosticRecorderPort;
  const gateway = gatewayWithDecision(Promise.resolve({ kind: 'launched' }));
  const service = buildService(
    {
      ...gateway,
      openSession(connection, selectedRun, options) {
        sessionCalls += 1;
        return gateway.openSession(connection, selectedRun, options);
      },
    },
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
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
    } as unknown as SandboxProvider,
  });
  const checkpoints: string[] = [];
  const context = buildContext({ checkpoints });

  const first = service.processDurableAdmission(context);
  await provisionEntered.promise;
  const concurrentReplay = service.processDurableAdmission(context);
  assert.equal(concurrentReplay, first);
  releaseProvision.resolve();

  const [firstResult, concurrentResult] = await Promise.all([
    first,
    concurrentReplay,
  ]);
  assert.equal(firstResult, concurrentResult);
  const completedReplay = service.processDurableAdmission(context);
  assert.equal(completedReplay, first);
  assert.equal(await completedReplay, firstResult);
  assert.deepEqual(firstResult, { kind: 'succeeded' });
  assert.equal(beginInputs.length, 1);
  assert.equal(resumeCalls, 1);
  assert.equal(provisionCalls, 1);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(checkpoints, [
    'sandbox_creation',
    'runtime_setup',
    'readiness',
    'agent_launch',
    'complete',
  ]);
});

test('a succeeded terminal cleanup claim cannot re-enter ordinary durable provisioning', async () => {
  let authorizeCalls = 0;
  let beginCalls = 0;
  let provisionCalls = 0;
  const recorder = {
    async beginAttempt() {
      beginCalls += 1;
      return { ok: true as const, value: begunDiagnosticContext(3) };
    },
  } as unknown as TaskProvisioningDiagnosticRecorderPort;
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
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
    } as unknown as SandboxProvider,
  });
  const base = buildContext({
    checkpoints: [],
    authorize: async () => {
      authorizeCalls += 1;
    },
  });
  const context: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      sourceState: 'succeeded',
      attempt: 3,
      stage: 'complete',
      taskStatus: 'completed',
      taskLifecycleVersion: 9,
    },
  };

  await assert.rejects(
    service.processDurableAdmission(context),
    TaskAdmissionLeaseLostError,
  );
  assert.equal(authorizeCalls, 0);
  assert.equal(beginCalls, 0);
  assert.equal(provisionCalls, 0);
});

test('retry and expired-lease recovery interrupt prior diagnostics, but only a proven retry carries retry evidence', async () => {
  for (const scenario of [
    { sourceState: 'running' as const, interrupts: true },
    { sourceState: 'retrying' as const, interrupts: true },
    { sourceState: 'accepted' as const, interrupts: false },
    { sourceState: 'queued' as const, interrupts: false },
  ]) {
    const diagnostics = diagnosticSettlementHarness();
    const beginInputs: unknown[] = [];
    let resumeCalls = 0;
    const recorder = {
      ...diagnostics.recorder,
      async beginAttempt(input) {
        beginInputs.push(input);
        return { ok: true as const, value: begunDiagnosticContext(1) };
      },
      async resumeAttempt(
        input: Parameters<
          TaskProvisioningDiagnosticRecorderPort['resumeAttempt']
        >[0],
      ) {
        resumeCalls += 1;
        return diagnostics.recorder.resumeAttempt(input);
      },
    } as TaskProvisioningDiagnosticRecorderPort;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      recorder,
      diagnosticWriteGate(true),
    );
    const base = buildContext({ checkpoints: [] });
    const context: TaskAdmissionProcessorContext = {
      ...base,
      claim: {
        ...base.claim,
        sourceState: scenario.sourceState,
        ...(scenario.sourceState === 'retrying'
          ? { causeCode: 'provisioning_tls_network_failed' as const }
          : {}),
      },
    };

    assert.deepEqual(await service.processDurableAdmission(context), {
      kind: 'succeeded',
    });
    assert.deepEqual(beginInputs, [
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 1,
        providerFamily: 'unknown',
        stage: 'provider_selection',
        ...(scenario.interrupts
          ? { activeDisposition: 'interrupt' as const }
          : {}),
        ...(scenario.sourceState === 'retrying'
          ? {
              retry: {
                stage: 'sandbox_creation',
                cause: 'tls_network_failed',
              },
            }
          : {}),
      },
    ]);
    assert.equal(resumeCalls, 1, scenario.sourceState);
  }
});

test('queued durable reservation opens no diagnostic attempt and crosses no provider boundary', async () => {
  const beginInputs: unknown[] = [];
  let provisionCalls = 0;
  let fence: ReturnType<
    TaskAdmissionProcessorContext['lease']['currentTaskFence']
  > = { status: 'queued', lifecycleVersion: 1 };
  const recorder = diagnosticRecorder({
    async beginAttempt(input) {
      beginInputs.push(input);
      return { ok: true, value: begunDiagnosticContext() };
    },
    async appendEvent() {
      assert.fail('queued admission cannot emit provider diagnostics');
    },
  });
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    tasks: {
      async reserveDurableAdmissionCapacity() {
        return {
          outcome: 'queued' as const,
          status: 'queued' as const,
          lifecycleVersion: 1,
          transitioned: false,
        };
      },
    },
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        provisionCalls += 1;
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  const base = buildContext({ checkpoints: [] });
  const context: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      sourceState: 'queued',
      taskStatus: 'queued',
    },
    lease: {
      ...base.lease,
      currentTaskFence: () => fence,
      beginTaskTransition: (targets) => {
        assert.deepEqual(targets, ['running']);
        return 2;
      },
      commitTaskTransition: (next) => {
        fence = next;
      },
      rollbackTaskTransition: () => {},
    },
  };

  assert.deepEqual(await service.processDurableAdmission(context), {
    kind: 'queued',
    stage: 'sandbox_creation',
  });
  assert.deepEqual(beginInputs, []);
  assert.equal(provisionCalls, 0);
});

test('fresh durable running reservation begins diagnostics after commit and current fence but before provider work', async () => {
  const events: string[] = [];
  let fence: ReturnType<
    TaskAdmissionProcessorContext['lease']['currentTaskFence']
  > = { status: 'pending', lifecycleVersion: 0 };
  const recorder = diagnosticRecorder({
    async beginAttempt() {
      events.push('diagnostic-begin');
      return { ok: true, value: begunDiagnosticContext() };
    },
    async appendEvent() {
      assert.fail('the focused provider does not emit operation diagnostics');
    },
  });
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    tasks: {
      async reserveDurableAdmissionCapacity() {
        events.push('reservation-committed');
        return {
          outcome: 'running' as const,
          status: 'running' as const,
          lifecycleVersion: 1,
          transitioned: true,
        };
      },
    },
    resolveProvisionPlan: async () => {
      events.push('resolve-plan');
      return {
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' as const },
        runtimeId: 'codex',
        executionMode: 'interactive-pty' as const,
        resources: {},
        workspace: {
          repositoryUrl: 'https://example.test/repo.git',
          callerBranch: null,
          resolvedBranch: 'main',
          deadlineMs: 900_000,
        },
        requiredCapabilities: [],
      };
    },
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => {
        events.push('provider-select');
        return ['terminal.websocket'];
      },
      async provision() {
        events.push('provider-boundary');
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  const base = buildContext({ checkpoints: [] });
  const context: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      sourceState: 'accepted',
      taskStatus: 'pending',
      taskLifecycleVersion: 0,
    },
    lease: {
      ...base.lease,
      currentTaskFence: () => {
        events.push(`current-fence:${fence.status}`);
        return fence;
      },
      beginTaskTransition: (targets) => {
        assert.deepEqual(targets, ['queued', 'running']);
        return 1;
      },
      commitTaskTransition: (next) => {
        fence = next;
        events.push('reservation-fence-committed');
      },
      rollbackTaskTransition: () => {
        assert.fail('a successful running reservation cannot roll back');
      },
    },
  };

  assert.deepEqual(await service.processDurableAdmission(context), {
    kind: 'succeeded',
  });
  const begin = events.indexOf('diagnostic-begin');
  assert.ok(begin > events.indexOf('reservation-committed'));
  assert.ok(begin > events.indexOf('reservation-fence-committed'));
  assert.ok(begin > events.indexOf('current-fence:running'));
  assert.ok(begin < events.indexOf('resolve-plan'));
  assert.ok(begin < events.indexOf('provider-select'));
  assert.ok(begin < events.indexOf('provider-boundary'));
});

test('running durable admission binds one fenced diagnostic identity to provider and safe log context', async () => {
  const beginInputs: unknown[] = [];
  const providerLogContexts: unknown[] = [];
  let provisionContext: SandboxProvisionContext | undefined;
  const recorder = diagnosticRecorder({
    async beginAttempt(input) {
      beginInputs.push(input);
      return { ok: true, value: begunDiagnosticContext(1) };
    },
    async appendEvent() {
      assert.fail('the focused provider does not emit operation diagnostics');
    },
  });
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => {
        providerLogContexts.push(getTaskLogContext());
        return ['terminal.websocket'];
      },
      async provision(context: SandboxProvisionContext) {
        provisionContext = context;
        providerLogContexts.push(getTaskLogContext());
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  const context = buildContext({ checkpoints: [] });

  assert.deepEqual(await service.processDurableAdmission(context), {
    kind: 'succeeded',
  });
  assert.deepEqual(beginInputs, [
    {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: context.claim.attempt,
      providerFamily: 'unknown',
      stage: 'provider_selection',
      activeDisposition: 'interrupt',
    },
  ]);
  assert.equal(provisionContext?.diagnostics?.mode, 'task');
  assert.deepEqual(provisionContext?.diagnostics?.attemptContext, {
    schemaVersion: 1,
    taskId: TASK_ID,
    attemptId: DIAGNOSTIC_ATTEMPT_ID,
    attempt: context.claim.attempt,
    admissionMode: 'durable',
    providerFamily: 'unknown',
  });
  assert.deepEqual(providerLogContexts, [
    {
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: context.claim.attempt,
    },
    {
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: context.claim.attempt,
    },
  ]);
  assert.equal(JSON.stringify(beginInputs).includes(LEASE_TOKEN_CANARY), false);
  assert.equal(
    JSON.stringify(providerLogContexts).includes(LEASE_TOKEN_CANARY),
    false,
  );
});

test('post-reservation non-running fence prevents diagnostic begin and provisioning', async () => {
  let beginCalls = 0;
  let provisionCalls = 0;
  let authorizationChecks = 0;
  let fence: ReturnType<
    TaskAdmissionProcessorContext['lease']['currentTaskFence']
  > = { status: 'pending', lifecycleVersion: 0 };
  const recorder = diagnosticRecorder({
    async beginAttempt() {
      beginCalls += 1;
      return { ok: true, value: begunDiagnosticContext() };
    },
    async appendEvent() {
      assert.fail('a fenced admission cannot emit diagnostics');
    },
  });
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    tasks: {
      async reserveDurableAdmissionCapacity() {
        return {
          outcome: 'running' as const,
          status: 'running' as const,
          lifecycleVersion: 1,
          transitioned: true,
        };
      },
    },
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        provisionCalls += 1;
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });
  const base = buildContext({ checkpoints: [] });
  const context: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      sourceState: 'accepted',
      taskStatus: 'pending',
      taskLifecycleVersion: 0,
    },
    lease: {
      ...base.lease,
      currentTaskFence: () => fence,
      beginTaskTransition: () => 1,
      commitTaskTransition: (next) => {
        fence = next;
      },
      rollbackTaskTransition: () => {},
      authorize: async () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) {
          fence = { status: 'cancelled', lifecycleVersion: 2 };
        }
      },
    },
  };

  await assert.rejects(
    service.processDurableAdmission(context),
    TaskAdmissionLeaseLostError,
  );
  assert.equal(beginCalls, 0);
  assert.equal(provisionCalls, 0);
});

test('durable diagnostic begin failure or timeout never blocks admission or exposes an unusable emitter', async () => {
  for (const failure of ['result', 'throw', 'timeout'] as const) {
    let beginCalls = 0;
    const provisionContexts: SandboxProvisionContext[] = [];
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
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async provision(context: SandboxProvisionContext) {
          provisionContexts.push(context);
          return CONNECTION;
        },
        async teardownSandbox() {},
      } as unknown as SandboxProvider,
    });

    let processingSettled = false;
    const processing = service
      .processDurableAdmission(buildContext({ checkpoints: [] }))
      .then((result) => {
        processingSettled = true;
        return result;
      });
    if (failure === 'timeout') {
      await waitFor(() => processingSettled);
    }
    assert.deepEqual(await processing, { kind: 'succeeded' }, failure);
    assert.equal(beginCalls, 1, failure);
    assert.equal(provisionContexts.length, 1, failure);
    assert.equal(provisionContexts[0]?.diagnostics, undefined, failure);
  }
});

test('durable late diagnostic begin success retires its detached attempt without reaching the provider', async () => {
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
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision(context: SandboxProvisionContext) {
        provisionContexts.push(context);
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });

  const processing = service.processDurableAdmission(
    buildContext({ checkpoints: [] }),
  );
  await waitFor(() => provisionContexts.length === 1);

  assert.deepEqual(await processing, { kind: 'succeeded' });
  assert.equal(provisionContexts[0]?.diagnostics, undefined);
  assert.equal(diagnostics.events.length, 0);
  assert.equal(diagnostics.primaryInputs.length, 0);

  lateBegin.resolve({ ok: true, value: begunDiagnosticContext() });
  await waitFor(() => diagnostics.trace.includes('mark_complete'));

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
  assert.deepEqual(
    diagnostics.cleanupInputs.map((input) =>
      (input as TaskProvisioningDiagnosticCleanupSummary).state,
    ),
    ['not_required'],
  );
  assert.equal(diagnostics.trace.includes('mark_complete'), true);
  assert.equal(
    diagnostics.trace.filter((step) => step === 'record_primary').length,
    1,
  );
});

test('durable launched success records primary evidence without completing cleanup while the sandbox is held', async () => {
  const trace: string[] = [];
  const diagnostics = diagnosticSettlementHarness({ trace });
  const launchGateway = gatewayWithDecision(
    Promise.resolve({ kind: 'launched' }),
  );
  const service = buildService(
    {
      ...launchGateway,
      openSession(connection, selectedRun, options) {
        trace.push('gateway');
        return launchGateway.openSession(connection, selectedRun, options);
      },
    },
    undefined,
    undefined,
    diagnostics.recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        trace.push('provider');
        return CONNECTION;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });

  const result = await service
    .processDurableAdmission(buildContext({ checkpoints: [] }))
    .then((value) => {
      trace.push('processing_result');
      return value;
    });
  assert.deepEqual(result, { kind: 'succeeded' });
  await waitFor(() => diagnostics.primaryInputs.length === 1);
  assert.deepEqual(trace, [
    'diagnostic_begin',
    'provider',
    'gateway',
    'append_started',
    'append_terminal',
    'record_primary',
    'processing_result',
  ]);
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
  );
  assert.equal(diagnostics.primaryInputs.length, 1);
  assert.equal(diagnostics.cleanupInputs.length, 0);
  assert.equal(diagnostics.trace.includes('mark_complete'), false);
});

test('durable diagnostic settlement write failure cannot change a launched success', async () => {
  const trace: string[] = [];
  const diagnostics = diagnosticSettlementHarness({
    trace,
    failAt: 'record_primary',
  });
  let gatewayCalls = 0;
  const launchGateway = gatewayWithDecision(
    Promise.resolve({ kind: 'launched' }),
  );
  const service = buildService(
    {
      ...launchGateway,
      openSession(connection, selectedRun, options) {
        gatewayCalls += 1;
        return launchGateway.openSession(connection, selectedRun, options);
      },
    },
    undefined,
    undefined,
    diagnostics.recorder,
    diagnosticWriteGate(true),
  );

  assert.deepEqual(
    await service.processDurableAdmission(buildContext({ checkpoints: [] })),
    { kind: 'succeeded' },
  );
  await waitFor(() => diagnostics.trace.includes('record_primary'));
  assert.equal(gatewayCalls, 1);
  assert.equal(trace.includes('record_primary'), true);
  assert.equal(trace.includes('record_cleanup'), false);
});

test('durable processing remains authoritative when diagnostic append or primary persistence never settles', async () => {
  for (const hungAt of ['append_started', 'record_primary'] as const) {
    const entered = deferred<void>();
    const neverSettles = new Promise<never>(() => {});
    const recorder = {
      async beginAttempt(input) {
        return {
          ok: true as const,
          value: begunDiagnosticContext(input.expectedAttempt ?? 1),
        };
      },
      async appendEvent(_context, candidate) {
        const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
        if (hungAt === 'append_started' && event.outcome === 'started') {
          entered.resolve(undefined);
          return neverSettles;
        }
        return { ok: true as const, value: { event, replayed: false } };
      },
      async recordPrimary() {
        if (hungAt === 'record_primary') {
          entered.resolve(undefined);
          return neverSettles;
        }
        assert.fail('recordPrimary cannot follow a hung append');
      },
      async recordCleanup() {
        assert.fail('a held durable sandbox cannot record cleanup at launch');
      },
      async markComplete() {
        assert.fail('a held durable sandbox cannot mark diagnostics complete');
      },
    } satisfies Pick<
      TaskProvisioningDiagnosticRecorderPort,
      | 'beginAttempt'
      | 'appendEvent'
      | 'recordPrimary'
      | 'recordCleanup'
      | 'markComplete'
    >;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      recorder as unknown as TaskProvisioningDiagnosticRecorderPort,
      diagnosticWriteGate(true),
    );

    let processingSettled = false;
    const processing = service
      .processDurableAdmission(buildContext({ checkpoints: [] }))
      .then((result) => {
        processingSettled = true;
        return result;
      });
    await entered.promise;
    await waitFor(() => processingSettled);

    assert.equal(processingSettled, true, hungAt);
    assert.deepEqual(await processing, { kind: 'succeeded' }, hungAt);
  }
});

test('durable typed provider failure records the shared partial classification and preserves its processing error', async () => {
  for (const failRecorder of [false, true]) {
    const diagnostics = diagnosticSettlementHarness({
      failAt: failRecorder ? 'record_primary' : undefined,
    });
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      diagnostics.recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async provision() {
          throw new SandboxProvisioningStageError('runtime_setup');
        },
        async teardownSandbox() {},
      } as unknown as SandboxProvider,
    });

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints: [] })),
      (error: unknown) =>
        error instanceof TaskAdmissionProcessingError &&
        error.causeCode === 'provisioning_unknown' &&
        error.stage === 'runtime_setup' &&
        error.retryable === false,
    );
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
        retryable: terminal.retryable,
      },
      {
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        commandKind: 'runtime_setup',
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
      },
    );
    assert.equal(diagnostics.primaryInputs.length, 1);
    assert.equal(diagnostics.cleanupInputs.length, 0);
    assert.equal(diagnostics.trace.includes('mark_complete'), false);
  }
});

test('durable pre-provider plan and selection failures mark complete without provisioning', async () => {
  for (const variant of ['plan', 'selection'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    let providerCalls = 0;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      diagnostics.recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      resolveProvisionPlan: async () => {
        if (variant === 'plan') {
          throw new TaskBranchResolutionError('branch_not_found');
        }
        return {
          cloneSpec: null,
          modelIntent: { kind: 'runtime-default' as const },
          runtimeId: 'codex',
          executionMode: 'interactive-pty' as const,
          resources: {},
          workspace: {
            repositoryUrl: 'https://example.test/repo.git',
            callerBranch: null,
            resolvedBranch: 'main',
            deadlineMs: 900_000,
          },
          requiredCapabilities: ['terminal.websocket'],
        };
      },
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () =>
          variant === 'selection' ? [] : ['terminal.websocket'],
        async provision() {
          providerCalls += 1;
          return CONNECTION;
        },
        async teardownSandbox() {},
      } as unknown as SandboxProvider,
    });

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints: [] })),
      (error: unknown) =>
        error instanceof TaskAdmissionProcessingError &&
        (variant === 'plan'
          ? error.causeCode === 'provisioning_ref_not_found' &&
            error.stage === 'remote_ref_resolution'
          : error.causeCode === 'provisioning_unknown'),
    );
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
    assert.equal(diagnostics.trace.includes('mark_complete'), true, variant);
  }
});

test('durable database, cleanup-coordination, and lease-loss failures without a primary do not settle diagnostics', async () => {
  for (const failure of [
    'coordination',
    'cleanup-coordination',
    'lease-lost',
  ] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const thrown =
      failure === 'coordination'
        ? new TaskAdmissionCoordinationError(
            'checkpoint',
            TASK_ID,
            new Error('database unavailable'),
          )
        : failure === 'cleanup-coordination'
          ? new SandboxCleanupCoordinationPendingError()
        : new TaskAdmissionLeaseLostError(TASK_ID);
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      diagnostics.recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async provision() {
          throw thrown;
        },
        async teardownSandbox() {},
      } as unknown as SandboxProvider,
    });

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints: [] })),
      failure === 'coordination' || failure === 'cleanup-coordination'
        ? TaskAdmissionCoordinationError
        : TaskAdmissionLeaseLostError,
    );
    assert.deepEqual(diagnostics.events, [], failure);
    assert.deepEqual(diagnostics.primaryInputs, [], failure);
    assert.deepEqual(diagnostics.cleanupInputs, [], failure);
  }
});

test('durable cleanup coordination preserves its wrapped primary diagnostic and retains coordination authority', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const primary = new SandboxProvisioningStageError('runtime_setup');
  const coordination = new SandboxCleanupCoordinationPendingError(primary);
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    diagnostics.recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        throw coordination;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });

  await assert.rejects(
    service.processDurableAdmission(buildContext({ checkpoints: [] })),
    (error: unknown) =>
      error instanceof TaskAdmissionCoordinationError &&
      error.operation === 'checkpoint' &&
      error.cause === coordination,
  );

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
      retryable: terminal.retryable,
    },
    {
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      commandKind: 'runtime_setup',
      outcome: 'failed',
      cause: 'command_failed',
      retryable: false,
    },
  );
  assert.equal(diagnostics.primaryInputs.length, 1);
  assert.deepEqual(diagnostics.cleanupInputs, []);
  assert.equal(diagnostics.trace.includes('mark_complete'), false);
  assert.equal(service.runningCount, 1);
});

test('durable cleanup coordination does not project wrapped lease or database authority as an ordinary primary', async () => {
  for (const primaryKind of ['lease-lost', 'coordination'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const primary =
      primaryKind === 'lease-lost'
        ? new TaskAdmissionLeaseLostError(TASK_ID)
        : new TaskAdmissionCoordinationError(
            'checkpoint',
            TASK_ID,
            new Error('database acknowledgement unavailable'),
          );
    const coordination = new SandboxCleanupCoordinationPendingError(primary);
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
      undefined,
      undefined,
      diagnostics.recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async provision() {
          throw coordination;
        },
        async teardownSandbox() {},
      } as unknown as SandboxProvider,
    });

    await assert.rejects(
      service.processDurableAdmission(buildContext({ checkpoints: [] })),
      (error: unknown) =>
        error instanceof TaskAdmissionCoordinationError &&
        error.operation === 'checkpoint' &&
        error.cause === coordination,
      primaryKind,
    );
    assert.deepEqual(diagnostics.events, [], primaryKind);
    assert.deepEqual(diagnostics.primaryInputs, [], primaryKind);
    assert.deepEqual(diagnostics.cleanupInputs, [], primaryKind);
    assert.equal(
      diagnostics.trace.includes('mark_complete'),
      false,
      primaryKind,
    );
    assert.equal(service.runningCount, 1, primaryKind);
  }
});

test('durable aborted signal keeps cleanup coordination authoritative without projecting its ordinary primary', async () => {
  const diagnostics = diagnosticSettlementHarness();
  const primary = new SandboxProvisioningStageError('runtime_setup');
  const coordination = new SandboxCleanupCoordinationPendingError(primary);
  const controller = new AbortController();
  controller.abort();
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    diagnostics.recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async provision() {
        throw coordination;
      },
      async teardownSandbox() {},
    } as unknown as SandboxProvider,
  });

  await assert.rejects(
    service.processDurableAdmission(
      buildContext({ checkpoints: [], signal: controller.signal }),
    ),
    (error: unknown) =>
      error instanceof TaskAdmissionCoordinationError &&
      error.operation === 'checkpoint' &&
      error.cause === coordination,
  );
  assert.deepEqual(diagnostics.events, []);
  assert.deepEqual(diagnostics.primaryInputs, []);
  assert.deepEqual(diagnostics.cleanupInputs, []);
  assert.equal(diagnostics.trace.includes('mark_complete'), false);
  assert.equal(service.runningCount, 1);
});

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
  let diagnosticBeginCalls = 0;
  const recorder = diagnosticRecorder({
    async beginAttempt() {
      diagnosticBeginCalls += 1;
      return { ok: true, value: begunDiagnosticContext() };
    },
    async appendEvent() {
      assert.fail('failed post-reservation authorization cannot emit diagnostics');
    },
  });
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'launched' })),
    undefined,
    undefined,
    recorder,
    diagnosticWriteGate(true),
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
  assert.equal(diagnosticBeginCalls, 0);
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

test('one terminal claim resumes its exact attempt and passes diagnostics to one cleanup across replays', async () => {
  const diagnostics = diagnosticSettlementHarness({
    initialPrimaryState: 'failed',
    providerFamily: 'boxlite',
  });
  const resumeInputs: unknown[] = [];
  let beginCalls = 0;
  let cleanupClaimCalls = 0;
  let teardownCalls = 0;
  let teardownOptions: unknown;
  const teardownEntered = deferred<void>();
  const releaseTeardown = deferred<void>();
  const recorder = {
    ...diagnostics.recorder,
    async beginAttempt() {
      beginCalls += 1;
      return { ok: true as const, value: begunDiagnosticContext(7) };
    },
    async resumeAttempt(
      input: Parameters<
        TaskProvisioningDiagnosticRecorderPort['resumeAttempt']
      >[0],
    ) {
      resumeInputs.push(input);
      return diagnostics.recorder.resumeAttempt(input);
    },
  } as TaskProvisioningDiagnosticRecorderPort;
  const cleanupAuthorization = {
    kind: 'generation' as const,
    taskId: TASK_ID,
    providerId: 'sandbox-test',
    ownership: {
      ownerGeneration: 'lease-token',
      resourceGeneration: 'resource-generation',
    },
  };
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    undefined,
    terminalTaskPrisma('agent_failed_to_start'),
    recorder,
    diagnosticWriteGate(true),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership() {
        cleanupClaimCalls += 1;
        return {
          kind: 'authorized' as const,
          authorization: cleanupAuthorization,
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox(_taskId: string, options: unknown) {
        teardownCalls += 1;
        teardownOptions = options;
        teardownEntered.resolve();
        await releaseTeardown.promise;
      },
      async getSandboxCleanupAuthority() {
        return retainedTerminalCleanupAuthority();
      },
    } as unknown as SandboxProvider,
  });
  const base = buildContext({ checkpoints: [] });
  const terminal: TaskAdmissionProcessorContext = {
    ...base,
    claim: {
      ...base.claim,
      attempt: 7,
      taskStatus: 'agent_failed_to_start',
      stage: 'readiness',
    },
  };

  const first = service.recoverDurableTerminalAdmission(terminal);
  await teardownEntered.promise;
  const concurrentReplay = service.recoverDurableTerminalAdmission(terminal);
  assert.equal(concurrentReplay, first);
  releaseTeardown.resolve();
  const [firstResult, concurrentResult] = await Promise.all([
    first,
    concurrentReplay,
  ]);
  assert.equal(firstResult, concurrentResult);
  const completedReplay = service.recoverDurableTerminalAdmission(terminal);
  assert.equal(completedReplay, first);
  assert.equal(await completedReplay, firstResult);

  assert.deepEqual(firstResult, {
    state: 'failed',
    stage: 'agent_launch',
    causeCode: 'provisioning_unknown',
  });
  assert.deepEqual(resumeInputs, [
    { taskId: TASK_ID, admissionMode: 'durable', attempt: 7 },
    { taskId: TASK_ID, admissionMode: 'durable', attempt: 7 },
  ]);
  assert.equal(beginCalls, 0);
  assert.equal(cleanupClaimCalls, 1);
  assert.equal(teardownCalls, 1);
  const cleanup = teardownOptions as {
    readonly cleanupAuthorization: unknown;
    readonly disposition: string;
    readonly diagnostics?: SandboxProvisionContext['diagnostics'];
  };
  assert.deepEqual(cleanup.cleanupAuthorization, cleanupAuthorization);
  assert.equal(cleanup.disposition, 'terminal-retain');
  assert.equal(cleanup.diagnostics?.mode, 'task');
  assert.deepEqual(cleanup.diagnostics?.attemptContext, {
    schemaVersion: 1,
    taskId: TASK_ID,
    attemptId: DIAGNOSTIC_ATTEMPT_ID,
    attempt: 7,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
  });
});

test('terminal cleanup remains authoritative when exact diagnostic resume is absent, throws, or times out', async () => {
  for (const behavior of ['absent', 'throw', 'timeout'] as const) {
    const diagnostics = diagnosticSettlementHarness();
    const resumeInputs: unknown[] = [];
    let beginCalls = 0;
    let teardownCalls = 0;
    let teardownOptions: unknown;
    const recorder = {
      ...diagnostics.recorder,
      async beginAttempt() {
        beginCalls += 1;
        return { ok: true as const, value: begunDiagnosticContext(5) };
      },
      async resumeAttempt(input) {
        resumeInputs.push(input);
        if (behavior === 'throw') {
          throw new Error('diagnostic resume unavailable');
        }
        if (behavior === 'timeout') {
          return new Promise<{
            readonly ok: false;
            readonly code: 'attempt_not_found';
            readonly safeCause: 'coordination_failed';
          }>((resolve) => {
            setTimeout(
              () =>
                resolve({
                  ok: false,
                  code: 'attempt_not_found',
                  safeCause: 'coordination_failed',
                }),
              CONFIG.diagnosticWriteTimeoutMs! * 3,
            );
          });
        }
        return {
          ok: false as const,
          code: 'attempt_not_found' as const,
          safeCause: 'coordination_failed' as const,
        };
      },
    } as TaskProvisioningDiagnosticRecorderPort;
    const cleanupAuthorization = {
      kind: 'generation' as const,
      taskId: TASK_ID,
      providerId: 'sandbox-test',
      ownership: {
        ownerGeneration: 'lease-token',
        resourceGeneration: 'resource-generation',
      },
    };
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
      undefined,
      terminalTaskPrisma('agent_failed_to_start'),
      recorder,
      diagnosticWriteGate(true),
    );
    Object.assign(service, {
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async claimSandboxCleanupOwnership() {
          return {
            kind: 'authorized' as const,
            authorization: cleanupAuthorization,
            authority: pendingGenerationCleanupAuthority(),
          };
        },
        async teardownSandbox(_taskId: string, options: unknown) {
          teardownCalls += 1;
          teardownOptions = options;
        },
        async getSandboxCleanupAuthority() {
          return retainedTerminalCleanupAuthority();
        },
      } as unknown as SandboxProvider,
    });
    const base = buildContext({ checkpoints: [] });
    const terminal: TaskAdmissionProcessorContext = {
      ...base,
      claim: {
        ...base.claim,
        attempt: 5,
        taskStatus: 'agent_failed_to_start',
        stage: 'readiness',
      },
    };

    assert.deepEqual(
      await service.recoverDurableTerminalAdmission(terminal),
      {
        state: 'failed',
        stage: 'agent_launch',
        causeCode: 'provisioning_unknown',
      },
      behavior,
    );
    assert.deepEqual(
      resumeInputs,
      [{ taskId: TASK_ID, admissionMode: 'durable', attempt: 5 }],
      behavior,
    );
    assert.equal(beginCalls, 0, behavior);
    assert.equal(teardownCalls, 1, behavior);
    assert.equal(
      'diagnostics' in (teardownOptions as Record<string, unknown>),
      false,
      behavior,
    );
  }
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
          kind: 'authorized' as const,
          authorization: {
            kind: 'generation' as const,
            taskId,
            providerId: 'sandbox-test',
            ownership,
          },
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox(
        taskId: string,
        options: { readonly disposition?: string },
      ) {
        events.push(`teardown:${taskId}:${options.disposition}`);
      },
      async getSandboxCleanupAuthority() {
        return succeededGenerationCleanupAuthority('removed');
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
          kind: 'authorized' as const,
          authorization: {
            kind: 'generation' as const,
            taskId,
            providerId: 'sandbox-test',
            ownership,
          },
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox(
        taskId: string,
        options: { readonly disposition?: string },
      ) {
        events.push(`teardown:${taskId}:${options.disposition}`);
      },
      async getSandboxCleanupAuthority() {
        return retainedTerminalCleanupAuthority();
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
            kind: 'authorized' as const,
            authorization: {
              kind: 'generation' as const,
              taskId,
              providerId: 'sandbox-test',
              ownership,
            },
            authority: pendingGenerationCleanupAuthority(),
          };
        },
        async teardownSandbox() {
          throw new Error('provider cleanup remains pending');
        },
        async getSandboxCleanupAuthority() {
          return pendingGenerationCleanupAuthority();
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

test('configured terminal policy atomically fails an exhausted physical cleanup before releasing its slot', async () => {
  const ownership = {
    ownerGeneration: 'lease-token',
    resourceGeneration: 'resource-generation',
  };
  const authorization = {
    kind: 'generation' as const,
    taskId: TASK_ID,
    providerId: 'sandbox-test',
    ownership,
  };
  let policyCalls = 0;
  const promoted: string[] = [];
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
  );
  Object.assign(service, {
    cleanupTerminalPolicyMaxAttempts: 2,
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership() {
        return {
          kind: 'authorized' as const,
          authorization,
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox() {
        throw new SandboxCleanupPendingError();
      },
      async getSandboxCleanupAuthority() {
        return pendingGenerationCleanupAuthority({
          attemptCount: 2,
          lastAttemptOutcome: 'failed',
          lastAttemptCause: 'cleanup_failed',
          lastAttemptRetryable: false,
          lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
        });
      },
      async failSandboxCleanupByTerminalPolicy(
        receivedAuthorization: unknown,
        expectedAttempt: number,
      ) {
        policyCalls += 1;
        assert.deepEqual(receivedAuthorization, authorization);
        assert.equal(expectedAttempt, 2);
        return failedGenerationCleanupAuthority();
      },
    } as unknown as SandboxProvider,
    onAdmit: async (taskId: string) => promoted.push(taskId),
  });
  const semaphore = (
    service as unknown as {
      semaphore: { offer(taskId: string): 'running' | 'queued' };
    }
  ).semaphore;
  service.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await service.onDurableAdmissionTerminal(TASK_ID, 'lease-token');

  assert.equal(policyCalls, 1);
  assert.deepEqual(promoted, ['legacy-waiter']);
});

test('coordination uncertainty and pre-threshold physical pending never invoke terminal policy or release', async () => {
  for (const scenario of ['coordination', 'below-threshold'] as const) {
    const ownership = {
      ownerGeneration: 'lease-token',
      resourceGeneration: 'resource-generation',
    };
    let authorityReads = 0;
    let policyCalls = 0;
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    );
    Object.assign(service, {
      cleanupTerminalPolicyMaxAttempts: 2,
      sandbox: {
        getSandboxMode: () => 'workspace-write',
        getProviderCapabilities: () => ['terminal.websocket'],
        async claimSandboxCleanupOwnership() {
          return {
            kind: 'authorized' as const,
            authorization: {
              kind: 'generation' as const,
              taskId: TASK_ID,
              providerId: 'sandbox-test',
              ownership,
            },
            authority: pendingGenerationCleanupAuthority(),
          };
        },
        async teardownSandbox() {
          if (scenario === 'coordination') {
            throw new SandboxCleanupCoordinationPendingError();
          }
          throw new SandboxCleanupPendingError();
        },
        async getSandboxCleanupAuthority() {
          authorityReads += 1;
          return pendingGenerationCleanupAuthority({
            attemptCount: 1,
            lastAttemptOutcome: 'indeterminate',
            lastAttemptCause: 'cleanup_unconfirmed',
            lastAttemptRetryable: true,
            lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
          });
        },
        async failSandboxCleanupByTerminalPolicy() {
          policyCalls += 1;
          return failedGenerationCleanupAuthority();
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
      service.onDurableAdmissionTerminal(TASK_ID, 'lease-token'),
      scenario === 'coordination'
        ? SandboxCleanupCoordinationPendingError
        : SandboxCleanupPendingError,
    );
    assert.equal(authorityReads, scenario === 'coordination' ? 0 : 1, scenario);
    assert.equal(policyCalls, 0, scenario);
    assert.equal(semaphore.runningCount, 1, scenario);
    assert.equal(semaphore.queuedCount, 1, scenario);
  }
});

test('terminal-policy coordination failures preserve pending diagnostic evidence and retain the slot', async () => {
  for (const scenario of ['missing', 'rejecting'] as const) {
    const observedAt = new Date('2026-07-18T00:00:00.000Z');
    const cleanupSettlements: unknown[] = [];
    const provider = {
      getSandboxMode: () => 'workspace-write' as const,
      getProviderCapabilities: () => ['terminal.websocket'] as const,
      async claimSandboxCleanupOwnership() {
        return {
          kind: 'authorized' as const,
          authorization: {
            kind: 'generation' as const,
            taskId: TASK_ID,
            providerId: 'sandbox-test',
            ownership: {
              ownerGeneration: 'lease-token',
              resourceGeneration: 'resource-generation',
            },
          },
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox() {
        throw new SandboxCleanupPendingError();
      },
      async getSandboxCleanupAuthority() {
        return pendingGenerationCleanupAuthority({
          attemptCount: 2,
          lastAttemptOutcome: 'failed',
          lastAttemptCause: 'cleanup_failed',
          lastAttemptRetryable: false,
          lastAttemptObservedAt: observedAt,
        });
      },
    };
    if (scenario === 'rejecting') {
      Object.assign(provider, {
        async failSandboxCleanupByTerminalPolicy() {
          throw new SandboxCleanupCoordinationPendingError();
        },
      });
    }
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
    );
    Object.assign(service, {
      cleanupTerminalPolicyMaxAttempts: 2,
      sandbox: provider as unknown as SandboxProvider,
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
        diagnosticSettlement: {
          async settlePrimary() {},
          async settleCleanup(summary) {
            cleanupSettlements.push(summary);
          },
        },
      }),
      scenario === 'missing'
        ? /terminal policy is unavailable/
        : SandboxCleanupCoordinationPendingError,
    );

    assert.deepEqual(
      cleanupSettlements,
      [
        {
          state: 'pending',
          cause: 'cleanup_failed',
          attemptCount: 2,
          lastAttemptOutcome: 'failed',
          observedAt,
        },
      ],
      scenario,
    );
    assert.equal(semaphore.runningCount, 1, scenario);
    assert.equal(semaphore.queuedCount, 1, scenario);
  }
});

test('a stalled pending cleanup diagnostic is bounded without releasing its slot', async () => {
  let cleanupSettlementCalls = 0;
  const neverSettles = new Promise<void>(() => {});
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
  );
  Object.assign(service, {
    cleanupTerminalPolicyMaxAttempts: 2,
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership() {
        return {
          kind: 'authorized' as const,
          authorization: {
            kind: 'generation' as const,
            taskId: TASK_ID,
            providerId: 'sandbox-test',
            ownership: {
              ownerGeneration: 'lease-token',
              resourceGeneration: 'resource-generation',
            },
          },
          authority: pendingGenerationCleanupAuthority(),
        };
      },
      async teardownSandbox() {
        throw new SandboxCleanupPendingError();
      },
      async getSandboxCleanupAuthority() {
        return pendingGenerationCleanupAuthority({
          attemptCount: 1,
          lastAttemptOutcome: 'indeterminate',
          lastAttemptCause: 'cleanup_unconfirmed',
          lastAttemptRetryable: true,
          lastAttemptObservedAt: new Date('2026-07-18T00:00:00.000Z'),
        });
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
    Promise.race([
      service.onDurableAdmissionTerminal(TASK_ID, 'lease-token', {
        diagnosticSettlement: {
          async settlePrimary() {},
          async settleCleanup() {
            cleanupSettlementCalls += 1;
            return neverSettles;
          },
        },
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('pending diagnostic write was not bounded')),
          CONFIG.diagnosticWriteTimeoutMs! * 5,
        ),
      ),
    ]),
    SandboxCleanupPendingError,
  );

  assert.equal(cleanupSettlementCalls, 1);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);
});

test('a stalled cleanup diagnostic cannot permanently block an already-settled authority release', async () => {
  const promoted: string[] = [];
  let teardownCalls = 0;
  let cleanupSettlementCalls = 0;
  const neverSettles = new Promise<void>(() => {});
  const service = buildService(
    gatewayWithDecision(Promise.resolve({ kind: 'attached' })),
  );
  Object.assign(service, {
    sandbox: {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket'],
      async claimSandboxCleanupOwnership() {
        return {
          kind: 'settled' as const,
          authority: succeededGenerationCleanupAuthority('removed'),
        };
      },
      async teardownSandbox() {
        teardownCalls += 1;
      },
    } as unknown as SandboxProvider,
    onAdmit: async (taskId: string) => promoted.push(taskId),
  });
  const semaphore = (
    service as unknown as {
      semaphore: { offer(taskId: string): 'running' | 'queued' };
    }
  ).semaphore;
  service.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await Promise.race([
    service.onDurableAdmissionTerminal(TASK_ID, 'lease-token', {
      diagnosticSettlement: {
        async settlePrimary() {},
        async settleCleanup() {
          cleanupSettlementCalls += 1;
          return neverSettles;
        },
      },
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('diagnostic timeout blocked authority release')),
        CONFIG.diagnosticWriteTimeoutMs! * 5,
      ),
    ),
  ]);

  assert.equal(cleanupSettlementCalls, 1);
  assert.equal(teardownCalls, 0);
  assert.deepEqual(promoted, ['legacy-waiter']);
});

test('only ownerless or already-settled succeeded work uses ordinary terminal release', async () => {
  const cases = [
    {
      name: 'no durable work',
      work: null,
      authority: undefined,
      expectedEvents: [
        `teardown:${TASK_ID}:terminal-retain`,
        'promote:legacy-waiter',
      ],
      expectedQueued: 0,
    },
    {
      name: 'succeeded work with removed generation owner',
      work: { state: 'succeeded' },
      authority: succeededGenerationCleanupAuthority('removed'),
      expectedEvents: ['promote:legacy-waiter'],
      expectedQueued: 0,
    },
    {
      name: 'succeeded work with no remaining owner',
      work: { state: 'succeeded' },
      authority: absentCleanupAuthority(),
      expectedEvents: [
        `teardown:${TASK_ID}:terminal-retain`,
        'promote:legacy-waiter',
      ],
      expectedQueued: 0,
    },
    {
      name: 'succeeded work with live generation owner',
      work: { state: 'succeeded' },
      authority: pendingGenerationCleanupAuthority(),
      expectedEvents: [],
      expectedQueued: 1,
    },
    {
      name: 'succeeded work without cleanup authority reader',
      work: { state: 'succeeded' },
      authority: undefined,
      expectedEvents: [],
      expectedQueued: 1,
    },
  ] as const;
  for (const scenario of cases) {
    const events: string[] = [];
    const prisma = {
      taskAdmissionWork: {
        async findUnique() {
          return scenario.work;
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
        ...(scenario.authority === undefined
          ? {}
          : {
              async getSandboxCleanupAuthority() {
                return scenario.authority;
              },
            }),
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
    assert.deepEqual(events, scenario.expectedEvents, scenario.name);
    assert.equal(semaphore.queuedCount, scenario.expectedQueued, scenario.name);
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
    const diagnostics = diagnosticSettlementHarness();
    const service = buildService(
      gatewayWithDecision(Promise.resolve({ kind: outcome })),
      undefined,
      undefined,
      diagnostics.recorder,
      diagnosticWriteGate(true),
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
    if (outcome === 'fenced') {
      assert.deepEqual(diagnostics.events, []);
      assert.deepEqual(diagnostics.primaryInputs, []);
    } else {
      await waitFor(() => diagnostics.primaryInputs.length === 1);
      const terminal = diagnostics.events.find(
        (event) => event.outcome !== 'started',
      );
      assert.equal(terminal?.stage, 'agent_launch');
      assert.equal(terminal?.operation, 'agent_launch');
      assert.equal(terminal?.outcome, 'failed');
      assert.equal(terminal?.cause, 'unknown');
      assert.deepEqual(diagnostics.cleanupInputs, []);
      assert.equal(diagnostics.trace.includes('mark_complete'), false);
    }
  });
}
