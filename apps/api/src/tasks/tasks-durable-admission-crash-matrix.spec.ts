import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import type {
  TaskProvisioningStage,
  TaskStatus,
} from '@cap/contracts';
import {
  InMemorySandboxRunOwnerStore,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
  type SandboxProvisionContext,
} from '@cap/sandbox';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  GuardrailsService,
  type GuardrailsConfig,
  type ITerminalGateway,
} from '../guardrails/guardrails.service';
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
  TaskAdmissionLeaseLostError,
  TaskAdmissionProcessingError,
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionParkRequest,
  type TaskAdmissionParkedHeartbeatRequest,
  type TaskAdmissionParkedJobObservation,
  type TaskAdmissionParkedJobPort,
  type TaskAdmissionParkedReleaseRequest,
  type TaskAdmissionProcessor,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionTerminalFailure,
  type TaskAdmissionTerminalRecovery,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import type { PreparedTaskCreate } from './prepared-task-create';
import { TasksService } from './tasks.service';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_TIME = new Date('2026-07-16T00:00:00.000Z');
const REAL_GUARDRAILS_CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
};

type MatrixWorkState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'parked'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface MatrixTask {
  readonly id: string;
  status: TaskStatus;
  lifecycleVersion: number;
  [key: string]: unknown;
}

interface MatrixWork {
  readonly taskId: string;
  state: MatrixWorkState;
  attempt: number;
  availableAtMs: number;
  leaseToken: string | null;
  leaseUntilMs: number | null;
  stage: TaskProvisioningStage;
  causeCode: string | null;
  resolvedBranch: string | null;
  resourceSnapshot: Record<string, unknown>;
  workspaceMaterializationDeadlineMs: number;
  /** detach-workspace-clone: the parked ownership generation while parked. */
  parkedLeaseOwner: string | null;
  /** detach-workspace-clone: latest transfer progress persisted by the poll loop. */
  progressSnapshot: Record<string, unknown> | null;
  updatedAt: Date;
}

interface MatrixAudit {
  readonly dedupeKey: string;
  readonly taskId: string;
  readonly type: string;
  readonly description: string;
  [key: string]: unknown;
}

interface MatrixState {
  readonly tasks: MatrixTask[];
  readonly works: MatrixWork[];
  readonly audits: Map<string, MatrixAudit>;
}

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

/**
 * Transactional in-memory seam shared by the real acceptance writer, worker
 * store, and AuditService. A transaction commits by replacing all three
 * collections together, so the pre-commit crash is a genuine rollback story.
 */
class MatrixDatabase {
  readonly state: MatrixState = {
    tasks: [],
    works: [],
    audits: new Map(),
  };
  failAcceptanceAudit = false;
  private sequence = 0;

  readonly prisma = this.buildPrisma();

  private buildPrisma(): PrismaService {
    const clientFor = (target: MatrixState) => ({
      task: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          this.sequence += 1;
          const row: MatrixTask = {
            id: `33333333-3333-4333-8333-${this.sequence
              .toString()
              .padStart(12, '0')}`,
            ...data,
            status: 'pending',
            lifecycleVersion: 0,
            createdAt: FIXED_TIME,
            branch: data.branch ?? null,
            strategy: data.strategy ?? null,
            skills: data.skills ?? [],
            idleTimeoutMs: data.idleTimeoutMs ?? null,
            deadlineMs: data.deadlineMs ?? null,
            runtime: data.runtime ?? null,
            model: data.model ?? null,
            sandboxEnvironmentId: data.sandboxEnvironmentId ?? null,
            executionMode: data.executionMode ?? null,
            deliver: data.deliver ?? null,
          };
          target.tasks.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          target.tasks.find(({ id }) => id === where.id) ?? null,
      },
      taskAdmissionWork: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const taskId = String(data.taskId);
          if (target.works.some((row) => row.taskId === taskId)) {
            throw Object.assign(new Error('duplicate admission work'), {
              code: 'P2002',
            });
          }
          const row: MatrixWork = {
            taskId,
            state: 'accepted',
            attempt: 0,
            availableAtMs: 0,
            leaseToken: null,
            leaseUntilMs: null,
            stage: 'accepted',
            causeCode: null,
            resolvedBranch: String(data.resolvedBranch),
            resourceSnapshot: (data.resourceSnapshot ?? {}) as Record<
              string,
              unknown
            >,
            workspaceMaterializationDeadlineMs: Number(
              data.workspaceMaterializationDeadlineMs,
            ),
            parkedLeaseOwner: null,
            progressSnapshot: null,
            updatedAt: FIXED_TIME,
          };
          target.works.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: { taskId: string } }) =>
          target.works.find(({ taskId }) => taskId === where.taskId) ?? null,
      },
      auditEvent: {
        upsert: async ({
          where,
          update,
          create,
        }: {
          where: { dedupeKey: string };
          update: Record<string, unknown>;
          create: MatrixAudit;
        }) => {
          assert.deepEqual(
            update,
            {},
            'idempotent audit replay must not mutate the first durable detail',
          );
          if (
            this.failAcceptanceAudit &&
            where.dedupeKey.startsWith('task.created:')
          ) {
            throw new Error('simulated crash before acceptance commit');
          }
          const existing = target.audits.get(where.dedupeKey);
          if (existing) return existing;
          target.audits.set(where.dedupeKey, create);
          return create;
        },
      },
    });

    const state = this.state;
    const root = clientFor(state);
    return {
      ...root,
      user: {
        async findUnique({ where }: { where: { id: string } }) {
          return { id: where.id };
        },
      },
      async $transaction<T>(
        operation: (
          client: ReturnType<typeof clientFor>,
        ) => Promise<T>,
      ): Promise<T> {
        const staged: MatrixState = {
          tasks: state.tasks.map((row) => ({ ...row })),
          works: state.works.map((row) => ({ ...row })),
          audits: new Map(state.audits),
        };
        const result = await operation(clientFor(staged));
        state.tasks.splice(0, state.tasks.length, ...staged.tasks);
        state.works.splice(0, state.works.length, ...staged.works);
        state.audits.clear();
        for (const [key, value] of staged.audits) {
          state.audits.set(key, value);
        }
        return result;
      },
    } as unknown as PrismaService;
  }
}

