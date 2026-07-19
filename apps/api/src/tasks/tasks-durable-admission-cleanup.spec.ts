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
  type SandboxPhysicalCleanupResult,
} from '@cap/sandbox';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import { AuditService } from '../audit/audit.service';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  GuardrailsService,
  type GuardrailsConfig,
} from '../guardrails/guardrails.service';
import type { PrismaService } from '../prisma/prisma.service';
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
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionSettlement,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import type { TaskProvisioningDiagnosticRecorderPort } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { deriveTaskDiagnosticCoverage } from '../task-provisioning-diagnostics/task-provisioning-diagnostics.projection';
import type { IGuardrailsService } from './tasks.service';
import { TasksService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = 'lease:terminal-cleanup';
const DIAGNOSTIC_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const DIAGNOSTIC_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const DIAGNOSTIC_OBSERVED_AT = new Date('2026-07-18T04:00:00.000Z');
const GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolvePromise = settle;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise(value as T);
    },
  };
}

class TerminalFixture {
  task = {
    status: 'running',
    lifecycleVersion: 7,
    failureCode: null as string | null,
    failureAt: null as Date | null,
  };
  work = {
    state: 'running',
    stage: 'runtime_setup',
    causeCode: null as string | null,
    leaseOwner: LEASE as string | null,
    leaseValid: true,
  };
  readonly events: string[] = [];

  prisma(): PrismaService {
    const taskRow = this.task;
    const workRow = this.work;
    const events = this.events;
    const tx = {
      async $queryRaw() {
        return taskRow.status === 'running' &&
          taskRow.lifecycleVersion === 7 &&
          workRow.state === 'running' &&
          workRow.leaseOwner === LEASE &&
          workRow.leaseValid
          ? [{ status: 'running', lifecycleVersion: 7 }]
          : [];
      },
      task: {
        async updateMany({
          data,
        }: {
          data: {
            failureCode: string;
            failureAt: Date;
          };
        }) {
          if (
            taskRow.status !== 'running' ||
            taskRow.lifecycleVersion !== 7
          ) {
            return { count: 0 };
          }
          events.push('task:failed');
          taskRow.status = 'failed';
          taskRow.lifecycleVersion = 8;
          taskRow.failureCode = data.failureCode;
          taskRow.failureAt = data.failureAt;
          return { count: 1 };
        },
      },
      async $executeRaw() {
        if (
          workRow.state !== 'running' ||
          workRow.leaseOwner !== LEASE ||
          !workRow.leaseValid
        ) {
          return 0;
        }
        events.push('work:cause-persisted');
        workRow.stage = 'runtime_setup';
        workRow.causeCode = 'provisioning_unknown';
        return 1;
      },
    };
    return {
      async $transaction<T>(operation: (client: typeof tx) => Promise<T>) {
        return operation(tx);
      },
      async $executeRaw() {
        if (
          workRow.state !== 'running' ||
          workRow.leaseOwner !== LEASE ||
          !workRow.leaseValid ||
          workRow.causeCode !== 'provisioning_unknown' ||
          taskRow.status !== 'failed' ||
          taskRow.lifecycleVersion !== 8
        ) {
          return 0;
        }
        events.push('work:failed');
        workRow.state = 'failed';
        workRow.leaseOwner = null;
        workRow.leaseValid = false;
        return 1;
      },
      task: {
        async findUnique() {
          return taskRow;
        },
      },
      taskAdmissionWork: {
        async findUnique() {
          return workRow;
        },
      },
    } as unknown as PrismaService;
  }
}

function request() {
  return {
    taskId: TASK_ID,
    leaseToken: LEASE,
    attempt: 1,
    expectedStatus: 'running' as const,
    expectedLifecycleVersion: 7,
    stage: 'runtime_setup' as const,
    causeCode: 'provisioning_unknown' as const,
  };
}

function successfulTerminalAudit(): AuditRecorderPort {
  return {
    async recordProvisioningFailure() {
      return true;
    },
  } as unknown as AuditRecorderPort;
}

function failedTerminalSnapshotPrisma(): PrismaService {
  return {
    task: {
      async findUnique() {
        return {
          status: 'failed',
          lifecycleVersion: 8,
          failureCode: 'provisioning_unknown',
        };
      },
    },
  } as unknown as PrismaService;
}

class TerminalCleanupStoryClock extends TaskAdmissionClock {
  private currentMs = 0;

  now(): Date {
    return new Date(this.currentMs);
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

class TerminalCleanupStoryScheduler extends TaskAdmissionScheduler {
  schedule(_delayMs: number, _callback: () => void): TaskAdmissionTimer {
    return { cancel() {} };
  }
}

class TerminalCleanupStoryLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `lease:terminal-recovery:${this.sequence}`;
  }
}

