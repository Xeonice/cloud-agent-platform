import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticEvent,
  type TaskProvisioningStage,
  type TaskStatus,
} from '@cap/contracts';
import type {
  SandboxConnection,
  SandboxProvisionContext,
} from '@cap/sandbox';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import {
  admissionStateFromTask,
  deriveTaskDiagnosticCoverage,
} from '../task-provisioning-diagnostics/task-provisioning-diagnostics.projection';
import type { TaskProvisioningDiagnosticRecorderPort } from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import { FencedTaskAdmissionProcessor } from '../task-admission/fenced-task-admission.processor';
import {
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
} from '../task-admission/task-admission-runtime';
import {
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionProcessor,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import {
  GuardrailsService,
  type GuardrailsConfig,
  type ITerminalGateway,
} from '../guardrails/guardrails.service';
import type { PreparedTaskCreate } from './prepared-task-create';
import { TasksService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const NOW_MS = Date.parse('2026-07-18T00:00:00.000Z');

interface StoryTaskRow extends Record<string, unknown> {
  readonly id: string;
  status: TaskStatus;
  lifecycleVersion: number;
  provisioningDiagnosticSchemaVersion: number;
  provisioningDiagnosticNextAttempt: number;
}

type StoryWorkState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface StoryWorkRow extends Record<string, unknown> {
  readonly taskId: string;
  state: StoryWorkState;
  stage: TaskProvisioningStage;
  attempt: number;
  availableAtMs: number;
  leaseOwner: string | null;
  leaseUntilMs: number | null;
  resolvedBranch: string;
  resourceSnapshot: Record<string, never>;
  workspaceMaterializationDeadlineMs: number;
  updatedAt: Date;
}

interface StoryState {
  task: StoryTaskRow | null;
  work: StoryWorkRow | null;
  readonly audits: Map<string, Record<string, unknown>>;
}

class StoryClock extends TaskAdmissionClock {
  private nowMs = NOW_MS;

  now(): Date {
    return new Date(this.nowMs);
  }

  advanceBy(delayMs: number): void {
    this.nowMs += delayMs;
  }
}

class CancellableNoopScheduler extends TaskAdmissionScheduler {
  schedule(_delayMs: number, _callback: () => void): TaskAdmissionTimer {
    return { cancel() {} };
  }
}

class SequentialLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `story-lease-${this.sequence}`;
  }
}