class MatrixClock extends TaskAdmissionClock {
  constructor(private currentMs = FIXED_TIME.getTime()) {
    super();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  get value(): number {
    return this.currentMs;
  }

  advanceBy(durationMs: number): void {
    assert.ok(durationMs >= 0);
    this.currentMs += durationMs;
  }

  advancePast(timestampMs: number): void {
    assert.ok(timestampMs >= this.currentMs);
    this.currentMs = timestampMs + 1;
  }
}

class MatrixScheduler extends TaskAdmissionScheduler {
  private sequence = 0;
  private readonly timers: Array<{
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  constructor(private readonly clock: MatrixClock) {
    super();
  }

  schedule(delayMs: number, callback: () => void): TaskAdmissionTimer {
    const timer = {
      id: ++this.sequence,
      dueAt: this.clock.value + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  runDue(): void {
    for (;;) {
      const next = this.timers
        .filter(({ cancelled, dueAt }) => !cancelled && dueAt <= this.clock.value)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) return;
      next.cancelled = true;
      next.callback();
    }
  }
}

class MatrixLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `matrix-lease:${this.sequence}`;
  }
}

class MatrixStore extends TaskAdmissionStore {
  readonly firstRenewal = deferred<void>();
  renewals = 0;
  private coordinationCrashStage: TaskProvisioningStage | null = null;

  constructor(
    private readonly state: MatrixState,
    private readonly clock: MatrixClock,
  ) {
    super();
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    const work = this.state.works.find(
      (candidate) =>
        ((candidate.state === 'accepted' ||
          candidate.state === 'queued' ||
          candidate.state === 'retrying') &&
          candidate.availableAtMs <= this.clock.value) ||
        ((candidate.state === 'running' || candidate.state === 'parked') &&
          candidate.leaseUntilMs !== null &&
          candidate.leaseUntilMs <= this.clock.value),
    );
    if (!work) return null;
    const task = this.task(work.taskId);
    const sourceState = work.state;
    assert.ok(
      sourceState === 'accepted' ||
        sourceState === 'queued' ||
        sourceState === 'retrying' ||
        sourceState === 'running' ||
        sourceState === 'parked',
    );
    // detach-workspace-clone: resuming a parked row carries the parked
    // ownership generation and never burns/increments the attempt counter.
    const parkedLeaseToken =
      sourceState === 'parked' ? work.parkedLeaseOwner : null;
    work.state = 'running';
    work.attempt =
      sourceState === 'queued' || sourceState === 'parked'
        ? work.attempt
        : sourceState === 'running' && isTerminalTaskStatus(task.status)
          ? Math.max(work.attempt, 1)
          : work.attempt + 1;
    work.parkedLeaseOwner = null;
    work.leaseToken = request.leaseToken;
    work.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    work.updatedAt = this.clock.now();
    return {
      taskId: work.taskId,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(work.leaseUntilMs),
      sourceState,
      attempt: work.attempt,
      stage: work.stage,
      causeCode: work.causeCode as TaskAdmissionClaim['causeCode'],
      resolvedBranch: work.resolvedBranch,
      resourceSnapshot: work.resourceSnapshot,
      workspaceMaterializationDeadlineMs:
        work.workspaceMaterializationDeadlineMs,
      taskStatus: task.status,
      taskLifecycleVersion: task.lifecycleVersion,
      ...(parkedLeaseToken === null ? {} : { parkedLeaseToken }),
    };
  }

  /**
   * detach-workspace-clone: settle a running claim as `parked` while
   * retaining the lease pair as the parked ownership generation, mirroring
   * the production CTE semantics (parking never releases the token and never
   * touches the attempt counter).
   */
  override async park(request: TaskAdmissionParkRequest): Promise<boolean> {
    if (!(await this.authorize(request))) return false;
    const work = this.work(request.taskId);
    work.state = 'parked';
    work.stage = request.settlement.stage;
    work.parkedLeaseOwner = request.leaseToken;
    work.leaseUntilMs = this.clock.value + request.settlement.leaseDurationMs;
    work.updatedAt = this.clock.now();
    return true;
  }

  /** Extend a live parked lease and persist the latest progress snapshot. */
  override async parkedHeartbeat(
    request: TaskAdmissionParkedHeartbeatRequest,
  ): Promise<boolean> {
    const work = this.state.works.find(
      (row) => row.taskId === request.taskId,
    );
    if (
      !work ||
      work.state !== 'parked' ||
      work.parkedLeaseOwner !== request.leaseToken ||
      work.leaseUntilMs === null ||
      work.leaseUntilMs <= this.clock.value
    ) {
      return false;
    }
    work.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    if (request.progress !== undefined && request.progress !== null) {
      work.progressSnapshot = { ...request.progress };
    }
    work.updatedAt = this.clock.now();
    return true;
  }

  /** Expire a parked lease in place so only the expired-lease claim branch resumes it. */
  override async releaseParked(
    request: TaskAdmissionParkedReleaseRequest,
  ): Promise<boolean> {
    const work = this.state.works.find(
      (row) => row.taskId === request.taskId,
    );
    if (
      !work ||
      work.state !== 'parked' ||
      work.parkedLeaseOwner !== request.leaseToken
    ) {
      return false;
    }
    work.leaseUntilMs = this.clock.value;
    work.updatedAt = this.clock.now();
    return true;
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.owns(request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const work = this.work(request.taskId);
    work.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    this.renewals += 1;
    if (this.renewals === 1) this.firstRenewal.resolve();
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    if (this.coordinationCrashStage === request.stage) {
      this.coordinationCrashStage = null;
      throw new Error('simulated checkpoint acknowledgement crash');
    }
    const work = this.work(request.taskId);
    work.stage = request.stage;
    work.updatedAt = this.clock.now();
    return true;
  }

  crashNextCheckpoint(stage: TaskProvisioningStage): void {
    this.coordinationCrashStage = stage;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const work = this.work(request.taskId);
    work.state = request.settlement.state;
    work.stage = request.settlement.stage;
    work.causeCode =
      request.settlement.state === 'failed' ||
      request.settlement.state === 'retrying'
        ? request.settlement.causeCode
        : work.causeCode;
    work.availableAtMs =
      request.settlement.state === 'retrying' ||
      request.settlement.state === 'queued'
        ? this.clock.value + request.settlement.availableAfterMs
        : 0;
    work.leaseToken = null;
    work.leaseUntilMs = null;
    work.updatedAt = this.clock.now();
    return true;
  }

  private owns(request: TaskAdmissionAuthorityRequest): boolean {
    const work = this.state.works.find(({ taskId }) => taskId === request.taskId);
    const task = this.state.tasks.find(({ id }) => id === request.taskId);
    return Boolean(
      work &&
        task &&
        work.state === 'running' &&
        work.leaseToken === request.leaseToken &&
        work.leaseUntilMs !== null &&
        work.leaseUntilMs > this.clock.value &&
        request.taskFences.some(
          ({ status, lifecycleVersion }) =>
            status === task.status && lifecycleVersion === task.lifecycleVersion,
        ),
    );
  }

  private task(taskId: string): MatrixTask {
    const task = this.state.tasks.find(({ id }) => id === taskId);
    assert.ok(task);
    return task;
  }

  private work(taskId: string): MatrixWork {
    const work = this.state.works.find((row) => row.taskId === taskId);
    assert.ok(work);
    return work;
  }
}

type MatrixMode =
  | 'success'
  | 'active-lease'
  | 'post-sandbox-crash'
  | 'retry-terminal-crash'
  | 'cancellation';

class MatrixProcessor implements TaskAdmissionProcessor {
  readonly boundaryEntered = deferred<void>();
  readonly releaseBoundary = deferred<void>();
  readonly slotOwners = new Set<string>();
  readonly liveSandboxes = new Set<string>();
  slotAllocations = 0;
  slotReuses = 0;
  maxSimultaneousSlots = 0;
  sandboxCreates = 0;
  sandboxDeletes = 0;
  processCalls = 0;
  terminalSettlementCalls = 0;

