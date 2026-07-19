import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticCleanupSummary,
} from '@cap/contracts';
import {
  InMemorySandboxRunOwnerStore,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
  type FailSandboxRunCleanupByTerminalPolicyResult,
  type SandboxCleanupAttemptEvidence,
  type SandboxPhysicalCleanupResult,
  type SandboxProvisionContext,
  type SandboxRunCleanupAuthorization,
  type SettleSandboxCleanupAttemptResult,
} from '@cap/sandbox';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  GuardrailsService,
  type GuardrailsConfig,
} from '../guardrails/guardrails.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ProvisionLookup } from '../sandbox/provision-lookup.port';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { FencedTaskAdmissionProcessor } from '../task-admission/fenced-task-admission.processor';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
} from '../task-admission/task-admission-runtime';
import {
  TaskAdmissionCoordinationError,
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionSettlement,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import type { TaskProvisioningDiagnosticRecorderPort } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { TasksService } from './tasks.service';

const TASK_ID = '8cdb5ef4-d021-4a62-81da-45285c8ea190';
const WAITING_TASK_ID = '96d1b60c-0c7c-4ef8-9b6e-e664f8c72ef7';
const DIAGNOSTIC_ATTEMPT_ID = '01c86adb-1439-4cb8-b15f-bc2035c5e00c';
const DIAGNOSTIC_OBSERVED_AT = new Date('2026-07-18T06:00:00.000Z');
const RESOURCE_GENERATION = 'resource:coordination-cleanup-story';
const GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 20,
  // If acknowledgement uncertainty were mistaken for a physical failure, one
  // allocated attempt would immediately terminalize and release this owner.
  cleanupTerminalPolicyMaxAttempts: 1,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class StoryClock extends TaskAdmissionClock {
  private currentMs = 0;

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

class StoryScheduler extends TaskAdmissionScheduler {
  schedule(_delayMs: number, _callback: () => void): TaskAdmissionTimer {
    return { cancel() {} };
  }
}

class StoryLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `lease:coordination-cleanup:${this.sequence}`;
  }
}

/** Public Guardrails admission collaborator for the one queued legacy waiter. */
class WaitingTaskLifecycle {
  private status: 'pending' | 'queued' | 'running' = 'pending';
  private transitionToken: string | null = null;
  readonly transitions: Array<'queued' | 'running'> = [];
  readonly promoted = deferred<void>();

  async transitionForAdmission(
    taskId: string,
    next: 'queued' | 'running',
    _userId: string | undefined,
    transitionToken: string,
  ): Promise<'transitioned'> {
    assert.equal(taskId, WAITING_TASK_ID);
    assert.equal(
      this.status,
      next === 'queued' ? 'pending' : 'queued',
      `unexpected ${this.status} -> ${next} admission transition`,
    );
    this.status = next;
    this.transitionToken = transitionToken;
    this.transitions.push(next);
    if (next === 'running') this.promoted.resolve();
    return 'transitioned';
  }

  async isAdmissionTransitionCurrent(
    taskId: string,
    next: 'queued' | 'running',
    transitionToken: string,
  ): Promise<boolean> {
    return (
      taskId === WAITING_TASK_ID &&
      this.status === next &&
      this.transitionToken === transitionToken
    );
  }
}

/**
 * Minimal durable-work authority for a terminal Task whose successful launch
 * row is reclaimed only for cleanup. Lease expiry, not process state, makes the
 * first coordination-uncertain claim recoverable.
 */
class TerminalCleanupWorkStore extends TaskAdmissionStore {
  state: 'succeeded' | 'running' | 'cancelled' = 'succeeded';
  readonly attempt = 4;
  leaseToken: string | null = null;
  leaseUntil: Date | null = null;
  readonly settlements: TaskAdmissionSettlement[] = [];

  constructor(private readonly clock: StoryClock) {
    super();
  }