function acceptancePrisma(state: StoryState, clock: StoryClock): PrismaService {
  const clientFor = (target: StoryState) => ({
    task: {
      async create({ data }: { data: Record<string, unknown> }) {
        const task: StoryTaskRow = {
          id: TASK_ID,
          ...data,
          status: 'pending',
          lifecycleVersion: 0,
          provisioningDiagnosticSchemaVersion: Number(
            data.provisioningDiagnosticSchemaVersion,
          ),
          provisioningDiagnosticNextAttempt: Number(
            data.provisioningDiagnosticNextAttempt,
          ),
          createdAt: clock.now(),
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
        target.task = task;
        return task;
      },
    },
    taskAdmissionWork: {
      async create({ data }: { data: Record<string, unknown> }) {
        const work: StoryWorkRow = {
          taskId: String(data.taskId),
          state: 'accepted',
          stage: 'accepted',
          attempt: 0,
          availableAtMs: clock.now().getTime(),
          leaseOwner: null,
          leaseUntilMs: null,
          resolvedBranch: String(data.resolvedBranch),
          resourceSnapshot: {},
          workspaceMaterializationDeadlineMs: Number(
            data.workspaceMaterializationDeadlineMs,
          ),
          updatedAt: clock.now(),
        };
        target.work = work;
        return work;
      },
    },
    auditEvent: {
      async upsert({
        create,
      }: {
        create: Record<string, unknown> & { dedupeKey: string };
      }) {
        const retained = target.audits.get(create.dedupeKey) ?? create;
        target.audits.set(create.dedupeKey, retained);
        return retained;
      },
    },
  });

  const root = clientFor(state);
  return {
    ...root,
    async $transaction<T>(
      operation: (client: ReturnType<typeof clientFor>) => Promise<T>,
    ): Promise<T> {
      const staged: StoryState = {
        task: state.task === null ? null : { ...state.task },
        work: state.work === null ? null : { ...state.work },
        audits: new Map(state.audits),
      };
      const result = await operation(clientFor(staged));
      state.task = staged.task;
      state.work = staged.work;
      state.audits.clear();
      for (const [key, value] of staged.audits) state.audits.set(key, value);
      return result;
    },
  } as unknown as PrismaService;
}

function preparedTask(): PreparedTaskCreate {
  return {
    repoId: REPO_ID,
    ownerUserId: USER_ID,
    body: Object.freeze({ prompt: 'durable queue diagnostics story' }),
    runtime: 'codex',
    executionMode: 'interactive-pty',
    sandboxEnvironmentId: null,
    model: null,
    executionEnvironmentSnapshot: null,
    admissionMode: 'durable-v2',
    resolvedBranch: 'main',
    resourceSnapshot: Object.freeze({}),
    workspaceMaterializationDeadlineMs: 900_000,
  } as PreparedTaskCreate;
}

function taskFenceMatches(
  state: StoryState,
  request: TaskAdmissionAuthorityRequest,
): boolean {
  const task = state.task;
  return (
    task !== null &&
    request.taskFences.some(
      (fence) =>
        fence.status === task.status &&
        fence.lifecycleVersion === task.lifecycleVersion,
    )
  );
}

class StoryAdmissionStore extends TaskAdmissionStore {
  constructor(
    private readonly state: StoryState,
    private readonly clock: StoryClock,
  ) {
    super();
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    const task = this.state.task;
    const work = this.state.work;
    const nowMs = this.clock.now().getTime();
    if (
      task === null ||
      work === null ||
      !['accepted', 'queued', 'retrying'].includes(work.state) ||
      work.availableAtMs > nowMs
    ) {
      return null;
    }
    const sourceState = work.state as 'accepted' | 'queued' | 'retrying';
    if (sourceState !== 'queued') work.attempt += 1;
    work.state = 'running';
    work.leaseOwner = request.leaseToken;
    work.leaseUntilMs = nowMs + request.leaseDurationMs;
    work.updatedAt = this.clock.now();
    return {
      taskId: task.id,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(work.leaseUntilMs),
      sourceState,
      attempt: work.attempt,
      stage: work.stage,
      causeCode: null,
      resolvedBranch: work.resolvedBranch,
      resourceSnapshot: work.resourceSnapshot,
      workspaceMaterializationDeadlineMs:
        work.workspaceMaterializationDeadlineMs,
      taskStatus: task.status,
      taskLifecycleVersion: task.lifecycleVersion,
    };
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.ownsLiveLease(request) && taskFenceMatches(this.state, request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!(await this.authorize(request))) return false;
    const work = this.requireWork();
    work.leaseUntilMs = this.clock.now().getTime() + request.leaseDurationMs;
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    if (!(await this.authorize(request))) return false;
    this.requireWork().stage = request.stage;
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!(await this.authorize(request))) return false;
    const work = this.requireWork();
    work.state = request.settlement.state;
    work.stage = request.settlement.stage;
    work.leaseOwner = null;
    work.leaseUntilMs = null;
    if (
      request.settlement.state === 'queued' ||
      request.settlement.state === 'retrying'
    ) {
      work.availableAtMs =
        this.clock.now().getTime() + request.settlement.availableAfterMs;
    }
    work.updatedAt = this.clock.now();
    return true;
  }

  private ownsLiveLease(request: {
    readonly taskId: string;
    readonly leaseToken: string;
  }): boolean {
    const work = this.state.work;
    return (
      work !== null &&
      work.taskId === request.taskId &&
      work.state === 'running' &&
      work.leaseOwner === request.leaseToken &&
      work.leaseUntilMs !== null &&
      work.leaseUntilMs > this.clock.now().getTime()
    );
  }

  private requireWork(): StoryWorkRow {
    assert.ok(this.state.work);
    return this.state.work;
  }
}