  constructor(
    private readonly mode: MatrixMode,
    private readonly state: MatrixState,
    private readonly audit: AuditService,
  ) {}

  async process(
    context: TaskAdmissionProcessorContext,
  ): Promise<{ readonly kind: 'succeeded' }> {
    this.processCalls += 1;
    await context.lease.authorize();
    this.reserveSlot(context);
    await context.lease.checkpoint('sandbox_creation');
    await context.lease.authorize();
    this.provisionIdempotently(context.claim.taskId);

    if (
      this.mode === 'active-lease' ||
      this.mode === 'cancellation'
    ) {
      this.boundaryEntered.resolve();
      await waitForBoundaryOrAbort(
        this.releaseBoundary.promise,
        context.signal,
        context.claim.taskId,
      );
    }

    if (this.mode === 'post-sandbox-crash' && this.processCalls === 1) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        context.claim.taskId,
      );
    }

    if (this.mode === 'retry-terminal-crash') {
      await context.lease.checkpoint('workspace_transfer');
      if (this.processCalls === 1) {
        throw new TaskAdmissionProcessingError(
          'provisioning_tls_network_failed',
          'workspace_transfer',
          true,
        );
      }
      throw new TaskAdmissionProcessingError(
        'provisioning_capacity_exhausted',
        'workspace_transfer',
        false,
      );
    }

    await context.lease.authorize();
    await context.lease.checkpoint('agent_launch');
    await context.lease.checkpoint('complete');
    return { kind: 'succeeded' };
  }

  async settleTerminalFailure(
    context: TaskAdmissionProcessorContext,
    failure: TaskAdmissionTerminalFailure,
  ): Promise<boolean> {
    this.terminalSettlementCalls += 1;
    assert.equal(failure.causeCode, 'provisioning_capacity_exhausted');
    const recorded = await this.recordCapacityFailure(
      context.claim.taskId,
      failure.stage,
      context.claim.attempt,
    );
    assert.equal(recorded, true);

    const task = this.task(context.claim.taskId);
    const work = this.work(context.claim.taskId);
    task.status = 'failed';
    task.lifecycleVersion += 1;
    work.causeCode = failure.causeCode;
    // Simulate process death after the terminal Task/cause/audit commit but
    // before sandbox cleanup and work settlement acknowledgement.
    throw new TaskAdmissionCoordinationError(
      'checkpoint',
      context.claim.taskId,
    );
  }

  async recoverTerminal(
    context: TaskAdmissionProcessorContext,
  ): Promise<TaskAdmissionTerminalRecovery> {
    await context.lease.authorize();
    if (context.claim.taskStatus === 'failed') {
      assert.equal(context.claim.causeCode, 'provisioning_capacity_exhausted');
      const recorded = await this.recordCapacityFailure(
        context.claim.taskId,
        context.claim.stage,
        context.claim.attempt,
      );
      assert.equal(recorded, true);
      this.cleanup(context.claim.taskId);
      await context.lease.authorize();
      return {
        state: 'failed',
        stage: context.claim.stage,
        causeCode: 'provisioning_capacity_exhausted',
      };
    }
    assert.equal(context.claim.taskStatus, 'cancelled');
    assert.equal(
      await this.audit.recordTaskCancellation(context.claim.taskId),
      true,
    );
    this.cleanup(context.claim.taskId);
    await context.lease.authorize();
    return { state: 'cancelled', stage: context.claim.stage };
  }

  private reserveSlot(context: TaskAdmissionProcessorContext): void {
    const task = this.task(context.claim.taskId);
    if (task.status === 'pending' || task.status === 'queued') {
      const nextVersion = context.lease.beginTaskTransition(['running']);
      task.status = 'running';
      task.lifecycleVersion = nextVersion;
      context.lease.commitTaskTransition({
        status: 'running',
        lifecycleVersion: nextVersion,
      });
    }
    assert.equal(task.status, 'running');
    if (this.slotOwners.has(task.id)) {
      this.slotReuses += 1;
      return;
    }
    this.slotOwners.add(task.id);
    this.slotAllocations += 1;
    this.maxSimultaneousSlots = Math.max(
      this.maxSimultaneousSlots,
      this.slotOwners.size,
    );
  }

  private provisionIdempotently(taskId: string): void {
    if (this.liveSandboxes.has(taskId)) return;
    this.liveSandboxes.add(taskId);
    this.sandboxCreates += 1;
  }

  private cleanup(taskId: string): void {
    this.slotOwners.delete(taskId);
    if (this.liveSandboxes.delete(taskId)) this.sandboxDeletes += 1;
  }

  private recordCapacityFailure(
    taskId: string,
    stage: TaskProvisioningStage,
    attempt: number,
  ): Promise<boolean> {
    return this.audit.recordProvisioningFailure(taskId, stage, attempt, {
      code: 'provisioning_capacity_exhausted',
      message: 'provider diagnostic must be ignored',
      action: 'increase_sandbox_capacity',
      occurredAt: FIXED_TIME,
    });
  }