/**
 * Narrow in-memory authority used only to join the real worker, processor,
 * Guardrails and provider router in one cleanup-recovery story. It models the
 * same terminal reclaim invariant as the Prisma store: terminal work preserves
 * its successful provisioning attempt and is claimable again only after its
 * cleanup lease expires.
 */
class SucceededTerminalCleanupStoryStore extends TaskAdmissionStore {
  state: 'succeeded' | 'running' | 'cancelled' = 'succeeded';
  readonly attempt = 3;
  leaseToken: string | null = null;
  leaseUntil: Date | null = null;
  readonly settlements: TaskAdmissionSettlement[] = [];

  constructor(private readonly clock: TerminalCleanupStoryClock) {
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

    const sourceState: 'succeeded' | 'running' =
      this.state === 'succeeded' ? 'succeeded' : 'running';
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
      taskLifecycleVersion: 9,
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
    const now = this.clock.now().getTime();
    return (
      this.state === 'running' &&
      this.leaseToken === request.leaseToken &&
      this.leaseUntil !== null &&
      this.leaseUntil.getTime() > now &&
      request.taskFences.some(
        (fence) =>
          fence.status === 'cancelled' && fence.lifecycleVersion === 9,
      )
    );
  }
}

function terminalCleanupDiagnosticHarness() {
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
  const events = [
    TaskProvisioningDiagnosticEventSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: '44444444-4444-4444-8444-444444444444',
      idempotencyKey: 'runtime_setup:start',
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: 3,
      sequence: 1,
      operationId: DIAGNOSTIC_OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'aio',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: new Date(DIAGNOSTIC_OBSERVED_AT.getTime() - 1_000),
      outcome: 'started',
    }),
    TaskProvisioningDiagnosticEventSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'runtime_setup:terminal',
      taskId: TASK_ID,
      attemptId: DIAGNOSTIC_ATTEMPT_ID,
      attempt: 3,
      sequence: 2,
      operationId: DIAGNOSTIC_OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'aio',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: DIAGNOSTIC_OBSERVED_AT,
      outcome: 'failed',
      durationMs: 1_000,
      cause: 'command_failed',
      retryable: false,
      httpStatusClass: null,
      nativeState: 'failed',
      anomaly: null,
      exitCode: 9,
      timeoutMs: null,
    }),
  ];

  const attempt = () =>
    TaskProvisioningDiagnosticAttemptSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      id: DIAGNOSTIC_ATTEMPT_ID,
      taskId: TASK_ID,
      attempt: 3,
      admissionMode: 'durable',
      providerFamily: 'aio',
      state: 'failed',
      stage: 'runtime_setup',
      coverage: completionMarkedAt ? 'complete' : 'partial',
      primary: {
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
        exitCode: 9,
        observedAt: DIAGNOSTIC_OBSERVED_AT,
      },
      cleanup,
      eventCount: events.length,
      truncated: false,
      startedAt: new Date(DIAGNOSTIC_OBSERVED_AT.getTime() - 2_000),
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
        attempt: 3,
      });
      resumeCalls += 1;
      return {
        ok: true as const,
        value: {
          context: {
            taskId: TASK_ID,
            attemptId: DIAGNOSTIC_ATTEMPT_ID,
            attempt: 3,
            admissionMode: 'durable' as const,
          },
          state: 'failed' as const,
          providerFamily: 'aio' as const,
          initialSequence: events.length,
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
    coverage(admissionState: 'running' | 'cancelled') {
      const current = attempt();
      return deriveTaskDiagnosticCoverage({
        expectedSchemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
        taskStatus: 'cancelled',
        admissionState,
        attempts: [current],
        eventsByAttempt: new Map([[current.id, events]]),
        hasCompaction: false,
        hasUnsupportedEvidence: false,
      });
    },
    stats() {
      return {
        beginCalls,
        resumeCalls,
        appendCalls,
        primaryCalls,
        partialCalls,
        completionMarked: completionMarkedAt !== null,
        eventCount: events.length,
      };
    },
  };
}