class StoryDiagnosticRecorder {
  readonly beginInputs: unknown[] = [];
  readonly events: TaskProvisioningDiagnosticEvent[] = [];
  appendCalls = 0;

  constructor(private readonly state: StoryState) {}

  readonly port: TaskProvisioningDiagnosticRecorderPort = {
    beginAttempt: async (input) => {
      this.beginInputs.push(input);
      const task = this.state.task;
      assert.ok(task);
      assert.equal(input.expectedAttempt, task.provisioningDiagnosticNextAttempt);
      task.provisioningDiagnosticNextAttempt += 1;
      return {
        ok: true,
        value: {
          taskId: input.taskId,
          attemptId: ATTEMPT_ID,
          attempt: input.expectedAttempt ?? 1,
          admissionMode: input.admissionMode,
        },
      };
    },
    resumeAttempt: async () => ({
      ok: false,
      code: 'attempt_not_found',
      safeCause: 'coordination_failed',
    }),
    appendEvent: async (_context, candidate) => {
      this.appendCalls += 1;
      const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
      this.events.push(event);
      return { ok: true, value: { event, replayed: false } };
    },
    recordPrimary: async () => ({ ok: true, value: undefined as never }),
    recordCleanup: async () => ({ ok: true, value: undefined as never }),
    markComplete: async () => ({ ok: true, value: undefined as never }),
    upsertPartialAttempt: async () => ({
      ok: true,
      value: undefined as never,
    }),
  };
}

class SameClaimReplayProcessor implements TaskAdmissionProcessor {
  replayChecks = 0;

  constructor(private readonly fenced: FencedTaskAdmissionProcessor) {}

  process(context: TaskAdmissionProcessorContext) {
    const primary = this.fenced.process(context);
    const replay = this.fenced.process(context);
    assert.equal(replay, primary, 'the exact claim must reuse one processing promise');
    this.replayChecks += 1;
    return primary;
  }
}

function diagnosticCoverage(state: StoryState) {
  const task = state.task;
  const work = state.work;
  assert.ok(task);
  return deriveTaskDiagnosticCoverage({
    expectedSchemaVersion: task.provisioningDiagnosticSchemaVersion,
    taskStatus: task.status,
    admissionState: admissionStateFromTask({
      taskStatus: task.status,
      admissionWorkState: work?.state ?? null,
    }),
    attempts: [],
    eventsByAttempt: new Map(),
    hasCompaction: false,
    hasUnsupportedEvidence: false,
  });
}