  private task(taskId: string): MatrixTask {
    const task = this.state.tasks.find(({ id }) => id === taskId);
    assert.ok(task);
    return task;
  }

  private work(taskId: string): MatrixWork {
    const work = this.state.works.find((row) => row.taskId === taskId);
    assert.ok(work);
    return work;
  }
}

async function waitForBoundaryOrAbort(
  boundary: Promise<void>,
  signal: AbortSignal,
  taskId: string,
): Promise<void> {
  if (signal.aborted) throw new TaskAdmissionLeaseLostError(taskId);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new TaskAdmissionLeaseLostError(taskId));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void boundary.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function preparedTask(): PreparedTaskCreate {
  return {
    repoId: REPO_ID,
    ownerUserId: USER_ID,
    body: Object.freeze({ prompt: 'crash matrix', branch: undefined }),
    runtime: 'codex',
    executionMode: 'interactive-pty',
    sandboxEnvironmentId: null,
    model: null,
    executionEnvironmentSnapshot: null,
    admissionMode: 'durable-v2',
    resolvedBranch: 'master',
    resourceSnapshot: Object.freeze({ diskSizeGb: 8 }),
    workspaceMaterializationDeadlineMs: 900_000,
  } as PreparedTaskCreate;
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'agent_failed_to_start'
  );
}