  async claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null> {
    const expired =
      this.state === 'running' &&
      this.leaseUntil !== null &&
      this.leaseUntil.getTime() <= this.clock.now().getTime();
    if (this.state !== 'succeeded' && !expired) return null;

    const sourceState = this.state === 'succeeded' ? 'succeeded' : 'running';
    this.state = 'running';
    this.leaseToken = request.leaseToken;
    this.leaseUntil = new Date(
      this.clock.now().getTime() + request.leaseDurationMs,
    );
    return {
      taskId: TASK_ID,
      leaseToken: request.leaseToken,
      leaseUntil: this.leaseUntil,
      sourceState,
      attempt: this.attempt,
      stage: 'complete',
      causeCode: null,
      resolvedBranch: 'main',
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'cancelled',
      taskLifecycleVersion: 11,
    };
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.isAuthorized(request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!this.isAuthorized(request)) return false;
    this.leaseUntil = new Date(
      this.clock.now().getTime() + request.leaseDurationMs,
    );
    return true;
  }

  async checkpoint(
    request: TaskAdmissionCheckpointRequest,
  ): Promise<boolean> {
    return this.isAuthorized(request);
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!this.isAuthorized(request)) return false;
    this.settlements.push(request.settlement);
    this.state = 'cancelled';
    this.leaseToken = null;
    this.leaseUntil = null;
    return true;
  }

  private isAuthorized(request: TaskAdmissionAuthorityRequest): boolean {
    return (
      request.taskId === TASK_ID &&
      this.state === 'running' &&
      this.leaseToken === request.leaseToken &&
      this.leaseUntil !== null &&
      this.leaseUntil.getTime() > this.clock.now().getTime() &&
      request.taskFences.some(
        (fence) =>
          fence.status === 'cancelled' && fence.lifecycleVersion === 11,
      )
    );
  }
}

function waitingTaskProvisionLookup(): ProvisionLookup {
  const assertWaitingTask = (taskId: string): void => {
    assert.equal(taskId, WAITING_TASK_ID);
  };
  return {
    async getTaskLaunchContext(taskId) {
      assertWaitingTask(taskId);
      return {
        modelIntent: { kind: 'runtime-default' as const },
        ownerUserId: null,
        runtimeId: 'codex' as const,
        executionMode: 'interactive-pty' as const,
        resources: {},
        workspaceMaterializationDeadlineMs: 900_000,
      };
    },
    async getCloneSpec(taskId) {
      assertWaitingTask(taskId);
      return null;
    },
    async getTaskPrompt(taskId) {
      assertWaitingTask(taskId);
      return 'promoted cleanup-coordination waiter';
    },
    async getTaskSkills(taskId) {
      assertWaitingTask(taskId);
      return [];
    },
    async getTaskRuntime(taskId) {
      assertWaitingTask(taskId);
      return 'codex';
    },
    async getTaskExecutionMode(taskId) {
      assertWaitingTask(taskId);
      return 'interactive-pty';
    },
  };
}

/**
 * The first physical result cannot be acknowledged. The wrapped real store has
 * already allocated the exact attempt, so recovery must take over that same
 * resource generation instead of treating the provider success as authority.
 */
class OneShotCleanupAcknowledgementFailureStore extends InMemorySandboxRunOwnerStore {
  settlementAcknowledgementCalls = 0;
  terminalPolicyCalls = 0;
  completionCalls = 0;
  private rejectNextSettlementAcknowledgement = true;

  override async settleSandboxRunCleanupAttempt(
    authorization: SandboxRunCleanupAuthorization,
    evidence: SandboxCleanupAttemptEvidence,
  ): Promise<SettleSandboxCleanupAttemptResult> {
    this.settlementAcknowledgementCalls += 1;
    if (this.rejectNextSettlementAcknowledgement) {
      this.rejectNextSettlementAcknowledgement = false;
      throw new Error('owner-store cleanup acknowledgement unavailable');
    }
    return super.settleSandboxRunCleanupAttempt(authorization, evidence);
  }

  override async failSandboxRunCleanupByTerminalPolicy(
    authorization: Extract<
      SandboxRunCleanupAuthorization,
      { readonly kind: 'generation' }
    >,
    expectedAttempt: number,
  ): Promise<FailSandboxRunCleanupByTerminalPolicyResult> {
    this.terminalPolicyCalls += 1;
    return super.failSandboxRunCleanupByTerminalPolicy(
      authorization,
      expectedAttempt,
    );
  }

  override async completeSandboxRunCleanup(
    authorization: SandboxRunCleanupAuthorization,
    status: 'removed' | 'terminal',
  ): Promise<boolean> {
    this.completionCalls += 1;
    return super.completeSandboxRunCleanup(authorization, status);
  }
}