test('durable acceptance stays not_started while queued, then promotion creates only attempt 1 and exact-claim replay is idempotent', async () => {
  const clock = new StoryClock();
  const state: StoryState = {
    task: null,
    work: null,
    audits: new Map(),
  };
  const prisma = acceptancePrisma(state, clock);
  const accepted = await new TasksService(prisma).acceptPreparedTask(
    preparedTask(),
  );
  const task = state.task;
  const work = state.work;
  assert.ok(task);
  assert.ok(work);
  assert.ok(accepted.provisioning);
  assert.equal(accepted.provisioning.attempt, 0);
  assert.equal(work.attempt, 0);
  assert.equal(task.provisioningDiagnosticNextAttempt, 1);
  assert.equal(diagnosticCoverage(state), 'not_started');
  assert.equal(state.audits.size, 1);

  const diagnostics = new StoryDiagnosticRecorder(state);
  const connection: SandboxConnection = {
    taskId: TASK_ID,
    baseUrl: 'http://sandbox.story.test/task',
    wsUrl: 'ws://sandbox.story.test/task/ws',
  };
  let provisionCalls = 0;
  const sandbox = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['terminal.websocket'],
    async provision(_context: SandboxProvisionContext) {
      provisionCalls += 1;
      return connection;
    },
    async teardownSandbox() {},
  } as unknown as SandboxProvider;
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
  const guardrailsConfig: GuardrailsConfig = {
    maxConcurrentTasks: 1,
    defaultIdleTimeoutMs: null,
    circuitBreakerThreshold: 3,
  };
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    sandbox,
    guardrailsConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    diagnostics.port,
    { isEnabled: () => true } satisfies TaskProvisioningDiagnosticsWriteGatePort,
  );
  const moduleRef = {
    get(token: unknown) {
      if (token === GuardrailsService) return guardrails;
      throw new Error(`unexpected story module token: ${String(token)}`);
    },
  } as unknown as ModuleRef;

  let reservationCalls = 0;
  Object.assign(guardrails, {
    tasks: {
      async reserveDurableAdmissionCapacity(input: {
        readonly expectedStatus: 'pending' | 'queued';
        readonly expectedLifecycleVersion: number;
      }) {
        reservationCalls += 1;
        const currentTask = state.task;
        assert.ok(currentTask);
        assert.equal(currentTask.status, input.expectedStatus);
        assert.equal(
          currentTask.lifecycleVersion,
          input.expectedLifecycleVersion,
        );
        const promoted = reservationCalls === 2;
        currentTask.status = promoted ? 'running' : 'queued';
        currentTask.lifecycleVersion += 1;
        return {
          outcome: promoted ? ('running' as const) : ('queued' as const),
          status: currentTask.status as 'queued' | 'running',
          lifecycleVersion: currentTask.lifecycleVersion,
          transitioned: true,
        };
      },
    },
    gateway,
    armDurableRuntime: async () => {},
    resolveProvisionPlan: async () => ({
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
    }),
    resolveSelectedRunStrict: async () => ({
      connection,
      owner: {
        taskId: TASK_ID,
        providerId: 'story-provider',
        providerSandboxId: TASK_ID,
        ownership: {
          ownerGeneration: 'story-lease-2',
          resourceGeneration: 'story-resource-generation',
        },
        status: 'running',
      },
    }),
  });

  const replayingProcessor = new SameClaimReplayProcessor(
    new FencedTaskAdmissionProcessor(moduleRef),
  );
  const worker = new TaskAdmissionWorker(
    new StoryAdmissionStore(state, clock),
    replayingProcessor,
    new CancellableNoopScheduler(),
    clock,
    new SequentialLeaseTokens(),
    {
      leaseDurationMs: 60_000,
      renewIntervalMs: 30_000,
      pollIntervalMs: 60_000,
      queuedRetryAfterMs: 1_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 1_000,
      retryJitterRatio: 0,
      maxInFlight: 1,
    },
  );

  assert.equal((await worker.runOnce()).kind, 'queued');
  assert.equal(state.work?.state, 'queued');
  assert.equal(state.work?.attempt, 1);
  assert.equal(diagnostics.beginInputs.length, 0);
  assert.equal(diagnostics.events.length, 0);
  assert.equal(provisionCalls, 0);
  assert.equal(diagnosticCoverage(state), 'not_started');

  clock.advanceBy(1_000);
  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.equal(state.work?.state, 'succeeded');
  assert.equal(state.work?.attempt, 1, 'queued promotion preserves attempt 1');
  assert.equal(reservationCalls, 2);
  assert.equal(replayingProcessor.replayChecks, 2);
  assert.equal(diagnostics.beginInputs.length, 1);
  assert.deepEqual(diagnostics.beginInputs, [
    {
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 1,
      providerFamily: 'unknown',
      stage: 'provider_selection',
    },
  ]);
  assert.equal(task.provisioningDiagnosticNextAttempt, 2);
  assert.equal(provisionCalls, 1);
  assert.ok(diagnostics.events.length > 0);
  assert.equal(diagnostics.appendCalls, diagnostics.events.length);
  assert.equal(
    new Set(diagnostics.events.map((event) => event.idempotencyKey)).size,
    diagnostics.events.length,
    'same-claim replay must not duplicate a diagnostic event',
  );
  assert.equal(state.audits.size, 1, 'replay does not duplicate acceptance audit');
  assert.equal(
    task.provisioningDiagnosticSchemaVersion,
    TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  );
});
