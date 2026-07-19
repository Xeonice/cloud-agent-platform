import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest } from 'node:http';
import test from 'node:test';

import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, type ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticEventSchema,
  type CreateTaskBody,
  type TaskResponse,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticCleanupSummary,
  type TaskProvisioningDiagnosticEvent,
  type TaskStatus,
} from '@cap/contracts';
import {
  InMemorySandboxRunOwnerStore,
  SandboxProvisioningStageError,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
  type SandboxPhysicalCleanupResult,
  type SandboxProvisionContext,
} from '@cap/sandbox';

import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import {
  GuardrailsService,
  type GuardrailsConfig,
} from '../guardrails/guardrails.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { ProvisionLookup } from '../sandbox/provision-lookup.port';
import type {
  RecordTaskProvisioningDiagnosticPrimary,
  TaskProvisioningDiagnosticAttemptContext,
  TaskProvisioningDiagnosticRecorderPort,
} from '../task-provisioning-diagnostics/task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsWriteGatePort } from '../task-provisioning-diagnostics/task-provisioning-diagnostics-write-gate.port';
import type { PreparedTaskCreate } from './prepared-task-create';
import {
  TasksService,
  type AdmissionTransitionResult,
  type IGuardrailsService,
} from './tasks.service';
import { TasksController } from './tasks.controller';

const ACTIVE_TASK_ID = '11111111-1111-4111-8111-111111111111';
const WAITER_TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const REPO_ID = '44444444-4444-4444-8444-444444444444';

const CREATE_BODY: CreateTaskBody = {
  prompt: 'continue independently of the HTTP request',
};

const TEST_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: USER_ID,
    githubId: null,
    login: null,
    name: 'Legacy request lifetime test',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};

@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest() as {
      operatorPrincipal?: OperatorPrincipal;
    };
    request.operatorPrincipal = TEST_PRINCIPAL;
    return true;
  }
}

const CONFIG: GuardrailsConfig = {
  maxConcurrentTasks: 1,
  defaultIdleTimeoutMs: null,
  circuitBreakerThreshold: 3,
  diagnosticWriteTimeoutMs: 50,
};