function diagnosticHarness() {
  let cleanup: TaskProvisioningDiagnosticCleanupSummary = {
    state: 'not_required',
    cause: null,
    attemptCount: 0,
    lastAttemptOutcome: null,
    observedAt: null,
  };
  let completionMarkedAt: Date | null = null;
  let beginCalls = 0;
  let resumeCalls = 0;
  let appendCalls = 0;
  let primaryCalls = 0;
  let partialCalls = 0;
  const cleanupRows: TaskProvisioningDiagnosticCleanupSummary[] = [];

  const attempt = () =>
    TaskProvisioningDiagnosticAttemptSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      id: DIAGNOSTIC_ATTEMPT_ID,
      taskId: TASK_ID,
      attempt: 4,
      admissionMode: 'durable',
      providerFamily: 'aio',
      state: 'succeeded',
      stage: 'agent_launch',
      coverage: completionMarkedAt ? 'complete' : 'partial',
      primary: {
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        exitCode: 0,
        observedAt: DIAGNOSTIC_OBSERVED_AT,
      },
      cleanup,
      eventCount: 0,
      truncated: false,
      startedAt: new Date(DIAGNOSTIC_OBSERVED_AT.getTime() - 1_000),
      finishedAt: DIAGNOSTIC_OBSERVED_AT,
      completenessMarkedAt: completionMarkedAt,
    });

  const recorder = {
    async beginAttempt() {
      beginCalls += 1;
      return {
        ok: false as const,
        code: 'attempt_number_conflict' as const,
        safeCause: 'coordination_failed' as const,
      };
    },
    async resumeAttempt(input) {
      assert.deepEqual(input, {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 4,
      });
      resumeCalls += 1;
      return {
        ok: true as const,
        value: {
          context: {
            taskId: TASK_ID,
            attemptId: DIAGNOSTIC_ATTEMPT_ID,
            attempt: 4,
            admissionMode: 'durable' as const,
          },
          state: 'succeeded' as const,
          providerFamily: 'aio' as const,
          initialSequence: 0,
          primaryPersisted: true,
          cleanup,
        },
      };
    },
    async appendEvent(_context, event) {
      appendCalls += 1;
      return {
        ok: true as const,
        value: {
          event: TaskProvisioningDiagnosticEventSchema.parse(event),
          replayed: false,
        },
      };
    },
    async recordPrimary() {
      primaryCalls += 1;
      return { ok: true as const, value: attempt() };
    },
    async recordCleanup(_context, nextCleanup) {
      cleanup = nextCleanup;
      cleanupRows.push(nextCleanup);
      return { ok: true as const, value: attempt() };
    },
    async markComplete() {
      completionMarkedAt = new Date();
      return { ok: true as const, value: attempt() };
    },
    async upsertPartialAttempt() {
      partialCalls += 1;
      return { ok: true as const, value: attempt() };
    },
  } satisfies TaskProvisioningDiagnosticRecorderPort;

  return {
    recorder,
    cleanupRows,
    currentAttempt: attempt,
    stats() {
      return {
        beginCalls,
        resumeCalls,
        appendCalls,
        primaryCalls,
        partialCalls,
        completionMarked: completionMarkedAt !== null,
      };
    },
  };
}