test('durable terminal failure releases work only after strict sandbox cleanup succeeds', async () => {
  const fixture = new TerminalFixture();
  const guardrails = {
    fenceTerminal() {
      fixture.events.push('task:fenced');
    },
    async onDurableAdmissionTerminal(taskId: string, ownerGeneration: string) {
      fixture.events.push(`sandbox:removed:${taskId}:${ownerGeneration}`);
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(
    fixture.prisma(),
    guardrails,
    successfulTerminalAudit(),
  );

  assert.equal(await service.settleDurableAdmissionFailure(request()), true);

  assert.deepEqual(fixture.events, [
    'task:failed',
    'work:cause-persisted',
    'task:fenced',
    `sandbox:removed:${TASK_ID}:${LEASE}`,
    'work:failed',
  ]);
  assert.equal(fixture.work.state, 'failed');
  assert.equal(fixture.work.leaseOwner, null);
});

test('durable terminal failure records only the classified cause before strict cleanup', async () => {
  const fixture = new TerminalFixture();
  const recorded: Array<{
    readonly taskId: string;
    readonly stage: string;
    readonly attempt: number;
    readonly failure: unknown;
  }> = [];
  const audit = {
    async recordProvisioningFailure(
      taskId: string,
      stage: string,
      attempt: number,
      failure: unknown,
    ) {
      fixture.events.push('audit:provisioning-failed');
      recorded.push({ taskId, stage, attempt, failure });
      return true;
    },
  } as unknown as AuditRecorderPort;
  const guardrails = {
    fenceTerminal() {
      fixture.events.push('task:fenced');
    },
    async onDurableAdmissionTerminal(taskId: string, ownerGeneration: string) {
      fixture.events.push(`sandbox:removed:${taskId}:${ownerGeneration}`);
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(fixture.prisma(), guardrails, audit);

  assert.equal(await service.settleDurableAdmissionFailure(request()), true);
  assert.deepEqual(fixture.events, [
    'task:failed',
    'work:cause-persisted',
    'audit:provisioning-failed',
    'task:fenced',
    `sandbox:removed:${TASK_ID}:${LEASE}`,
    'work:failed',
  ]);
  assert.deepEqual(recorded, [
    {
      taskId: TASK_ID,
      stage: 'runtime_setup',
      attempt: 1,
      failure: {
        code: 'provisioning_unknown',
        message: '任务环境准备失败，请重试；若持续失败，请联系管理员。',
        action: 'retry_task',
        occurredAt: fixture.task.failureAt,
      },
    },
  ]);
});

test('terminal audit rejection is redacted and keeps running work reclaimable', async () => {
  const fixture = new TerminalFixture();
  const unsafeCanary =
    'Bearer secret-canary https://provider.invalid git -c http.extraHeader=...';
  const audit = {
    async recordProvisioningFailure() {
      fixture.events.push('audit:unavailable');
      throw new Error(unsafeCanary);
    },
  } as unknown as AuditRecorderPort;
  const guardrails = {
    fenceTerminal() {
      assert.fail('cleanup fencing must wait for terminal audit durability');
    },
    async onDurableAdmissionTerminal() {
      assert.fail('sandbox cleanup must wait for terminal audit durability');
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(fixture.prisma(), guardrails, audit);

  await assert.rejects(
    service.settleDurableAdmissionFailure(request()),
    (error: unknown) =>
      error instanceof Error &&
      /terminal audit remains pending/.test(error.message) &&
      !error.message.includes('secret-canary') &&
      !error.message.includes('provider.invalid') &&
      !error.message.includes('extraHeader'),
  );
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.work.state, 'running');
  assert.equal(fixture.work.leaseOwner, LEASE);
  assert.deepEqual(fixture.events, [
    'task:failed',
    'work:cause-persisted',
    'audit:unavailable',
  ]);
});

test('missing terminal audit recorder fails closed before cleanup', async () => {
  const fixture = new TerminalFixture();
  const guardrails = {
    fenceTerminal() {
      assert.fail('cleanup fencing must wait for a terminal audit recorder');
    },
    async onDurableAdmissionTerminal() {
      assert.fail('sandbox cleanup must wait for a terminal audit recorder');
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(fixture.prisma(), guardrails);

  await assert.rejects(
    service.settleDurableAdmissionFailure(request()),
    /terminal audit remains pending/,
  );
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.lifecycleVersion, 8);
  assert.equal(fixture.work.state, 'running');
  assert.equal(fixture.work.causeCode, 'provisioning_unknown');
  assert.equal(fixture.work.leaseOwner, LEASE);
  assert.deepEqual(fixture.events, [
    'task:failed',
    'work:cause-persisted',
  ]);
});

test('teardown rejection leaves terminal Task plus leased running work recoverable', async () => {
  const fixture = new TerminalFixture();
  const guardrails = {
    fenceTerminal() {
      fixture.events.push('task:fenced');
    },
    async onDurableAdmissionTerminal(taskId: string, ownerGeneration: string) {
      assert.equal(taskId, TASK_ID);
      assert.equal(ownerGeneration, LEASE);
      fixture.events.push('sandbox:teardown-rejected');
      throw new Error('provider teardown unavailable');
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(
    fixture.prisma(),
    guardrails,
    successfulTerminalAudit(),
  );

  await assert.rejects(
    service.settleDurableAdmissionFailure(request()),
    /provider teardown unavailable/,
  );

  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.lifecycleVersion, 8);
  assert.equal(fixture.work.state, 'running');
  assert.equal(fixture.work.causeCode, 'provisioning_unknown');
  assert.equal(fixture.work.leaseOwner, LEASE);
  assert.equal(fixture.events.includes('work:failed'), false);
});

test('missing strict cleanup service fails closed with terminal Task and leased running work', async () => {
  const fixture = new TerminalFixture();
  const service = new TasksService(
    fixture.prisma(),
    undefined,
    successfulTerminalAudit(),
  );

  await assert.rejects(
    service.settleDurableAdmissionFailure(request()),
    /Strict durable admission cleanup is unavailable/,
  );

  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.lifecycleVersion, 8);
  assert.equal(fixture.work.state, 'running');
  assert.equal(fixture.work.leaseOwner, LEASE);
  assert.deepEqual(fixture.events, [
    'task:failed',
    'work:cause-persisted',
  ]);
});

test('terminal recovery retries audit durability before any cleanup action', async () => {
  const unsafeCanary =
    'Bearer secret-canary https://provider.invalid git -c http.extraHeader=...';
  const audit = {
    async recordProvisioningFailure() {
      throw new Error(unsafeCanary);
    },
  } as unknown as AuditRecorderPort;
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    undefined,
    GUARDRAILS_CONFIG,
    undefined,
    audit,
    failedTerminalSnapshotPrisma(),
  );
  let authorizations = 0;
  const context = {
    claim: {
      taskId: TASK_ID,
      leaseToken: 'lease:recovery-audit',
      leaseUntil: new Date('2026-07-16T00:01:00.000Z'),
      sourceState: 'running',
      attempt: 2,
      stage: 'runtime_setup',
      causeCode: 'provisioning_unknown',
      resolvedBranch: null,
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'failed',
      taskLifecycleVersion: 8,
    },
    lease: {
      currentTaskFence: () => ({ status: 'failed', lifecycleVersion: 8 }),
      beginTaskTransition: () => 9,
      commitTaskTransition() {},
      rollbackTaskTransition() {},
      async authorize() { authorizations += 1; },
      async renew() {},
      async checkpoint() {},
    },
    signal: new AbortController().signal,
  } as TaskAdmissionProcessorContext;

  await assert.rejects(
    guardrails.recoverDurableTerminalAdmission(context),
    (error: unknown) =>
      error instanceof TaskAdmissionCoordinationError &&
      !error.message.includes('secret-canary') &&
      !error.message.includes('provider.invalid') &&
      !error.message.includes('extraHeader'),
  );
  assert.equal(authorizations, 1);
});

test('terminal recovery without an audit recorder remains reclaimable', async () => {
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    undefined,
    GUARDRAILS_CONFIG,
    undefined,
    undefined,
    failedTerminalSnapshotPrisma(),
  );
  let authorizations = 0;
  const context = {
    claim: {
      taskId: TASK_ID,
      leaseToken: 'lease:recovery-missing-audit',
      leaseUntil: new Date('2026-07-16T00:01:00.000Z'),
      sourceState: 'running',
      attempt: 2,
      stage: 'runtime_setup',
      causeCode: 'provisioning_unknown',
      resolvedBranch: null,
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'failed',
      taskLifecycleVersion: 8,
    },
    lease: {
      currentTaskFence: () => ({ status: 'failed', lifecycleVersion: 8 }),
      beginTaskTransition: () => 9,
      commitTaskTransition() {},
      rollbackTaskTransition() {},
      async authorize() { authorizations += 1; },
      async renew() {},
      async checkpoint() {},
    },
    signal: new AbortController().signal,
  } as TaskAdmissionProcessorContext;

  await assert.rejects(
    guardrails.recoverDurableTerminalAdmission(context),
    TaskAdmissionCoordinationError,
  );
  assert.equal(authorizations, 1);
});

test('real Tasks, Guardrails and router retain work and slot until an in-flight create cleans through the deleting tombstone', async () => {
  const fixture = new TerminalFixture();
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const createEntered = deferred();
  const releaseCreate = deferred();
  let liveSandbox = false;
  let providerTeardownCalls = 0;
  let lateCreatorDeletes = 0;
  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: {
      readonly taskId: string;
      readonly ownership: {
        readonly ownerGeneration: string;
        readonly resourceGeneration: string;
      };
      readonly externalBoundaryGuard: (event: {
        readonly taskId: string;
        readonly action: 'sandbox.create';
        readonly position: 'before';
      }) => Promise<void>;
      readonly onSandboxCreateObserved: (observation: {
        readonly kind: 'created';
        readonly providerSandboxId: string;
      }) => Promise<void>;
      readonly beforeSandboxCleanup: () => Promise<{
        readonly kind: 'generation';
        readonly taskId: string;
        readonly providerId: string;
        readonly ownership: {
          readonly ownerGeneration: string;
          readonly resourceGeneration: string;
        };
      } | null>;
      readonly afterSandboxCleanup: (authorization: {
        readonly kind: 'generation';
        readonly taskId: string;
        readonly providerId: string;
        readonly ownership: {
          readonly ownerGeneration: string;
          readonly resourceGeneration: string;
        };
      }) => Promise<void>;
    }) {
      await ctx.externalBoundaryGuard({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      createEntered.resolve();
      await releaseCreate.promise;
      liveSandbox = true;
      await ctx.onSandboxCreateObserved({
        kind: 'created',
        providerSandboxId: 'physical-r1',
      });
      const authorization = await ctx.beforeSandboxCleanup();
      assert(authorization, 'late creator must join current cleanup ownership');
      assert.equal(
        authorization.ownership.resourceGeneration,
        ctx.ownership.resourceGeneration,
      );
      liveSandbox = false;
      lateCreatorDeletes += 1;
      await ctx.afterSandboxCleanup(authorization);
      throw new Error('late provider create was terminally fenced');
    },
    async teardownSandbox() {
      providerTeardownCalls += 1;
      if (!liveSandbox) return { kind: 'already-absent' as const };
      liveSandbox = false;
      return { kind: 'found-and-cleaned' as const };
    },
    async readRolloutFromContainer() { return null; },
    async sandboxExists() { return liveSandbox; },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new SandboxProviderRouter(
    [defineLocalSandboxProvider({
      id: 'local',
      provider: provider as never,
      capabilities: ['terminal.websocket'],
    })],
    { ownerStore },
  );
  const destroyedSessions: string[] = [];
  const auditRows = new Map<string, Record<string, unknown>>();
  const audit = new AuditService({
    auditEvent: {
      async upsert({
        where,
        create,
      }: {
        where: { dedupeKey: string };
        create: Record<string, unknown>;
      }) {
        const existing = auditRows.get(where.dedupeKey);
        if (existing) return existing;
        auditRows.set(where.dedupeKey, create);
        return create;
      },
    },
  } as unknown as PrismaService);
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    {
      destroyForSession(taskId: string) {
        destroyedSessions.push(taskId);
      },
    } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    GUARDRAILS_CONFIG,
    undefined,
    audit,
    fixture.prisma(),
  );
  // This fixture exercises durable cleanup, not terminal readoption. Seed the
  // already-running accounting state directly; production readopt is now
  // strict attach-only and therefore requires a real terminal gateway proof.
  (
    guardrails as unknown as {
      semaphore: { restoreRunning(taskId: string): void };
    }
  ).semaphore.restoreRunning(TASK_ID);
  assert.equal(guardrails.runningCount, 1);
  const tasks = new TasksService(
    fixture.prisma(),
    guardrails as unknown as IGuardrailsService,
    audit,
  );
  const provisioning = router.provision({
    taskId: TASK_ID,
    modelIntent: { kind: 'runtime-default' },
    runtimeId: 'codex',
    executionMode: 'interactive-pty',
    cloneSpec: null,
    resources: {},
    workspace: null,
    ownership: {
      ownerGeneration: LEASE,
      resourceGeneration: 'resource:r1',
    },
  });
  await createEntered.promise;

  await assert.rejects(
    tasks.settleDurableAdmissionFailure(request()),
    /cleanup is pending settlement of an in-flight create/,
  );
  assert.equal(fixture.task.status, 'failed');
  assert.equal(fixture.task.lifecycleVersion, 8);
  assert.equal(fixture.work.state, 'running');
  assert.equal(fixture.work.leaseOwner, LEASE);
  assert.equal(guardrails.runningCount, 1);
  assert.equal(providerTeardownCalls, 1);
  const deleting = await ownerStore.acquireSandboxRunOwner({
    taskId: TASK_ID,
    providerId: 'local',
    ownerGeneration: 'lease:probe',
    proposedResourceGeneration: 'resource:r2',
  });
  assert.equal(deleting.kind, 'cleanup-required');
  assert.equal(deleting.owner.status, 'deleting');

  releaseCreate.resolve();
  await assert.rejects(provisioning, /late provider create was terminally fenced/);
  assert.equal(liveSandbox, false);
  assert.equal(lateCreatorDeletes, 1);

  let authorizations = 0;
  const recoveryContext = {
    claim: {
      taskId: TASK_ID,
      leaseToken: 'lease:recovery',
      leaseUntil: new Date('2026-07-16T00:01:00.000Z'),
      sourceState: 'running',
      attempt: 2,
      stage: 'runtime_setup',
      causeCode: 'provisioning_unknown',
      resolvedBranch: null,
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'failed',
      taskLifecycleVersion: 8,
    },
    lease: {
      currentTaskFence: () => ({ status: 'failed', lifecycleVersion: 8 }),
      beginTaskTransition: () => 9,
      commitTaskTransition() {},
      rollbackTaskTransition() {},
      async authorize() { authorizations += 1; },
      async renew() {},
      async checkpoint() {},
    },
    signal: new AbortController().signal,
  } as TaskAdmissionProcessorContext;
  assert.deepEqual(
    await guardrails.recoverDurableTerminalAdmission(recoveryContext),
    {
      state: 'failed',
      stage: 'runtime_setup',
      causeCode: 'provisioning_unknown',
    },
  );
  assert.equal(guardrails.runningCount, 0);
  assert.equal(providerTeardownCalls, 1);
  assert.equal(
    authorizations,
    3,
    'recovery reauthorizes after diagnostic/audit work before cleanup and once after cleanup',
  );
  assert.deepEqual(
    [...auditRows.values()].map((row) => row.type),
    ['task.failed', 'task.provisioning.failed:provisioning_unknown'],
  );
  assert.equal(auditRows.size, 2);

  await guardrails.recoverDurableTerminalAdmission(recoveryContext);
  assert.equal(guardrails.runningCount, 0);
  assert.equal(providerTeardownCalls, 1);
  assert.equal(lateCreatorDeletes, 1);
  assert.equal(authorizations, 3, 'same-claim replay reuses the settled recovery');
  assert.equal(auditRows.size, 2, 'recovery replay keeps terminal audit stable');
  assert.deepEqual(
    destroyedSessions,
    [TASK_ID],
    'same-claim replay does not repeat terminal session teardown',
  );
});

test('succeeded durable work defers ordinary terminal cleanup and recovers the original attempt exactly once', async () => {
  const clock = new TerminalCleanupStoryClock();
  const store = new SucceededTerminalCleanupStoryStore(clock);
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const promoted: string[] = [];
  const destroyedSessions: string[] = [];
  const auditRows = new Set<string>();
  const diagnosticHarness = terminalCleanupDiagnosticHarness();
  let provisionCalls = 0;
  let providerTeardownCalls = 0;
  let physicalSandboxPresent = false;

  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: {
      readonly taskId: string;
      readonly externalBoundaryGuard: (event: {
        readonly taskId: string;
        readonly action: 'sandbox.create';
        readonly position: 'before';
      }) => Promise<void>;
      readonly onSandboxCreateObserved: (observation: {
        readonly kind: 'created';
        readonly providerSandboxId: string;
      }) => Promise<void>;
    }) {
      provisionCalls += 1;
      await ctx.externalBoundaryGuard({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      physicalSandboxPresent = true;
      await ctx.onSandboxCreateObserved({
        kind: 'created',
        providerSandboxId: 'physical-succeeded-r1',
      });
      return {
        taskId: ctx.taskId,
        providerId: 'local',
        containerName: 'physical-succeeded-r1',
        wsUrl: 'ws://sandbox.test/physical-succeeded-r1',
      };
    },
    async teardownSandbox(): Promise<SandboxPhysicalCleanupResult> {
      providerTeardownCalls += 1;
      if (providerTeardownCalls === 1) {
        return {
          outcome: 'failed',
          proof: null,
          cause: 'cleanup_failed',
          retryable: true,
        };
      }
      physicalSandboxPresent = false;
      return {
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
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
      resourceGeneration: 'resource:successful-provisioning',
    },
  });
  assert.equal(physicalSandboxPresent, true);
  assert.equal(provisionCalls, 1);

  const prisma = {
    task: {
      async findUnique() {
        return {
          status: 'cancelled',
          lifecycleVersion: 9,
          failureCode: null,
        };
      },
    },
    taskAdmissionWork: {
      async findUnique() {
        return { state: store.state };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTaskCancellation() {
      auditRows.add(`task.cancelled:${TASK_ID}`);
      return true;
    },
  } as unknown as AuditRecorderPort;
  const writeGate = {
    isEnabled: () => true,
  } as TaskProvisioningDiagnosticsWriteGatePort;
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    {
      destroyForSession(taskId: string) {
        destroyedSessions.push(taskId);
      },
    } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    {
      ...GUARDRAILS_CONFIG,
      diagnosticWriteTimeoutMs: 10,
      cleanupTerminalPolicyMaxAttempts: 3,
    },
    undefined,
    audit,
    prisma,
    undefined,
    diagnosticHarness.recorder,
    writeGate,
  );
  Object.assign(guardrails, {
    onAdmit: async (taskId: string) => promoted.push(taskId),
  });
  const semaphore = (
    guardrails as unknown as {
      semaphore: {
        offer(taskId: string): 'running' | 'queued';
        readonly runningCount: number;
        readonly queuedCount: number;
      };
    }
  ).semaphore;
  guardrails.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  await guardrails.onTerminal(TASK_ID);
  assert.equal(
    providerTeardownCalls,
    0,
    'ordinary terminal handling must defer to the durable succeeded-work row',
  );
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);

  const processor = new FencedTaskAdmissionProcessor({
    get(token: unknown) {
      assert.equal(token, GuardrailsService);
      return guardrails;
    },
  } as unknown as ModuleRef);
  const worker = new TaskAdmissionWorker(
    store,
    processor,
    new TerminalCleanupStoryScheduler(),
    clock,
    new TerminalCleanupStoryLeaseTokens(),
    {
      ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
      leaseDurationMs: 100,
      renewIntervalMs: 25,
      maxInFlight: 1,
    },
  );

  await assert.rejects(worker.runOnce(), TaskAdmissionCoordinationError);
  assert.equal(store.state, 'running');
  assert.equal(store.settlements.length, 0);
  assert.equal(providerTeardownCalls, 1);
  assert.equal(physicalSandboxPresent, true);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);
  assert.deepEqual(promoted, []);
  const pending = await router.getSandboxCleanupAuthority(TASK_ID);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.attemptCount, 1);
  assert.deepEqual(
    diagnosticHarness.cleanupRows.map((row) => row.state),
    ['pending'],
  );
  assert.equal(diagnosticHarness.coverage('running'), 'partial');

  clock.advance(101);
  assert.deepEqual(await worker.runOnce(), {
    kind: 'cancelled',
    taskId: TASK_ID,
    attempt: 3,
  });
  assert.equal(store.state, 'cancelled');
  assert.deepEqual(store.settlements, [
    { state: 'cancelled', stage: 'complete' },
  ]);
  assert.equal(providerTeardownCalls, 2);
  assert.equal(physicalSandboxPresent, false);
  assert.equal((await router.getSandboxCleanupAuthority(TASK_ID)).status, 'removed');
  assert.equal(semaphore.queuedCount, 0);
  assert.deepEqual(promoted, ['legacy-waiter']);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
  assert.deepEqual(
    diagnosticHarness.cleanupRows.map((row) => row.state),
    ['pending', 'succeeded'],
  );
  assert.equal(diagnosticHarness.coverage('cancelled'), 'complete');

  assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
  assert.equal(provisionCalls, 1, 'terminal recovery must never reprovision');
  assert.deepEqual(diagnosticHarness.stats(), {
    beginCalls: 0,
    resumeCalls: 4,
    appendCalls: 0,
    primaryCalls: 0,
    partialCalls: 0,
    completionMarked: true,
    eventCount: 2,
  });
  assert.equal(auditRows.size, 1);
  assert.deepEqual(promoted, ['legacy-waiter']);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
});

test('real terminal policy releases one durable slot only after bounded physical cleanup remains unconfirmed', async () => {
  const clock = new TerminalCleanupStoryClock();
  const store = new SucceededTerminalCleanupStoryStore(clock);
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const diagnosticHarness = terminalCleanupDiagnosticHarness();
  const promoted: string[] = [];
  const destroyedSessions: string[] = [];
  const auditRows = new Set<string>();
  let provisionCalls = 0;
  let providerTeardownCalls = 0;
  let physicalSandboxPresent = false;

  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: {
      readonly taskId: string;
      readonly externalBoundaryGuard: (event: {
        readonly taskId: string;
        readonly action: 'sandbox.create';
        readonly position: 'before';
      }) => Promise<void>;
      readonly onSandboxCreateObserved: (observation: {
        readonly kind: 'created';
        readonly providerSandboxId: string;
      }) => Promise<void>;
    }) {
      provisionCalls += 1;
      await ctx.externalBoundaryGuard({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      physicalSandboxPresent = true;
      await ctx.onSandboxCreateObserved({
        kind: 'created',
        providerSandboxId: 'physical-terminal-policy-r1',
      });
      return {
        taskId: ctx.taskId,
        providerId: 'local',
        containerName: 'physical-terminal-policy-r1',
        wsUrl: 'ws://sandbox.test/physical-terminal-policy-r1',
      };
    },
    async teardownSandbox(): Promise<SandboxPhysicalCleanupResult> {
      providerTeardownCalls += 1;
      return {
        outcome: 'failed',
        proof: null,
        cause: 'cleanup_failed',
        retryable: true,
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
      ownerGeneration: 'lease:terminal-policy-provisioning',
      resourceGeneration: 'resource:terminal-policy-provisioning',
    },
  });

  const prisma = {
    task: {
      async findUnique() {
        return {
          status: 'cancelled',
          lifecycleVersion: 9,
          failureCode: null,
        };
      },
    },
    taskAdmissionWork: {
      async findUnique() {
        return { state: store.state };
      },
    },
  } as unknown as PrismaService;
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    {
      destroyForSession(taskId: string) {
        destroyedSessions.push(taskId);
      },
    } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    {
      ...GUARDRAILS_CONFIG,
      diagnosticWriteTimeoutMs: 10,
      cleanupTerminalPolicyMaxAttempts: 2,
    },
    undefined,
    {
      async recordTaskCancellation() {
        auditRows.add(`task.cancelled:${TASK_ID}`);
        return true;
      },
    } as unknown as AuditRecorderPort,
    prisma,
    undefined,
    diagnosticHarness.recorder,
    { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
  );
  Object.assign(guardrails, {
    onAdmit: async (taskId: string) => promoted.push(taskId),
  });
  const semaphore = (
    guardrails as unknown as {
      semaphore: {
        offer(taskId: string): 'running' | 'queued';
        readonly runningCount: number;
        readonly queuedCount: number;
      };
    }
  ).semaphore;
  guardrails.restoreDurableAdmissionSlot(TASK_ID);
  assert.equal(semaphore.offer('legacy-waiter'), 'queued');

  const worker = new TaskAdmissionWorker(
    store,
    new FencedTaskAdmissionProcessor({
      get(token: unknown) {
        assert.equal(token, GuardrailsService);
        return guardrails;
      },
    } as unknown as ModuleRef),
    new TerminalCleanupStoryScheduler(),
    clock,
    new TerminalCleanupStoryLeaseTokens(),
    {
      ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
      leaseDurationMs: 100,
      renewIntervalMs: 25,
      maxInFlight: 1,
    },
  );

  await assert.rejects(worker.runOnce(), TaskAdmissionCoordinationError);
  assert.equal(store.state, 'running');
  assert.equal(providerTeardownCalls, 1);
  assert.equal(physicalSandboxPresent, true);
  assert.equal(semaphore.runningCount, 1);
  assert.equal(semaphore.queuedCount, 1);
  assert.deepEqual(promoted, []);
  assert.equal((await router.getSandboxCleanupAuthority(TASK_ID)).state, 'pending');
  assert.deepEqual(
    diagnosticHarness.cleanupRows.map((row) => row.state),
    ['pending'],
  );
  assert.equal(diagnosticHarness.coverage('running'), 'partial');

  clock.advance(101);
  assert.deepEqual(await worker.runOnce(), {
    kind: 'cancelled',
    taskId: TASK_ID,
    attempt: 3,
  });
  const failedAuthority = await router.getSandboxCleanupAuthority(TASK_ID);
  assert.equal(failedAuthority.state, 'failed');
  assert.equal(failedAuthority.status, 'failed');
  assert.equal(failedAuthority.attemptCount, 2);
  assert.equal(providerTeardownCalls, 2);
  assert.equal(
    physicalSandboxPresent,
    true,
    'terminal policy relinquishes authority without fabricating absence',
  );
  assert.equal(store.state, 'cancelled');
  assert.equal(semaphore.runningCount, 1, 'promoted waiter owns the one slot');
  assert.equal(semaphore.queuedCount, 0);
  assert.deepEqual(promoted, ['legacy-waiter']);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
  assert.deepEqual(
    diagnosticHarness.cleanupRows.map((row) => row.state),
    ['pending', 'failed'],
  );
  assert.equal(diagnosticHarness.coverage('cancelled'), 'complete');

  assert.deepEqual(await worker.runOnce(), { kind: 'idle' });
  assert.equal(provisionCalls, 1);
  assert.equal(auditRows.size, 1);
  assert.deepEqual(diagnosticHarness.stats(), {
    beginCalls: 0,
    resumeCalls: 4,
    appendCalls: 0,
    primaryCalls: 0,
    partialCalls: 0,
    completionMarked: true,
    eventCount: 2,
  });
  assert.deepEqual(promoted, ['legacy-waiter']);
  assert.deepEqual(destroyedSessions, [TASK_ID]);
});