function realProvisionLookup(): ProvisionLookup {
  return {
    async getTaskLaunchContext() {
      return {
        modelIntent: { kind: 'runtime-default' as const },
        ownerUserId: USER_ID,
        runtimeId: 'codex' as const,
        executionMode: 'interactive-pty' as const,
        resources: Object.freeze({ diskSizeGb: 8 }),
        workspaceMaterializationDeadlineMs: 900_000,
      };
    },
    async getTaskWorkspacePlan() {
      return {
        repositoryUrl: 'https://gitee.example/acme/repo.git',
        callerBranch: null,
        resolvedBranch: 'master',
        deadlineMs: 900_000,
      };
    },
    async getCloneSpec() {
      throw new Error('canonical workspace planning must suppress legacy clone');
    },
    async getTaskPrompt() {
      return 'crash matrix';
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
}

function realGuardrailsProcessor(
  sandbox: SandboxProvider,
  audit: AuditService,
  prisma?: PrismaService,
): {
  readonly guardrails: GuardrailsService;
  readonly processor: FencedTaskAdmissionProcessor;
} {
  const moduleRef = {
    get(token: unknown) {
      assert.equal(token, GuardrailsService);
      return guardrails;
    },
  } as unknown as ModuleRef;
  const guardrails = new GuardrailsService(
    moduleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    sandbox,
    REAL_GUARDRAILS_CONFIG,
    realProvisionLookup(),
    audit,
    prisma,
  );
  const gateway: ITerminalGateway = {
    openSession(_connection, _selectedRun, options) {
      return {
        launchDecision: (async () => {
          await options?.beforeAgentLaunch?.();
          return { kind: 'launched' as const };
        })(),
      };
    },
    unregisterSession() {},
    async readSessionLogTail() {
      return '';
    },
  };
  Object.assign(guardrails, { gateway });
  return {
    guardrails,
    processor: new FencedTaskAdmissionProcessor(moduleRef),
  };
}

class CrashMatrixHarness {
  readonly database = new MatrixDatabase();
  readonly clock = new MatrixClock();
  readonly scheduler = new MatrixScheduler(this.clock);
  readonly store = new MatrixStore(this.database.state, this.clock);
  readonly audit = new AuditService(this.database.prisma);
  readonly processor: MatrixProcessor;
  private readonly leaseTokens = new MatrixLeaseTokens();

  constructor(mode: MatrixMode) {
    this.processor = new MatrixProcessor(
      mode,
      this.database.state,
      this.audit,
    );
  }

  async accept(): Promise<string> {
    const task = await new TasksService(
      this.database.prisma,
    ).acceptPreparedTask(preparedTask());
    return task.id;
  }

  worker(processor: TaskAdmissionProcessor = this.processor): TaskAdmissionWorker {
    return new TaskAdmissionWorker(
      this.store,
      processor,
      this.scheduler,
      this.clock,
      this.leaseTokens,
      {
        ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
        leaseDurationMs: 100,
        renewIntervalMs: 25,
        pollIntervalMs: 50,
        queuedRetryAfterMs: 10,
        maxAttempts: 3,
        retryBaseDelayMs: 10,
        retryMaxDelayMs: 10,
        retryJitterRatio: 0,
        maxInFlight: 1,
      },
      undefined,
      this.audit,
    );
  }

  task(taskId: string): MatrixTask {
    const task = this.database.state.tasks.find(({ id }) => id === taskId);
    assert.ok(task);
    return task;
  }

  work(taskId: string): MatrixWork {
    const work = this.database.state.works.find(
      (candidate) => candidate.taskId === taskId,
    );
    assert.ok(work);
    return work;
  }

  expireCurrentLease(taskId: string): void {
    const leaseUntilMs = this.work(taskId).leaseUntilMs;
    assert.notEqual(leaseUntilMs, null);
    this.clock.advancePast(leaseUntilMs as number);
  }

  assertFinalInvariants(
    taskId: string,
    expectedWorkState: Extract<
      MatrixWorkState,
      'succeeded' | 'failed' | 'cancelled'
    >,
  ): void {
    assert.equal(this.database.state.tasks.length, 1, 'exactly one Task');
    assert.equal(this.database.state.works.length, 1, 'exactly one work item');
    assert.equal(this.work(taskId).state, expectedWorkState);
    assert.ok(this.processor.liveSandboxes.size <= 1, 'at most one sandbox');
    assert.ok(this.processor.slotOwners.size <= 1, 'at most one slot');
    assert.ok(
      this.processor.maxSimultaneousSlots <= 1,
      'slot high-water mark never exceeds one',
    );
    assert.ok(
      this.processor.slotAllocations <= 1,
      'replay reuses rather than allocates a second slot',
    );
    assert.equal(
      this.database.state.audits.has(`task.created:${taskId}`),
      true,
      'the atomic creation audit remains present',
    );
  }
}

test('durable admission crash matrix recovers every boundary without fixed sleeps', async (t) => {
  await t.test('pre-commit rollback leaves no Task/work and a later acceptance recovers once', async () => {
    const harness = new CrashMatrixHarness('success');
    harness.database.failAcceptanceAudit = true;
    await assert.rejects(
      harness.accept(),
      /simulated crash before acceptance commit/,
    );
    assert.equal(harness.database.state.tasks.length, 0);
    assert.equal(harness.database.state.works.length, 0);
    assert.equal(harness.database.state.audits.size, 0);

    harness.database.failAcceptanceAudit = false;
    const taskId = await harness.accept();
    assert.equal((await harness.worker().runOnce()).kind, 'succeeded');
    harness.assertFinalInvariants(taskId, 'succeeded');
    assert.equal(harness.processor.sandboxCreates, 1);
  });

  await t.test('post-commit/pre-wake work is recovered from the durable floor', async () => {
    const harness = new CrashMatrixHarness('success');
    const taskId = await harness.accept();
    assert.equal(harness.work(taskId).state, 'accepted');
    assert.equal(harness.processor.sandboxCreates, 0);

    // No local wake is issued. A fresh worker's database claim is the recovery
    // floor after the original process exits between commit and wake.
    assert.equal((await harness.worker().runOnce()).kind, 'succeeded');
    harness.assertFinalInvariants(taskId, 'succeeded');
    assert.equal(harness.processor.sandboxCreates, 1);
  });

  await t.test('active lease renewal excludes a contending worker', async () => {
    const harness = new CrashMatrixHarness('active-lease');
    const taskId = await harness.accept();
    const owner = harness.worker();
    const processing = owner.runOnce();
    await harness.processor.boundaryEntered.promise;

    harness.clock.advanceBy(25);
    harness.scheduler.runDue();
    await harness.store.firstRenewal.promise;
    assert.equal(harness.store.renewals, 1);
    assert.equal(
      (await harness.worker().runOnce()).kind,
      'idle',
      'a renewed lease cannot be stolen',
    );
    assert.equal(harness.processor.sandboxCreates, 1);
    assert.equal(harness.processor.liveSandboxes.size, 1);
    assert.equal(harness.processor.slotOwners.size, 1);

    harness.processor.releaseBoundary.resolve();
    assert.equal((await processing).kind, 'succeeded');
    harness.assertFinalInvariants(taskId, 'succeeded');
  });

  await t.test('post-sandbox/pre-complete crash readopts the idempotent sandbox', async () => {
    const harness = new CrashMatrixHarness('post-sandbox-crash');
    const taskId = await harness.accept();
    await assert.rejects(
      harness.worker().runOnce(),
      TaskAdmissionCoordinationError,
    );
    assert.equal(harness.work(taskId).state, 'running');
    assert.equal(harness.processor.sandboxCreates, 1);
    assert.equal(harness.processor.liveSandboxes.size, 1);
    assert.equal(harness.processor.slotOwners.size, 1);

    harness.expireCurrentLease(taskId);
    assert.equal((await harness.worker().runOnce()).kind, 'succeeded');
    harness.assertFinalInvariants(taskId, 'succeeded');
    assert.equal(harness.processor.processCalls, 2);
    assert.equal(
      harness.processor.sandboxCreates,
      1,
      'recovery reuses the provider-idempotent sandbox',
    );
    assert.equal(harness.processor.slotAllocations, 1);
    assert.equal(harness.processor.slotReuses, 1);
  });

  await t.test('real Worker, Guardrails, and router replay one physical sandbox after a post-create checkpoint crash', async () => {
    const harness = new CrashMatrixHarness('success');
    const taskId = await harness.accept();
    const task = harness.task(taskId);
    task.status = 'running';
    task.lifecycleVersion = 1;
    harness.store.crashNextCheckpoint('runtime_setup');

    const ownerStore = new InMemorySandboxRunOwnerStore();
    const physicalResources = new Set<string>();
    const providerContexts: SandboxProvisionContext[] = [];
    const readoptionTargets: unknown[] = [];
    let physicalCreates = 0;
    const connection = {
      taskId,
      baseUrl: `http://real-router/${taskId}`,
      wsUrl: `ws://real-router/${taskId}`,
    };
    const provider = {
      getSandboxMode: () => 'workspace-write' as const,
      getProviderCapabilities: () =>
        [
          'terminal.websocket',
          'lifecycle.readopt',
          'workspace.git.materialize',
          'resource.disk-size-gb',
        ] as const,
      async provision(context: SandboxProvisionContext) {
        providerContexts.push(context);
        const ownership = context.ownership;
        assert.ok(ownership);
        await context.externalBoundaryGuard?.({
          taskId: context.taskId,
          action: 'sandbox.create',
          position: 'before',
        });
        if (!physicalResources.has(ownership.resourceGeneration)) {
          physicalResources.add(ownership.resourceGeneration);
          physicalCreates += 1;
        }
        await context.onSandboxCreateObserved?.({
          kind: 'created',
          providerSandboxId: `physical:${ownership.resourceGeneration}`,
        });
        return connection;
      },
      async reattach(_taskId: string, target: unknown) {
        readoptionTargets.push(target);
        return connection;
      },
      async getSelectedSandboxRun() {
        const resourceGeneration = [...physicalResources][0];
        if (!resourceGeneration) return null;
        return {
          taskId,
          providerId: 'local-real-seam',
          provider: provider as never,
          providerSandboxId: `physical:${resourceGeneration}`,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
          connection,
        };
      },
      async teardownSandbox(
        _taskId: string,
        options?: {
          readonly ownership?: { readonly resourceGeneration: string };
        },
      ) {
        if (options?.ownership) {
          physicalResources.delete(options.ownership.resourceGeneration);
        }
        return { kind: 'found-and-cleaned' as const };
      },
      async readRolloutFromContainer() {
        return null;
      },
      async sandboxExists() {
        return physicalResources.size > 0;
      },
      async deliverWorkspaceChanges() {
        return { hadChanges: false, commitSha: null, error: null };
      },
    };
    const router = new SandboxProviderRouter(
      [
        defineLocalSandboxProvider({
          id: 'local-real-seam',
          provider: provider as never,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
        }),
      ],
      { ownerStore },
    );

    const first = realGuardrailsProcessor(
      router as unknown as SandboxProvider,
      harness.audit,
    );
    const firstFailure = await harness
      .worker(first.processor)
      .runOnce()
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(firstFailure instanceof TaskAdmissionCoordinationError);
    assert.match(
      String(
        firstFailure.cause instanceof Error
          ? firstFailure.cause.message
          : firstFailure.cause,
      ),
      /simulated checkpoint acknowledgement crash/,
      'the injected post-create checkpoint acknowledgement is the crash boundary',
    );
    assert.equal(harness.work(taskId).state, 'running');
    assert.equal(harness.work(taskId).stage, 'sandbox_creation');
    assert.equal(first.guardrails.runningCount, 1);
    assert.equal(physicalCreates, 1);
    assert.equal(physicalResources.size, 1);
    const ownerAfterCrash = await ownerStore.getSandboxRunOwner(taskId);
    assert.ok(ownerAfterCrash?.ownership);

    harness.expireCurrentLease(taskId);
    const recovered = realGuardrailsProcessor(
      router as unknown as SandboxProvider,
      harness.audit,
    );
    assert.equal(
      (await harness.worker(recovered.processor).runOnce()).kind,
      'succeeded',
    );

    assert.equal(harness.database.state.tasks.length, 1);
    assert.equal(harness.database.state.works.length, 1);
    assert.equal(harness.work(taskId).state, 'succeeded');
    assert.equal(providerContexts.length, 2);
    assert.equal(physicalCreates, 1, 'provider replay performs no second create');
    assert.equal(physicalResources.size, 1);
    assert.equal(recovered.guardrails.runningCount, 1);
    const firstOwnership = providerContexts[0]?.ownership;
    const recoveredOwnership = providerContexts[1]?.ownership;
    assert.ok(firstOwnership);
    assert.ok(recoveredOwnership);
    assert.notEqual(
      firstOwnership.ownerGeneration,
      recoveredOwnership.ownerGeneration,
    );
    assert.equal(
      recoveredOwnership.resourceGeneration,
      firstOwnership.resourceGeneration,
      'router transfers the lease owner while preserving the physical generation',
    );
    assert.equal(
      ownerAfterCrash.ownership.resourceGeneration,
      recoveredOwnership.resourceGeneration,
    );
    const activeOwners = await ownerStore.listActiveSandboxRunOwners();
    assert.equal(activeOwners.length, 1);
    assert.deepEqual(activeOwners[0]?.ownership, recoveredOwnership);
    assert.ok(
      readoptionTargets.some(
        (target) =>
          (target as { ownership?: { resourceGeneration?: string } })
            .ownership?.resourceGeneration ===
          recoveredOwnership.resourceGeneration,
      ),
      'selected-run replay resolves the same exact owner target',
    );
  });

  await t.test('retry plus terminal replay keeps one safe audit detail', async () => {
    const harness = new CrashMatrixHarness('retry-terminal-crash');
    const taskId = await harness.accept();
    assert.equal((await harness.worker().runOnce()).kind, 'retrying');
    assert.equal(harness.work(taskId).state, 'retrying');
    harness.clock.advancePast(harness.work(taskId).availableAtMs);

    await assert.rejects(
      harness.worker().runOnce(),
      TaskAdmissionCoordinationError,
    );
    assert.equal(harness.task(taskId).status, 'failed');
    assert.equal(harness.work(taskId).state, 'running');
    assert.equal(
      harness.database.state.audits.has(
        `task.provisioning.failed:${taskId}`,
      ),
      true,
    );
    const firstTerminalDetail = {
      ...harness.database.state.audits.get(
        `task.provisioning.failed:${taskId}`,
      ),
    };

    harness.expireCurrentLease(taskId);
    assert.equal((await harness.worker().runOnce()).kind, 'failed');
    harness.assertFinalInvariants(taskId, 'failed');
    assert.equal(harness.processor.sandboxCreates, 1);
    assert.equal(harness.processor.sandboxDeletes, 1);
    assert.equal(harness.processor.liveSandboxes.size, 0);
    assert.equal(harness.processor.slotOwners.size, 0);
    assert.equal(harness.processor.terminalSettlementCalls, 1);
    assert.deepEqual(
      harness.database.state.audits.get(
        `task.provisioning.failed:${taskId}`,
      ),
      firstTerminalDetail,
      'terminal replay preserves the first safe detail byte-for-byte',
    );

    const terminalRows = [...harness.database.state.audits.values()].filter(
      ({ dedupeKey }) =>
        dedupeKey === `task.failed:provisioning:${taskId}` ||
        dedupeKey === `task.provisioning.failed:${taskId}`,
    );
    assert.equal(terminalRows.length, 2);
    assert.match(
      terminalRows.find(({ dedupeKey }) =>
        dedupeKey.startsWith('task.provisioning.failed:'),
      )?.description ?? '',
      /尝试次数：2/,
      'recovery replay does not replace the first terminal detail',
    );
  });

  await t.test('cancellation fences the late worker and recovery settles cleanup once', async () => {
    const harness = new CrashMatrixHarness('cancellation');
    const taskId = await harness.accept();
    const owner = harness.worker();
    const processing = owner.runOnce();
    await harness.processor.boundaryEntered.promise;

    const task = harness.task(taskId);
    task.status = 'cancelled';
    task.lifecycleVersion += 1;
    owner.abortTask(taskId);
    assert.equal((await processing).kind, 'lease-lost');
    assert.equal(
      harness.database.state.audits.has(`task.cancelled:${taskId}`),
      false,
      'the process crashed after the cancelled CAS and before its audit write',
    );
    assert.equal(harness.processor.sandboxCreates, 1);
    assert.equal(
      harness.processor.sandboxDeletes,
      0,
      'a lease-lost worker cannot clean up before cancellation audit recovery',
    );
    assert.equal(harness.processor.liveSandboxes.size, 1);
    assert.equal(harness.processor.slotOwners.size, 1);

    harness.expireCurrentLease(taskId);
    assert.equal((await harness.worker().runOnce()).kind, 'cancelled');
    harness.assertFinalInvariants(taskId, 'cancelled');
    assert.equal(harness.processor.sandboxDeletes, 1);
    assert.equal(harness.processor.liveSandboxes.size, 0);
    assert.equal(harness.processor.slotOwners.size, 0);
    const cancellationRows = [...harness.database.state.audits.values()].filter(
      ({ dedupeKey }) => dedupeKey === `task.cancelled:${taskId}`,
    );
    assert.equal(cancellationRows.length, 1);
    assert.equal(cancellationRows[0]?.type, 'task.cancelled');
    assert.equal(
      cancellationRows[0]?.userId,
      null,
      'recovery is system-attributed because the operator actor was not persisted',
    );
  });

  // detach-workspace-clone 9.1: cross-track re-proof of the guardrails
  // scenario set over the merged parked-transfer machinery. Contention,
  // expired-lease, restart, and cancel keep their existing sub-tests above;
  // this scenario adds the parked lifecycle: slot release while parked,
  // exit-marker resume through the claim path only, attempt preservation,
  // real-GuardrailsService ownership re-stamp, stale-waker fencing at the
  // durable write point, and the bounded-ledger rule (per-poll progress never
  // enters the audit/diagnostic event ledger).
  await t.test('parked transfer parks without burning the slot, resumes through one re-stamped waker, and keeps the ledger bounded', async () => {
    const harness = new CrashMatrixHarness('success');
    const parkedTaskId = await harness.accept();
    const bystanderTaskId = await harness.accept();
    for (const id of [parkedTaskId, bystanderTaskId]) {
      const task = harness.task(id);
      task.status = 'running';
      task.lifecycleVersion = 1;
    }

    const probeQueue: TaskAdmissionParkedJobObservation[] = [
      {
        kind: 'alive',
        progress: {
          percent: null,
          receivedObjects: null,
          totalObjects: null,
          receivedBytes: null,
          throughputBytesPerSecond: null,
        },
      },
      {
        kind: 'alive',
        progress: {
          percent: 60,
          receivedObjects: 60,
          totalObjects: 100,
          receivedBytes: 4096,
          throughputBytesPerSecond: 1024,
        },
      },
      { kind: 'exited' },
    ];
    let killCalls = 0;
    const job: TaskAdmissionParkedJobPort = {
      async probe() {
        const next = probeQueue.shift();
        assert.ok(next, 'the parked loop probed more often than scripted');
        return next;
      },
      async kill() {
        killCalls += 1;
      },
    };
    const parkingProcessor: TaskAdmissionProcessor = {
      async process(context) {
        await context.lease.authorize();
        if (context.claim.taskId === parkedTaskId) {
          await context.lease.checkpoint('workspace_transfer');
          return { kind: 'parked', stage: 'workspace_transfer', job };
        }
        return { kind: 'succeeded' };
      },
    };

    const parkWorker = harness.worker(parkingProcessor);
    assert.equal((await parkWorker.runOnce()).kind, 'parked');
    const parkedWork = harness.work(parkedTaskId);
    const parkedGeneration = parkedWork.parkedLeaseOwner;
    assert.equal(parkedWork.state, 'parked');
    assert.equal(parkedWork.stage, 'workspace_transfer');
    assert.equal(parkedWork.attempt, 1, 'parking never burns the attempt');
    assert.equal(parkedGeneration, 'matrix-lease:1');

    // Slot release: with the transfer parked, the same worker path admits the
    // next accepted task instead of blocking on the in-flight clone.
    assert.equal((await parkWorker.runOnce()).kind, 'succeeded');
    assert.equal(harness.work(bystanderTaskId).state, 'succeeded');

    // Parked poll loop: alive observations extend the lease and persist the
    // progress snapshot; nothing enters the audit/diagnostic event ledger
    // (bounded-ceiling rule — the snapshot column is the only durable trace).
    const auditEntriesBeforePolling = harness.database.state.audits.size;
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    for (const expectedPercent of [null, 60]) {
      harness.clock.advanceBy(25);
      harness.scheduler.runDue();
      await flush();
      assert.equal(parkedWork.state, 'parked');
      assert.equal(
        (parkedWork.progressSnapshot as { percent: number | null } | null)
          ?.percent ?? null,
        expectedPercent,
        'indeterminate progress stays explicitly unknown, never 0%',
      );
    }
    assert.ok(
      parkedWork.leaseUntilMs !== null &&
        parkedWork.leaseUntilMs > harness.clock.value,
      'alive heartbeats extend the parked lease',
    );

    // Exit marker: the loop only expires the lease in place and wakes the
    // claim path — it never admits or settles by itself.
    harness.clock.advanceBy(25);
    harness.scheduler.runDue();
    await flush();
    assert.equal(parkedWork.state, 'parked', 'the parked loop settles nothing');
    assert.ok(
      parkedWork.leaseUntilMs !== null &&
        parkedWork.leaseUntilMs <= harness.clock.value,
      'job exit hands the row back through the expired-lease branch',
    );
    assert.equal(
      harness.database.state.audits.size,
      auditEntriesBeforePolling,
      'per-poll progress observations never become ledger events',
    );

    const auditKeysBeforeResume = new Set(
      harness.database.state.audits.keys(),
    );

    // Resume through the real GuardrailsService: the new claim carries the
    // parked generation and the durable conditional write re-stamps sandbox
    // ownership to the resuming lease token exactly once.
    const sandboxRunRow = {
      taskId: parkedTaskId,
      status: 'provisioning',
      ownerGeneration: parkedGeneration as string,
    };
    const scriptedGenerationReads: string[] = [];
    const restampWrites: Array<{
      readonly compare: string;
      readonly to: string;
      readonly count: number;
    }> = [];
    const prismaWithSandboxRun = {
      ...(harness.database.prisma as unknown as Record<string, unknown>),
      sandboxRun: {
        async findFirst() {
          const scripted = scriptedGenerationReads.shift();
          return { ownerGeneration: scripted ?? sandboxRunRow.ownerGeneration };
        },
        async updateMany({
          where,
          data,
        }: {
          where: { taskId: string; ownerGeneration: string };
          data: { ownerGeneration: string };
        }) {
          const matched =
            where.taskId === sandboxRunRow.taskId &&
            where.ownerGeneration === sandboxRunRow.ownerGeneration;
          if (matched) sandboxRunRow.ownerGeneration = data.ownerGeneration;
          const result = { count: matched ? 1 : 0 };
          restampWrites.push({
            compare: where.ownerGeneration,
            to: data.ownerGeneration,
            count: result.count,
          });
          return result;
        },
      },
    } as unknown as PrismaService;

    const ownerStore = new InMemorySandboxRunOwnerStore();
    const providerContexts: SandboxProvisionContext[] = [];
    const connection = {
      taskId: parkedTaskId,
      baseUrl: `http://real-router/${parkedTaskId}`,
      wsUrl: `ws://real-router/${parkedTaskId}`,
    };
    const provider = {
      getSandboxMode: () => 'workspace-write' as const,
      getProviderCapabilities: () =>
        [
          'terminal.websocket',
          'lifecycle.readopt',
          'workspace.git.materialize',
          'resource.disk-size-gb',
        ] as const,
      async provision(context: SandboxProvisionContext) {
        providerContexts.push(context);
        await context.onSandboxCreateObserved?.({
          kind: 'created',
          providerSandboxId: `physical:${context.ownership?.resourceGeneration}`,
        });
        return connection;
      },
      async reattach() {
        return connection;
      },
      async getSelectedSandboxRun() {
        const ownership = providerContexts.at(-1)?.ownership;
        if (!ownership) return null;
        return {
          taskId: parkedTaskId,
          providerId: 'local-real-seam',
          provider: provider as never,
          providerSandboxId: `physical:${ownership.resourceGeneration}`,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
          connection,
        };
      },
      async teardownSandbox() {
        return { kind: 'found-and-cleaned' as const };
      },
      async readRolloutFromContainer() {
        return null;
      },
      async sandboxExists() {
        return providerContexts.length > 0;
      },
      async deliverWorkspaceChanges() {
        return { hadChanges: false, commitSha: null, error: null };
      },
    };
    const router = new SandboxProviderRouter(
      [
        defineLocalSandboxProvider({
          id: 'local-real-seam',
          provider: provider as never,
          capabilities: [
            'terminal.websocket',
            'lifecycle.readopt',
            'workspace.git.materialize',
            'resource.disk-size-gb',
          ],
        }),
      ],
      { ownerStore },
    );
    const winner = realGuardrailsProcessor(
      router as unknown as SandboxProvider,
      harness.audit,
      prismaWithSandboxRun,
    );
    const resumedClaims: TaskAdmissionClaim[] = [];
    const resumeProcessor: TaskAdmissionProcessor = {
      process(context) {
        resumedClaims.push(context.claim);
        return winner.processor.process(context);
      },
      settleTerminalFailure(context, failure) {
        return winner.processor.settleTerminalFailure(context, failure);
      },
      recoverTerminal(context) {
        return winner.processor.recoverTerminal(context);
      },
    };
    assert.equal(
      (await harness.worker(resumeProcessor).runOnce()).kind,
      'succeeded',
    );
    assert.equal(resumedClaims.length, 1);
    const resumedClaim = resumedClaims[0];
    assert.ok(resumedClaim);
    assert.equal(resumedClaim.sourceState, 'parked');
    assert.equal(resumedClaim.parkedLeaseToken, parkedGeneration);
    assert.notEqual(resumedClaim.leaseToken, parkedGeneration);
    assert.equal(
      resumedClaim.attempt,
      1,
      'a park/resume cycle continues the same attempt',
    );
    assert.equal(harness.work(parkedTaskId).state, 'succeeded');
    assert.deepEqual(restampWrites, [
      {
        compare: parkedGeneration,
        to: resumedClaim.leaseToken,
        count: 1,
      },
    ]);
    assert.equal(sandboxRunRow.ownerGeneration, resumedClaim.leaseToken);
    assert.equal(providerContexts.length, 1);
    assert.equal(
      providerContexts[0]?.ownership?.ownerGeneration,
      resumedClaim.leaseToken,
      'the resumed worker provisions under its own re-stamped generation',
    );
    assert.equal(killCalls, 0, 'a healthy resume never kills the job');

    // Stale waker after re-claim: a second holder that observed the old
    // parked generation loses the conditional compare at the durable write
    // point, self-terminates before any provider boundary, and cannot steal
    // or tear down the winner's ownership.
    scriptedGenerationReads.push(parkedGeneration as string);
    const stale = realGuardrailsProcessor(
      router as unknown as SandboxProvider,
      harness.audit,
      prismaWithSandboxRun,
    );
    const parkedTask = harness.task(parkedTaskId);
    const staleContext: TaskAdmissionProcessorContext = {
      claim: {
        taskId: parkedTaskId,
        leaseToken: 'stale-waker-lease',
        leaseUntil: new Date(harness.clock.value + 1_000),
        sourceState: 'parked',
        attempt: 1,
        stage: 'workspace_transfer',
        causeCode: null,
        resolvedBranch: 'master',
        resourceSnapshot: { diskSizeGb: 8 },
        workspaceMaterializationDeadlineMs: 900_000,
        taskStatus: parkedTask.status,
        taskLifecycleVersion: parkedTask.lifecycleVersion,
        parkedLeaseToken: parkedGeneration,
      },
      lease: {
        currentTaskFence: () => ({
          status: parkedTask.status,
          lifecycleVersion: parkedTask.lifecycleVersion,
        }),
        beginTaskTransition: () => parkedTask.lifecycleVersion + 1,
        commitTaskTransition() {},
        rollbackTaskTransition() {},
        async authorize() {},
        async renew() {},
        async checkpoint() {},
      },
      signal: new AbortController().signal,
    };
    await assert.rejects(
      stale.processor.process(staleContext),
      TaskAdmissionLeaseLostError,
      'the stale waker fails the compare and self-terminates',
    );
    assert.deepEqual(
      restampWrites.at(-1),
      {
        compare: parkedGeneration,
        to: 'stale-waker-lease',
        count: 0,
      },
      'the losing write is rejected at the durable write point',
    );
    assert.equal(
      sandboxRunRow.ownerGeneration,
      resumedClaim.leaseToken,
      'the winning generation is preserved unmerged',
    );
    assert.equal(
      providerContexts.length,
      1,
      'the fenced waker never crosses the provider boundary',
    );
    assert.equal(harness.work(parkedTaskId).state, 'succeeded');
    // Bounded-ceiling rule: the resume adds only deduped per-stage lifecycle
    // entries for this attempt — never per-poll progress observations, and the
    // fenced stale waker adds nothing at all.
    const ledgerEntriesAddedByResume = [
      ...harness.database.state.audits.keys(),
    ].filter((dedupeKey) => !auditKeysBeforeResume.has(dedupeKey));
    assert.ok(ledgerEntriesAddedByResume.length > 0);
    for (const dedupeKey of ledgerEntriesAddedByResume) {
      assert.match(
        dedupeKey,
        new RegExp(`^task\\.provisioning:${parkedTaskId}:1:`, 'u'),
        'only attempt-1 stage lifecycle events may enter the ledger',
      );
    }
  });
});