test('owner-store acknowledgement uncertainty retains the exact durable cleanup until coordination recovers', async () => {
  const clock = new StoryClock();
  const workStore = new TerminalCleanupWorkStore(clock);
  const ownerStore = new OneShotCleanupAcknowledgementFailureStore();
  const diagnostics = diagnosticHarness();
  const cleanupAuthorizations: Array<{
    readonly ownerGeneration: string;
    readonly resourceGeneration: string;
  }> = [];
  const destroyedSessions: string[] = [];
  const cancellationAuditRows = new Set<string>();
  const physicalSandboxes = new Set<string>();
  const provisionedTaskIds: string[] = [];
  const waiterProvisioned = deferred<void>();
  let physicalCleanupCalls = 0;

  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: SandboxProvisionContext) {
      provisionedTaskIds.push(ctx.taskId);
      await ctx.externalBoundaryGuard?.({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      physicalSandboxes.add(ctx.taskId);
      await ctx.onSandboxCreateObserved?.({
        kind: 'created',
        providerSandboxId: `physical:${ctx.taskId}`,
      });
      if (ctx.taskId === WAITING_TASK_ID) waiterProvisioned.resolve();
      return {
        taskId: ctx.taskId,
        providerId: 'local',
        containerName: `physical:${ctx.taskId}`,
        wsUrl: `ws://sandbox.test/${ctx.taskId}`,
      };
    },
    async teardownSandbox(
      taskId: string,
      options: {
        readonly cleanupAuthorization?: SandboxRunCleanupAuthorization;
      },
    ): Promise<SandboxPhysicalCleanupResult> {
      physicalCleanupCalls += 1;
      const authorization = options.cleanupAuthorization;
      assert.equal(authorization?.kind, 'generation');
      if (authorization?.kind === 'generation') {
        cleanupAuthorizations.push(authorization.ownership);
      }
      const proof = physicalSandboxes.delete(taskId)
        ? ('found-and-cleaned' as const)
        : ('already-absent' as const);
      return {
        outcome: 'succeeded',
        proof,
        cause: null,
        retryable: false,
      };
    },
  };
  const router = new SandboxProviderRouter(
    [
      defineLocalSandboxProvider({
        id: 'local',
        provider: provider as never,
        capabilities: ['terminal.websocket'],
      }),
    ],
    { ownerStore },
  );
  await router.provision({
    taskId: TASK_ID,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    cloneSpec: null,
    resources: {},
    workspace: null,
    ownership: {
      ownerGeneration: 'lease:successful-provisioning',
      resourceGeneration: RESOURCE_GENERATION,
    },
  });
  assert.equal(physicalSandboxes.has(TASK_ID), true);

  const prisma = {
    task: {
      async findUnique() {
        return {
          status: 'cancelled',
          lifecycleVersion: 11,
          failureCode: null,
        };
      },
    },
    taskAdmissionWork: {
      async findUnique() {
        return { state: workStore.state };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTaskCancellation(taskId: string) {
      cancellationAuditRows.add(`task.cancelled:${taskId}`);
      return true;
    },
  } as unknown as AuditRecorderPort;
  const waitingTaskLifecycle = new WaitingTaskLifecycle();
  const moduleRef = {
    get(token: unknown) {
      if (token === TasksService) return waitingTaskLifecycle;
      throw new Error('optional story dependency is not bound');
    },
  } as unknown as ModuleRef;
  const guardrails = new GuardrailsService(
    moduleRef,
    {
      destroyForSession(taskId: string) {
        destroyedSessions.push(taskId);
      },
    } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    GUARDRAILS_CONFIG,
    waitingTaskProvisionLookup(),
    audit,
    prisma,
    undefined,
    diagnostics.recorder,
    { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
  );
  guardrails.onModuleInit();
  guardrails.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(await guardrails.admit(WAITING_TASK_ID), 'queued');
  assert.deepEqual(guardrails.semaphoreProjection().snapshotRunning(), [TASK_ID]);
  assert.deepEqual(guardrails.semaphoreProjection().snapshotQueue(), [
    WAITING_TASK_ID,
  ]);

  // The ordinary terminal path must not race the succeeded durable work row.
  await guardrails.onTerminal(TASK_ID);
  assert.equal(physicalCleanupCalls, 0);
  assert.equal(guardrails.runningCount, 1);
  assert.equal(guardrails.queuedCount, 1);

  const processor = new FencedTaskAdmissionProcessor({
    get(token: unknown) {
      assert.equal(token, GuardrailsService);
      return guardrails;
    },
  } as unknown as ModuleRef);
  const worker = new TaskAdmissionWorker(
    workStore,
    processor,
    new StoryScheduler(),
    clock,
    new StoryLeaseTokens(),
    {
      ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
      leaseDurationMs: 100,
      renewIntervalMs: 25,
      maxInFlight: 1,
    },
  );

  await assert.rejects(worker.runOnce(), TaskAdmissionCoordinationError);
  assert.equal(workStore.state, 'running');
  assert.equal(workStore.leaseToken, 'lease:coordination-cleanup:1');
  assert.deepEqual(workStore.settlements, []);
  assert.equal(physicalSandboxes.has(TASK_ID), false);
  assert.equal(physicalCleanupCalls, 1);
  assert.equal(ownerStore.settlementAcknowledgementCalls, 1);
  assert.equal(ownerStore.terminalPolicyCalls, 0);
  assert.equal(ownerStore.completionCalls, 0);
  const pendingAuthority = await router.getSandboxCleanupAuthority(TASK_ID);
  assert.equal(pendingAuthority.status, 'deleting');
  assert.equal(pendingAuthority.state, 'pending');
  assert.equal(pendingAuthority.attemptCount, 1);
  assert.equal(pendingAuthority.lastAttemptOutcome, 'indeterminate');
  assert.equal(guardrails.runningCount, 1);
  assert.equal(guardrails.queuedCount, 1);
  assert.deepEqual(waitingTaskLifecycle.transitions, ['queued']);
  assert.deepEqual(destroyedSessions, []);
  assert.equal(
    diagnostics.cleanupRows.length,
    0,
    'coordination uncertainty is not an ordinary physical pending/failed fact',
  );
  assert.deepEqual(diagnostics.stats(), {
    beginCalls: 0,
    resumeCalls: 1,
    appendCalls: 0,
    primaryCalls: 0,
    partialCalls: 0,
    completionMarked: false,
  });
  assert.equal(diagnostics.currentAttempt().primary?.outcome, 'succeeded');

  clock.advance(101);
  assert.deepEqual(await worker.runOnce(), {
    kind: 'cancelled',
    taskId: TASK_ID,
    attempt: 4,
  });
  assert.equal(workStore.state, 'cancelled');
  assert.deepEqual(workStore.settlements, [
    { state: 'cancelled', stage: 'complete' },
  ]);
  assert.equal(physicalCleanupCalls, 2);
  assert.equal(ownerStore.settlementAcknowledgementCalls, 2);
  assert.equal(ownerStore.terminalPolicyCalls, 0);
  assert.equal(ownerStore.completionCalls, 1);
  assert.equal((await router.getSandboxCleanupAuthority(TASK_ID)).status, 'removed');
  assert.deepEqual(cleanupAuthorizations, [
    {
      ownerGeneration: 'lease:coordination-cleanup:1',
      resourceGeneration: RESOURCE_GENERATION,
    },
    {
      ownerGeneration: 'lease:coordination-cleanup:2',
      resourceGeneration: RESOURCE_GENERATION,
    },
  ]);
  await within(
    waitingTaskLifecycle.promoted.promise,
    1_000,
    'queued waiter lifecycle promotion',
  );
  await within(waiterProvisioned.promise, 1_000, 'queued waiter provisioning');
  assert.equal(guardrails.runningCount, 1, 'the promoted waiter owns the slot');
  assert.equal(guardrails.queuedCount, 0);
  assert.deepEqual(waitingTaskLifecycle.transitions, ['queued', 'running']);
  assert.deepEqual(guardrails.semaphoreProjection().snapshotRunning(), [
    WAITING_TASK_ID,
  ]);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
  assert.deepEqual(
    diagnostics.cleanupRows.map((row) => row.state),
    ['succeeded'],
  );
  assert.equal(diagnostics.currentAttempt().primary?.outcome, 'succeeded');
  assert.equal(diagnostics.currentAttempt().coverage, 'complete');
  assert.equal(cancellationAuditRows.size, 1);

  assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
  assert.equal(
    provisionedTaskIds.filter((taskId) => taskId === TASK_ID).length,
    1,
    'terminal cleanup recovery never reprovisions its own task',
  );
  assert.equal(
    provisionedTaskIds.filter((taskId) => taskId === WAITING_TASK_ID).length,
    1,
    'slot release drives the real queued waiter provisioning path once',
  );
  assert.equal(physicalCleanupCalls, 2);
  assert.equal(ownerStore.completionCalls, 1);
  assert.deepEqual(waitingTaskLifecycle.transitions, ['queued', 'running']);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
  assert.deepEqual(diagnostics.stats(), {
    beginCalls: 1,
    resumeCalls: 3,
    appendCalls: 0,
    primaryCalls: 0,
    partialCalls: 0,
    completionMarked: true,
  });
});