const PROVISION_LOOKUP: ProvisionLookup = {
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
    return CREATE_BODY.prompt;
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

type LegacyCleanupCase = Readonly<{
  name: string;
  physical: SandboxPhysicalCleanupResult | undefined;
  diagnosticState: 'failed' | 'pending';
  diagnosticCause: 'cleanup_failed' | 'cleanup_unconfirmed';
  physicalOutcome: 'failed' | 'indeterminate';
  completenessMarked: boolean;
}>;

const CLEANUP_CASES: readonly LegacyCleanupCase[] = [
  {
    name: 'failed',
    physical: {
      outcome: 'failed',
      proof: null,
      cause: 'cleanup_failed',
      retryable: true,
    },
    diagnosticState: 'failed',
    diagnosticCause: 'cleanup_failed',
    physicalOutcome: 'failed',
    completenessMarked: true,
  },
  {
    name: 'indeterminate',
    physical: undefined,
    diagnosticState: 'pending',
    diagnosticCause: 'cleanup_unconfirmed',
    physicalOutcome: 'indeterminate',
    completenessMarked: false,
  },
];

class LegacyLifecycleHarness {
  private readonly rows = new Map<
    string,
    { status: 'pending' | 'queued' | 'running' | 'terminal'; token?: string }
  >([
    [ACTIVE_TASK_ID, { status: 'pending' }],
    [WAITER_TASK_ID, { status: 'pending' }],
  ]);

  readonly transitions: string[] = [];

  async transitionForAdmission(
    taskId: string,
    next: 'queued' | 'running',
    _userId?: string,
    transitionToken?: string,
  ): Promise<AdmissionTransitionResult> {
    const row = this.rows.get(taskId);
    assert(row, `missing lifecycle fixture for ${taskId}`);
    if (
      (next === 'queued' && row.status !== 'pending') ||
      (next === 'running' && row.status !== 'pending' && row.status !== 'queued')
    ) {
      return 'superseded';
    }
    row.status = next;
    row.token = transitionToken;
    this.transitions.push(`${taskId}:${next}`);
    return 'transitioned';
  }

  async isAdmissionTransitionCurrent(
    taskId: string,
    next: 'queued' | 'running',
    transitionToken: string,
  ): Promise<boolean> {
    const row = this.rows.get(taskId);
    return row?.status === next && row.token === transitionToken;
  }

  markTerminal(taskId: string): void {
    const row = this.rows.get(taskId);
    assert(row);
    row.status = 'terminal';
  }

  status(taskId: string): string | undefined {
    return this.rows.get(taskId)?.status;
  }
}

class InMemoryDiagnosticRecorder
  implements TaskProvisioningDiagnosticRecorderPort
{
  private readonly contexts = new Map<
    string,
    TaskProvisioningDiagnosticAttemptContext
  >();

  readonly events: TaskProvisioningDiagnosticEvent[] = [];
  readonly primary = new Map<
    string,
    RecordTaskProvisioningDiagnosticPrimary[]
  >();
  readonly cleanup = new Map<
    string,
    TaskProvisioningDiagnosticCleanupSummary[]
  >();
  readonly completed = new Map<string, number>();

  async beginAttempt(input: {
    readonly taskId: string;
    readonly admissionMode: 'legacy' | 'durable';
  }) {
    const context: TaskProvisioningDiagnosticAttemptContext = Object.freeze({
      taskId: input.taskId,
      attemptId: randomUUID(),
      attempt: 1,
      admissionMode: input.admissionMode,
    });
    this.contexts.set(input.taskId, context);
    return { ok: true as const, value: context };
  }

  async resumeAttempt(input: {
    readonly taskId: string;
    readonly admissionMode: 'legacy' | 'durable';
    readonly attempt: number;
  }) {
    const context = this.contexts.get(input.taskId);
    if (
      !context ||
      context.admissionMode !== input.admissionMode ||
      context.attempt !== input.attempt
    ) {
      return {
        ok: false as const,
        code: 'attempt_not_found' as const,
        safeCause: 'coordination_failed' as const,
      };
    }
    const primary = this.primary.get(input.taskId)?.at(-1);
    const cleanup = this.cleanup.get(input.taskId)?.at(-1) ?? {
      state: 'not_required' as const,
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    };
    return {
      ok: true as const,
      value: {
        context,
        state: primary?.state ?? ('active' as const),
        providerFamily: 'unknown' as const,
        initialSequence: this.events.filter(
          (event) => event.taskId === input.taskId,
        ).length,
        primaryPersisted: primary !== undefined,
        cleanup,
      },
    };
  }

  async appendEvent(
    _context: TaskProvisioningDiagnosticAttemptContext,
    candidate: unknown,
  ) {
    const event = TaskProvisioningDiagnosticEventSchema.parse(candidate);
    this.events.push(event);
    return {
      ok: true as const,
      value: { event, replayed: false },
    };
  }

  async recordPrimary(
    context: TaskProvisioningDiagnosticAttemptContext,
    input: RecordTaskProvisioningDiagnosticPrimary,
  ) {
    const values = this.primary.get(context.taskId) ?? [];
    if (values.length > 0) {
      return { ok: true as const, value: activeAttempt(context, this.events) };
    }
    values.push(input);
    this.primary.set(context.taskId, values);
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  async recordCleanup(
    context: TaskProvisioningDiagnosticAttemptContext,
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ) {
    const values = this.cleanup.get(context.taskId) ?? [];
    const existing = values.at(-1) ?? {
      state: 'not_required' as const,
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    };
    if (sameDiagnosticCleanup(existing, cleanup)) {
      return { ok: true as const, value: activeAttempt(context, this.events) };
    }
    const initialPending =
      existing.state === 'not_required' &&
      cleanup.state === 'pending' &&
      cleanup.attemptCount === 0;
    const authoritativeTerminal =
      existing.state === 'pending' &&
      (cleanup.state === 'succeeded' || cleanup.state === 'failed') &&
      cleanup.attemptCount === existing.attemptCount &&
      cleanup.lastAttemptOutcome === existing.lastAttemptOutcome &&
      (cleanup.observedAt?.getTime() ?? null) ===
        (existing.observedAt?.getTime() ?? null);
    if (
      (this.completed.get(context.taskId) ?? 0) > 0 ||
      cleanup.attemptCount < existing.attemptCount ||
      existing.state === 'succeeded' ||
      existing.state === 'failed' ||
      (cleanup.attemptCount === existing.attemptCount &&
        !initialPending &&
        !authoritativeTerminal)
    ) {
      return {
        ok: false as const,
        code: 'immutable_evidence_conflict' as const,
        safeCause: 'coordination_failed' as const,
      };
    }
    values.push(cleanup);
    this.cleanup.set(context.taskId, values);
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  async markComplete(context: TaskProvisioningDiagnosticAttemptContext) {
    if ((this.completed.get(context.taskId) ?? 0) > 0) {
      return { ok: true as const, value: activeAttempt(context, this.events) };
    }
    const cleanup = this.cleanup.get(context.taskId)?.at(-1);
    if (
      !this.primary.get(context.taskId)?.at(-1) ||
      !cleanup ||
      cleanup.state === 'pending'
    ) {
      return {
        ok: false as const,
        code: 'incomplete_evidence' as const,
        safeCause: 'coordination_failed' as const,
      };
    }
    this.completed.set(
      context.taskId,
      (this.completed.get(context.taskId) ?? 0) + 1,
    );
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  async upsertPartialAttempt(context: TaskProvisioningDiagnosticAttemptContext) {
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  hasAttempt(taskId: string): boolean {
    return this.contexts.has(taskId);
  }
}

function sameDiagnosticCleanup(
  left: TaskProvisioningDiagnosticCleanupSummary,
  right: TaskProvisioningDiagnosticCleanupSummary,
): boolean {
  return (
    left.state === right.state &&
    left.cause === right.cause &&
    left.attemptCount === right.attemptCount &&
    left.lastAttemptOutcome === right.lastAttemptOutcome &&
    (left.observedAt?.getTime() ?? null) ===
      (right.observedAt?.getTime() ?? null)
  );
}

function activeAttempt(
  context: TaskProvisioningDiagnosticAttemptContext,
  events: readonly TaskProvisioningDiagnosticEvent[],
): TaskProvisioningDiagnosticAttempt {
  return {
    schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    id: context.attemptId,
    taskId: context.taskId,
    attempt: context.attempt,
    admissionMode: context.admissionMode,
    providerFamily: 'unknown',
    state: 'active',
    stage: 'provider_selection',
    coverage: 'partial',
    primary: null,
    cleanup: {
      state: 'not_required',
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    },
    eventCount: events.filter((event) => event.taskId === context.taskId).length,
    truncated: false,
    startedAt: new Date(0),
    finishedAt: null,
    completenessMarkedAt: null,
  };
}

interface LiveTaskCreateRequest {
  readonly request: ClientRequest;
  readonly socketClosed: Promise<void>;
  responseReceived(): boolean;
}

/** Issue the real controller route and retain a handle to its Node HTTP socket. */
function postTaskCreate(port: number): LiveTaskCreateRequest {
  const body = JSON.stringify(CREATE_BODY);
  const socketClosed = deferred<void>();
  let receivedResponse = false;
  const request = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: `/repos/${REPO_ID}/tasks`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    },
    (response) => {
      receivedResponse = true;
      response.resume();
    },
  );
  // `destroy()` is the intentional client-side disconnect under test.
  request.on('error', () => undefined);
  request.once('close', () => socketClosed.resolve(undefined));
  request.end(body);
  return {
    request,
    socketClosed: socketClosed.promise,
    responseReceived: () => receivedResponse,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not reached');
}

function makeStopRacePrisma(): {
  readonly prisma: PrismaService;
  readonly status: () => TaskStatus;
  readonly lifecycleVersion: () => number;
  readonly failureCode: () => string | null;
  readonly terminalWrites: readonly TaskStatus[];
} {
  const row = {
    id: ACTIVE_TASK_ID,
    repoId: REPO_ID,
    ownerUserId: USER_ID,
    prompt: CREATE_BODY.prompt,
    status: 'pending' as TaskStatus,
    lifecycleVersion: 0,
    queuedAdmissionToken: null as string | null,
    runningAdmissionToken: null as string | null,
    failureCode: null as string | null,
    failureAt: null as Date | null,
    failureExitCode: null as number | null,
    provisioningDiagnosticSchemaVersion:
      TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    provisioningDiagnosticNextAttempt: 2,
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [] as string[],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
    model: null,
    sandboxEnvironmentId: null,
    executionMode: 'interactive-pty',
    deliver: 'none',
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    admissionWork: null,
    sandboxRuns: [] as Array<{ providerId: string; metadata?: unknown }>,
    sandboxEnvironment: null,
    scheduleRun: null,
  };
  const terminalWrites: TaskStatus[] = [];
  const prisma = {
    taskAdmissionWork: {
      async findUnique() {
        return null;
      },
    },
    task: {
      async findUnique() {
        return {
          ...row,
          skills: [...row.skills],
          sandboxRuns: [...row.sandboxRuns],
        };
      },
      async updateMany({
        where,
        data,
      }: {
        where: {
          id: string;
          status?: TaskStatus;
          lifecycleVersion?: number;
          failureCode?: string | null;
        };
        data: {
          status?: TaskStatus;
          lifecycleVersion?: { increment: number };
          queuedAdmissionToken?: string;
          runningAdmissionToken?: string;
          failureCode?: string | null;
          failureAt?: Date | null;
          failureExitCode?: number | null;
        };
      }) {
        if (
          where.id !== row.id ||
          (where.status !== undefined && where.status !== row.status) ||
          (where.lifecycleVersion !== undefined &&
            where.lifecycleVersion !== row.lifecycleVersion) ||
          (where.failureCode !== undefined &&
            where.failureCode !== row.failureCode)
        ) {
          return { count: 0 };
        }
        if (data.status !== undefined) {
          row.status = data.status;
          if (
            data.status === 'completed' ||
            data.status === 'failed' ||
            data.status === 'cancelled' ||
            data.status === 'agent_failed_to_start'
          ) {
            terminalWrites.push(data.status);
          }
        }
        if (data.lifecycleVersion) {
          row.lifecycleVersion += data.lifecycleVersion.increment;
        }
        if (data.queuedAdmissionToken !== undefined) {
          row.queuedAdmissionToken = data.queuedAdmissionToken;
        }
        if (data.runningAdmissionToken !== undefined) {
          row.runningAdmissionToken = data.runningAdmissionToken;
        }
        if (data.failureCode !== undefined) row.failureCode = data.failureCode;
        if (data.failureAt !== undefined) row.failureAt = data.failureAt;
        if (data.failureExitCode !== undefined) {
          row.failureExitCode = data.failureExitCode;
        }
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;

  return {
    prisma,
    status: () => row.status,
    lifecycleVersion: () => row.lifecycleVersion,
    failureCode: () => row.failureCode,
    terminalWrites,
  };
}

test('legacy stop wins the Task CAS and settles a late physical create through the real provider', async (t) => {
  const store = makeStopRacePrisma();
  const diagnostics = new InMemoryDiagnosticRecorder();
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const createObserved = deferred<void>();
  const releaseProvisionFailure = deferred<void>();
  const liveSandboxes = new Set<string>();
  const physicalDeletes: string[] = [];
  const providerCleanupProbes: string[] = [];
  const providerSandboxId = `legacy-${ACTIVE_TASK_ID}`;
  t.after(() => releaseProvisionFailure.resolve(undefined));

  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: SandboxProvisionContext) {
      await ctx.externalBoundaryGuard?.({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      liveSandboxes.add(ctx.taskId);
      await ctx.onSandboxCreateObserved?.({
        kind: 'created',
        providerSandboxId,
      });
      createObserved.resolve(undefined);
      await releaseProvisionFailure.promise;
      throw new SandboxProvisioningStageError('runtime_setup');
    },
    async teardownSandbox(
      taskId: string,
    ): Promise<SandboxPhysicalCleanupResult> {
      providerCleanupProbes.push(taskId);
      if (!liveSandboxes.delete(taskId)) {
        return {
          outcome: 'succeeded',
          proof: 'already-absent',
          cause: null,
          retryable: false,
        };
      }
      physicalDeletes.push(taskId);
      return {
        outcome: 'succeeded',
        proof: 'found-and-cleaned',
        cause: null,
        retryable: false,
      };
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists(taskId: string) {
      return liveSandboxes.has(taskId);
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new SandboxProviderRouter(
    [
      defineLocalSandboxProvider({
        id: 'local',
        provider,
        capabilities: ['terminal.websocket'],
      }),
    ],
    { ownerStore },
  );
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    {
      destroyForSession() {},
    } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    CONFIG,
    PROVISION_LOOKUP,
    undefined,
    store.prisma,
    undefined,
    diagnostics,
    { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
  );
  const auditTransitions: TaskStatus[] = [];
  const audit = {
    async recordTransition(_taskId: string, next: TaskStatus) {
      auditTransitions.push(next);
    },
  } as unknown as AuditRecorderPort;
  const tasks = new TasksService(
    store.prisma,
    guardrails as unknown as IGuardrailsService,
    audit,
  );
  Object.assign(guardrails, { tasks });

  const admission = guardrails.admit(ACTIVE_TASK_ID, { userId: USER_ID });
  await createObserved.promise;
  assert.equal(store.status(), 'running');
  assert.equal(liveSandboxes.has(ACTIVE_TASK_ID), true);
  assert.equal(diagnostics.hasAttempt(ACTIVE_TASK_ID), true);

  const stopped = tasks.stop(ACTIVE_TASK_ID, USER_ID);
  await waitFor(() => store.status() === 'cancelled');
  assert.deepEqual(store.terminalWrites, ['cancelled']);
  assert.equal(store.lifecycleVersion(), 2);

  releaseProvisionFailure.resolve(undefined);
  assert.equal(await admission, 'running');
  const response = await stopped;

  assert.equal(response.status, 'cancelled');
  assert.equal(store.status(), 'cancelled');
  assert.deepEqual(store.terminalWrites, ['cancelled']);
  assert.deepEqual(auditTransitions, ['running', 'cancelled']);
  assert.ok(
    providerCleanupProbes.length >= 1,
    'terminal cleanup must cross the selected provider instead of synthesizing absence',
  );
  assert.deepEqual(
    physicalDeletes,
    [ACTIVE_TASK_ID],
    'the physical sandbox is deleted exactly once',
  );
  assert.equal(liveSandboxes.has(ACTIVE_TASK_ID), false);
  assert.equal(await provider.sandboxExists(ACTIVE_TASK_ID), false);

  assert.equal(await ownerStore.getSandboxRunOwner(ACTIVE_TASK_ID), null);
  assert.deepEqual(await ownerStore.listActiveSandboxRunOwners(), []);
  const authority = await router.getSandboxCleanupAuthority(ACTIVE_TASK_ID);
  assert.notEqual(authority.status, 'provisioning');
  assert.notEqual(authority.status, 'running');
  assert.notEqual(authority.status, 'deleting');
  assert.equal(authority.orphanState, 'none');
  assert.equal(authority.lastAttemptOutcome, 'succeeded');
  assert.ok(
    authority.lastAttemptProof === 'found-and-cleaned' ||
      authority.lastAttemptProof === 'already-absent',
  );

  const primary = diagnostics.primary.get(ACTIVE_TASK_ID) ?? [];
  assert.equal(primary.length, 1);
  assert.deepEqual(
    {
      state: primary[0]?.state,
      outcome: primary[0]?.primary.outcome,
      cause: primary[0]?.primary.cause,
    },
    { state: 'cancelled', outcome: 'cancelled', cause: 'cancelled' },
  );
  const cleanup = diagnostics.cleanup.get(ACTIVE_TASK_ID) ?? [];
  assert.equal(cleanup.length, 1);
  assert.deepEqual(
    {
      state: cleanup[0]?.state,
      cause: cleanup[0]?.cause,
      attemptCount: cleanup[0]?.attemptCount,
      lastAttemptOutcome: cleanup[0]?.lastAttemptOutcome,
    },
    {
      state: 'succeeded',
      cause: null,
      attemptCount: 1,
      lastAttemptOutcome: 'succeeded',
    },
  );
  assert.equal(diagnostics.completed.get(ACTIVE_TASK_ID), 1);
  assert.equal(guardrails.runningCount, 0);
});

test('two legacy replicas converge cancelled cleanup after the originating late create settles', async (t) => {
  const store = makeStopRacePrisma();
  const diagnostics = new InMemoryDiagnosticRecorder();
  const ownerStore = new InMemorySandboxRunOwnerStore();
  const createBoundaryEntered = deferred<void>();
  const releasePhysicalCreate = deferred<void>();
  const liveSandboxes = new Set<string>();
  const cleanupResults: SandboxPhysicalCleanupResult[] = [];
  const teardownDispositions: string[] = [];
  let lateObservationAccepted = false;
  let forceFailureAudits = 0;
  const auditTransitions: TaskStatus[] = [];
  t.after(() => releasePhysicalCreate.resolve(undefined));

  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision(ctx: SandboxProvisionContext) {
      await ctx.externalBoundaryGuard?.({
        taskId: ctx.taskId,
        action: 'sandbox.create',
        position: 'before',
      });
      createBoundaryEntered.resolve(undefined);
      await releasePhysicalCreate.promise;
      liveSandboxes.add(ctx.taskId);
      await ctx.onSandboxCreateObserved?.({
        kind: 'created',
        providerSandboxId: `legacy-${ctx.taskId}`,
      });
      lateObservationAccepted = true;
      return {
        taskId: ctx.taskId,
        baseUrl: `http://sandbox.test/${ctx.taskId}`,
        wsUrl: `ws://sandbox.test/${ctx.taskId}`,
      };
    },
    async teardownSandbox(
      taskId: string,
      options?: { disposition?: string },
    ): Promise<SandboxPhysicalCleanupResult> {
      teardownDispositions.push(options?.disposition ?? 'terminal-retain');
      const result: SandboxPhysicalCleanupResult = liveSandboxes.delete(taskId)
        ? {
            outcome: 'succeeded',
            proof: 'found-and-cleaned',
            cause: null,
            retryable: false,
          }
        : {
            outcome: 'succeeded',
            proof: 'already-absent',
            cause: null,
            retryable: false,
          };
      cleanupResults.push(result);
      return result;
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists(taskId: string) {
      return liveSandboxes.has(taskId);
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const entries = [
    defineLocalSandboxProvider({
      id: 'local',
      provider,
      capabilities: ['terminal.websocket'],
    }),
  ];
  const routerA = new SandboxProviderRouter(entries, { ownerStore });
  const routerB = new SandboxProviderRouter(entries, { ownerStore });
  const audit = {
    async recordTransition(_taskId: string, next: TaskStatus) {
      auditTransitions.push(next);
    },
    async recordForceFailed() {
      forceFailureAudits += 1;
    },
  } as unknown as AuditRecorderPort;
  const createReplica = (router: SandboxProviderRouter) => {
    const guardrails = new GuardrailsService(
      {} as ModuleRef,
      { destroyForSession() {} } as unknown as SessionCredentialsService,
      router as unknown as SandboxProvider,
      CONFIG,
      PROVISION_LOOKUP,
      audit,
      store.prisma,
      undefined,
      diagnostics,
      { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
    );
    const tasks = new TasksService(
      store.prisma,
      guardrails as unknown as IGuardrailsService,
      audit,
    );
    Object.assign(guardrails, { tasks });
    return { guardrails, tasks };
  };
  const replicaA = createReplica(routerA);
  const replicaB = createReplica(routerB);
  const replicaASemaphore = (
    replicaA.guardrails as unknown as {
      semaphore: { release(taskId: string): void };
    }
  ).semaphore;
  const releaseReplicaASlot =
    replicaASemaphore.release.bind(replicaASemaphore);
  let replicaASlotReleaseCalls = 0;
  replicaASemaphore.release = (taskId: string) => {
    if (taskId === ACTIVE_TASK_ID) replicaASlotReleaseCalls += 1;
    releaseReplicaASlot(taskId);
  };

  const admission = replicaA.guardrails.admit(ACTIVE_TASK_ID, {
    userId: USER_ID,
  });
  await createBoundaryEntered.promise;
  assert.equal(store.status(), 'running');
  assert.equal(replicaA.guardrails.runningCount, 1);
  const entered = await ownerStore.getSandboxRunOwner(ACTIVE_TASK_ID);
  assert.equal(entered?.status, 'provisioning');
  assert.equal(entered?.createState, 'entered');

  const stopped = await replicaB.tasks.stop(ACTIVE_TASK_ID, USER_ID);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(store.terminalWrites, ['cancelled']);
  assert.deepEqual(auditTransitions, ['running', 'cancelled']);
  assert.equal(replicaA.guardrails.runningCount, 1);
  const pendingAuthority = await routerB.getSandboxCleanupAuthority(
    ACTIVE_TASK_ID,
  );
  assert.equal(pendingAuthority.status, 'deleting');
  assert.equal(pendingAuthority.state, 'pending');
  const pendingOwner = await ownerStore.beginSandboxRunCleanup(ACTIVE_TASK_ID);
  assert.equal(pendingOwner.kind, 'authorized');
  assert.equal(
    pendingOwner.kind === 'authorized'
      ? pendingOwner.owner.createState
      : undefined,
    'entered',
  );
  assert.deepEqual(
    diagnostics.cleanup.get(ACTIVE_TASK_ID)?.map((cleanup) => ({
      state: cleanup.state,
      attemptCount: cleanup.attemptCount,
      lastAttemptOutcome: cleanup.lastAttemptOutcome,
      observedAt: cleanup.observedAt,
    })),
    [
      {
        state: 'pending',
        attemptCount: 0,
        lastAttemptOutcome: null,
        observedAt: null,
      },
    ],
    'replica B must not mark cleanup not-required while replica A owns an entered create fence',
  );
  assert.equal(
    diagnostics.completed.get(ACTIVE_TASK_ID) ?? 0,
    0,
    'pending cross-replica cleanup cannot complete diagnostics',
  );

  releasePhysicalCreate.resolve(undefined);
  assert.equal(await admission, 'running');
  await waitFor(
    () =>
      (diagnostics.cleanup.get(ACTIVE_TASK_ID)?.at(-1)?.state ?? null) ===
        'succeeded' &&
      (diagnostics.completed.get(ACTIVE_TASK_ID) ?? 0) === 1,
  );

  assert.equal(lateObservationAccepted, false);
  assert.equal(liveSandboxes.has(ACTIVE_TASK_ID), false);
  assert.deepEqual(
    cleanupResults.map(({ proof }) => proof),
    ['already-absent', 'found-and-cleaned'],
  );
  assert.deepEqual(teardownDispositions, [
    'terminal-retain',
    'superseded-remove',
  ]);
  assert.equal(await ownerStore.getSandboxRunOwner(ACTIVE_TASK_ID), null);
  const settledAuthority = await routerA.getSandboxCleanupAuthority(
    ACTIVE_TASK_ID,
  );
  assert.equal(settledAuthority.status, 'removed');
  assert.equal(settledAuthority.state, 'succeeded');
  assert.equal(settledAuthority.lastAttemptOutcome, 'succeeded');
  assert.equal(settledAuthority.lastAttemptProof, 'found-and-cleaned');

  const primary = diagnostics.primary.get(ACTIVE_TASK_ID) ?? [];
  assert.equal(primary.length, 1);
  assert.deepEqual(
    {
      state: primary[0]?.state,
      outcome: primary[0]?.primary.outcome,
      cause: primary[0]?.primary.cause,
    },
    { state: 'cancelled', outcome: 'cancelled', cause: 'cancelled' },
  );
  const cleanupEvidence = diagnostics.cleanup.get(ACTIVE_TASK_ID) ?? [];
  assert.deepEqual(
    cleanupEvidence.map((cleanup) => ({
      state: cleanup.state,
      attemptCount: cleanup.attemptCount,
      lastAttemptOutcome: cleanup.lastAttemptOutcome,
    })),
    [
      { state: 'pending', attemptCount: 0, lastAttemptOutcome: null },
      {
        state: 'succeeded',
        attemptCount: 1,
        lastAttemptOutcome: 'succeeded',
      },
    ],
  );
  assert.equal(
    cleanupEvidence.at(-1)?.observedAt?.getTime(),
    settledAuthority.lastAttemptObservedAt?.getTime(),
  );
  assert.equal(diagnostics.completed.get(ACTIVE_TASK_ID), 1);
  assert.equal(replicaA.guardrails.runningCount, 0);
  assert.equal(replicaB.guardrails.runningCount, 0);
  assert.equal(
    replicaASlotReleaseCalls,
    1,
    'the originating admission releases its exact local reservation once',
  );
  assert.equal(forceFailureAudits, 0);
  assert.deepEqual(store.terminalWrites, ['cancelled']);
});

test('terminal replica keeps an unavailable originating legacy invocation fenced and incomplete', async () => {
  const store = makeStopRacePrisma();
  const diagnostics = new InMemoryDiagnosticRecorder();
  const ownerStore = new InMemorySandboxRunOwnerStore();
  let teardownCalls = 0;
  let forceFailureAudits = 0;
  const auditTransitions: TaskStatus[] = [];
  const provider = {
    getSandboxMode: () => 'workspace-write' as const,
    getProviderCapabilities: () => ['terminal.websocket'] as const,
    async provision() {
      throw new Error('originating invocation is intentionally unavailable');
    },
    async teardownSandbox(): Promise<SandboxPhysicalCleanupResult> {
      teardownCalls += 1;
      return {
        outcome: 'succeeded',
        proof: 'already-absent',
        cause: null,
        retryable: false,
      };
    },
    async readRolloutFromContainer() {
      return null;
    },
    async sandboxExists() {
      return false;
    },
    async deliverWorkspaceChanges() {
      return { hadChanges: false, commitSha: null, error: null };
    },
  };
  const router = new SandboxProviderRouter(
    [
      defineLocalSandboxProvider({
        id: 'local',
        provider,
        capabilities: ['terminal.websocket'],
      }),
    ],
    { ownerStore },
  );
  const audit = {
    async recordTransition(_taskId: string, next: TaskStatus) {
      auditTransitions.push(next);
    },
    async recordForceFailed() {
      forceFailureAudits += 1;
    },
  } as unknown as AuditRecorderPort;
  const guardrails = new GuardrailsService(
    {} as ModuleRef,
    { destroyForSession() {} } as unknown as SessionCredentialsService,
    router as unknown as SandboxProvider,
    CONFIG,
    PROVISION_LOOKUP,
    audit,
    store.prisma,
    undefined,
    diagnostics,
    { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
  );
  const tasks = new TasksService(
    store.prisma,
    guardrails as unknown as IGuardrailsService,
    audit,
  );
  Object.assign(guardrails, { tasks });

  assert.equal(
    await tasks.transitionForAdmission(
      ACTIVE_TASK_ID,
      'running',
      USER_ID,
      '55555555-5555-4555-8555-555555555555',
    ),
    'transitioned',
  );
  const diagnosticAttempt = await diagnostics.beginAttempt({
    taskId: ACTIVE_TASK_ID,
    admissionMode: 'legacy',
  });
  assert.equal(diagnosticAttempt.ok, true);
  assert.equal(
    await ownerStore.beginSandboxRunCreate({
      taskId: ACTIVE_TASK_ID,
      providerId: 'local',
    }),
    true,
  );

  // This is only replica-local compatibility accounting. Releasing it must not
  // release or synthesize settlement for the persistent owner/create fence.
  guardrails.restoreDurableAdmissionSlot(ACTIVE_TASK_ID);
  const localSemaphore = (
    guardrails as unknown as {
      semaphore: { release(taskId: string): void };
    }
  ).semaphore;
  const releaseLocalSlot = localSemaphore.release.bind(localSemaphore);
  let localSlotReleaseCalls = 0;
  localSemaphore.release = (taskId: string) => {
    if (taskId === ACTIVE_TASK_ID) localSlotReleaseCalls += 1;
    releaseLocalSlot(taskId);
  };
  assert.equal(guardrails.runningCount, 1);

  const stopped = await tasks.stop(ACTIVE_TASK_ID, USER_ID);

  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(store.terminalWrites, ['cancelled']);
  assert.equal(store.failureCode(), null);
  assert.deepEqual(auditTransitions, ['running', 'cancelled']);
  assert.equal(forceFailureAudits, 0);
  assert.equal(teardownCalls, 1);

  const authority = await router.getSandboxCleanupAuthority(ACTIVE_TASK_ID);
  assert.equal(authority.ownershipKind, 'legacy');
  assert.equal(authority.status, 'deleting');
  assert.equal(authority.state, 'pending');
  assert.equal(authority.attemptCount, 0);
  assert.equal(authority.lastAttemptOutcome, null);
  assert.equal(authority.lastAttemptObservedAt, null);
  const persistentFence = await ownerStore.beginSandboxRunCleanup(
    ACTIVE_TASK_ID,
  );
  assert.equal(persistentFence.kind, 'authorized');
  assert.equal(
    persistentFence.kind === 'authorized'
      ? persistentFence.owner.createState
      : undefined,
    'entered',
  );
  assert.equal(
    persistentFence.kind === 'authorized'
      ? (persistentFence.owner.cleanupAttemptCount ?? 0)
      : undefined,
    0,
  );
  assert.equal(
    await ownerStore.beginSandboxRunCreate({
      taskId: ACTIVE_TASK_ID,
      providerId: 'local',
    }),
    false,
    'the persistent create/capacity fence remains non-borrowable without its originating invocation',
  );

  const primary = diagnostics.primary.get(ACTIVE_TASK_ID) ?? [];
  assert.equal(primary.length, 1);
  assert.deepEqual(
    {
      state: primary[0]?.state,
      outcome: primary[0]?.primary.outcome,
      cause: primary[0]?.primary.cause,
    },
    { state: 'cancelled', outcome: 'cancelled', cause: 'cancelled' },
  );
  assert.deepEqual(diagnostics.cleanup.get(ACTIVE_TASK_ID), [
    {
      state: 'pending',
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    },
  ]);
  assert.equal(diagnostics.completed.get(ACTIVE_TASK_ID) ?? 0, 0);
  assert.equal(
    guardrails.runningCount,
    0,
    'only the terminal replica local compatibility mirror is released',
  );
  assert.equal(localSlotReleaseCalls, 1);
});

for (const cleanupCase of CLEANUP_CASES) {
  test(`legacy request disconnect preserves task-owned diagnostics and ${cleanupCase.name} cleanup releases only the local slot`, async (t) => {
    const lifecycle = new LegacyLifecycleHarness();
    const diagnostics = new InMemoryDiagnosticRecorder();
    const ownerStore = new InMemorySandboxRunOwnerStore();
    const activeProvisionEntered = deferred<void>();
    const releaseActiveProvision = deferred<void>();
    const provisioned: string[] = [];
    const teardownCalls: string[] = [];

    const provider = {
      getSandboxMode: () => 'workspace-write' as const,
      getProviderCapabilities: () => ['terminal.websocket'] as const,
      async provision(ctx: SandboxProvisionContext) {
        provisioned.push(ctx.taskId);
        if (ctx.taskId === ACTIVE_TASK_ID) {
          activeProvisionEntered.resolve();
          await releaseActiveProvision.promise;
        }
        return {
          taskId: ctx.taskId,
          containerName: `legacy-${ctx.taskId}`,
          baseUrl: `http://sandbox.test/${ctx.taskId}`,
          wsUrl: `ws://sandbox.test/${ctx.taskId}`,
        };
      },
      async teardownSandbox(
        taskId: string,
      ): Promise<SandboxPhysicalCleanupResult | undefined> {
        teardownCalls.push(taskId);
        return taskId === ACTIVE_TASK_ID ? cleanupCase.physical : undefined;
      },
      async readRolloutFromContainer() {
        return null;
      },
      async sandboxExists() {
        return true;
      },
      async deliverWorkspaceChanges() {
        return { hadChanges: false, commitSha: null, error: null };
      },
    };
    const router = new SandboxProviderRouter(
      [
        defineLocalSandboxProvider({
          id: 'local',
          provider,
          capabilities: ['terminal.websocket'],
        }),
      ],
      { ownerStore },
    );
    const destroyedSessions: string[] = [];
    const unregisteredSessions: string[] = [];
    const auditTasks: string[] = [];
    const audit = {
      async recordTaskCreated(taskId: string) {
        auditTasks.push(taskId);
      },
    } as unknown as AuditRecorderPort;
    const guardrails = new GuardrailsService(
      {} as ModuleRef,
      {
        destroyForSession(taskId: string) {
          destroyedSessions.push(taskId);
        },
      } as unknown as SessionCredentialsService,
      router as unknown as SandboxProvider,
      CONFIG,
      PROVISION_LOOKUP,
      undefined,
      undefined,
      undefined,
      diagnostics,
      { isEnabled: () => true } as TaskProvisioningDiagnosticsWriteGatePort,
    );
    Object.assign(guardrails, {
      tasks: lifecycle,
      gateway: {
        openSession() {
          return { launchDecision: Promise.resolve({ kind: 'launched' as const }) };
        },
        unregisterSession(taskId: string) {
          unregisteredSessions.push(taskId);
        },
      },
    });

    const prisma = {
      taskAdmissionWork: {
        async findUnique() {
          return null;
        },
      },
      task: {
        async findUnique() {
          return { ownerUserId: USER_ID };
        },
      },
    } as unknown as PrismaService;
    const tasks = new TasksService(
      prisma,
      guardrails as unknown as IGuardrailsService,
      audit,
    );
    const prepared: PreparedTaskCreate = Object.freeze({
      repoId: REPO_ID,
      ownerUserId: USER_ID,
      body: Object.freeze({ ...CREATE_BODY }),
      runtime: 'codex',
      executionMode: 'interactive-pty',
      sandboxEnvironmentId: null,
      model: null,
      executionEnvironmentSnapshot: null,
      admissionMode: 'legacy',
    });
    const acceptedResponse = {
      id: ACTIVE_TASK_ID,
      repoId: REPO_ID,
      ownerUserId: USER_ID,
      prompt: CREATE_BODY.prompt,
      status: 'pending',
    } as unknown as TaskResponse;
    const httpCreateSettled = deferred<void>();
    let httpCreateError: unknown;
    let acceptanceCommitted = false;
    const realCreate = tasks.create.bind(tasks);
    Object.assign(tasks, {
      async prepareTaskCreate(
        ...args: Parameters<TasksService['prepareTaskCreate']>
      ) {
        assert.deepEqual(args, [
          REPO_ID,
          CREATE_BODY,
          'interactive-pty',
          USER_ID,
        ]);
        return prepared;
      },
      async acceptPreparedTask(
        input: PreparedTaskCreate,
      ): Promise<TaskResponse> {
        assert.equal(input, prepared);
        acceptanceCommitted = true;
        return acceptedResponse;
      },
      async create(...args: Parameters<TasksService['create']>) {
        try {
          return await realCreate(...args);
        } catch (error) {
          httpCreateError = error;
          throw error;
        } finally {
          httpCreateSettled.resolve();
        }
      },
    });
    // Keep Nest from invoking TasksService's application-bootstrap recovery in
    // this request-lifetime story. The controller still delegates its real
    // route call to the same production TasksService.create implementation.
    const controllerTasks = {
      create: (...args: Parameters<TasksService['create']>) =>
        tasks.create(...args),
    } as unknown as TasksService;

    const moduleRef = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
        { provide: TasksService, useValue: controllerTasks },
      ],
    }).compile();
    let app: INestApplication | undefined = moduleRef.createNestApplication({
      logger: false,
    });
    const testResources = { request: undefined as ClientRequest | undefined };
    t.after(async () => {
      releaseActiveProvision.resolve();
      testResources.request?.destroy();
      await app?.close();
      app = undefined;
    });
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number } | null;
    assert.ok(address?.port, 'Nest test server must bind an ephemeral port');

    const request = postTaskCreate(address.port);
    testResources.request = request.request;
    await activeProvisionEntered.promise;
    assert.equal(
      acceptanceCommitted,
      true,
      'the task row must be committed before the provider boundary',
    );
    assert.equal(diagnostics.hasAttempt(ACTIVE_TASK_ID), true);
    assert.equal(request.responseReceived(), false);

    request.request.destroy();
    await request.socketClosed;
    assert.equal(
      lifecycle.status(ACTIVE_TASK_ID),
      'running',
      'real HTTP socket closure must not mutate the task-owned lifecycle',
    );

    releaseActiveProvision.resolve();
    await httpCreateSettled.promise;
    assert.equal(httpCreateError, undefined);
    await waitFor(
      () => (diagnostics.primary.get(ACTIVE_TASK_ID)?.length ?? 0) === 1,
    );
    const primary = diagnostics.primary.get(ACTIVE_TASK_ID)?.[0];
    assert(primary);
    assert.deepEqual(
      {
        state: primary.state,
        stage: primary.stage,
        outcome: primary.primary.outcome,
        cause: primary.primary.cause,
        retryable: primary.primary.retryable,
        observedAtIsDate: primary.primary.observedAt instanceof Date,
      },
      {
        state: 'succeeded',
        stage: 'agent_launch',
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        observedAtIsDate: true,
      },
      'the detached launch decision must settle the original diagnostic attempt',
    );
    assert.deepEqual(provisioned, [ACTIVE_TASK_ID]);
    assert.equal(guardrails.runningCount, 1);

    assert.equal(
      await tasks.admitCreatedTask(WAITER_TASK_ID, CREATE_BODY, USER_ID),
      'legacy-admitted',
    );
    assert.equal(lifecycle.status(WAITER_TASK_ID), 'queued');
    assert.equal(guardrails.runningCount, 1);
    assert.equal(guardrails.queuedCount, 1);

    lifecycle.markTerminal(ACTIVE_TASK_ID);
    await guardrails.onTerminal(ACTIVE_TASK_ID);
    await waitFor(
      () =>
        lifecycle.status(WAITER_TASK_ID) === 'running' &&
        provisioned.includes(WAITER_TASK_ID),
    );

    assert.equal(guardrails.runningCount, 1);
    assert.equal(guardrails.queuedCount, 0);
    assert.deepEqual(provisioned, [ACTIVE_TASK_ID, WAITER_TASK_ID]);
    assert.deepEqual(teardownCalls, [ACTIVE_TASK_ID]);
    assert.deepEqual(destroyedSessions, [ACTIVE_TASK_ID]);
    assert.deepEqual(unregisteredSessions, [ACTIVE_TASK_ID]);
    assert.deepEqual(auditTasks, [ACTIVE_TASK_ID, WAITER_TASK_ID]);

    const authority = await router.getSandboxCleanupAuthority(ACTIVE_TASK_ID);
    assert.equal(authority.ownershipKind, 'legacy');
    assert.equal(authority.status, 'terminal');
    assert.equal(authority.state, 'not_required');
    assert.equal(authority.attemptCount, 1);
    assert.equal(authority.lastAttemptOutcome, cleanupCase.physicalOutcome);
    assert.notEqual(
      authority.status,
      'deleting',
      'legacy cleanup evidence must not manufacture reconciliation authority',
    );
    const reconciliationProbe = await router.claimSandboxCleanupOwnership(
      ACTIVE_TASK_ID,
      'lease:must-not-reopen-legacy-cleanup',
    );
    assert.equal(reconciliationProbe.kind, 'settled');
    assert.equal(reconciliationProbe.authority.status, 'terminal');

    const cleanup = diagnostics.cleanup.get(ACTIVE_TASK_ID);
    assert.equal(cleanup?.length, 1);
    assert.deepEqual(
      cleanup?.map((entry) => ({
        state: entry.state,
        cause: entry.cause,
        attemptCount: entry.attemptCount,
        lastAttemptOutcome: entry.lastAttemptOutcome,
        observedAtIsDate: entry.observedAt instanceof Date,
      })),
      [
        {
          state: cleanupCase.diagnosticState,
          cause: cleanupCase.diagnosticCause,
          attemptCount: 1,
          lastAttemptOutcome: cleanupCase.physicalOutcome,
          observedAtIsDate: true,
        },
      ],
    );
    assert.equal(
      diagnostics.completed.get(ACTIVE_TASK_ID) ?? 0,
      cleanupCase.completenessMarked ? 1 : 0,
    );

    const activeOwners = await ownerStore.listActiveSandboxRunOwners();
    assert.deepEqual(
      activeOwners.map((owner) => owner.taskId),
      [WAITER_TASK_ID],
      'the failed legacy cleanup retains evidence, not an active/deleting owner',
    );
  });
}
