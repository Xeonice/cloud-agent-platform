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
} from '@cap/contracts';
import {
  InMemorySandboxRunOwnerStore,
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

  async resumeAttempt() {
    return {
      ok: false as const,
      code: 'attempt_not_found' as const,
      safeCause: 'coordination_failed' as const,
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
    values.push(input);
    this.primary.set(context.taskId, values);
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  async recordCleanup(
    context: TaskProvisioningDiagnosticAttemptContext,
    cleanup: TaskProvisioningDiagnosticCleanupSummary,
  ) {
    const values = this.cleanup.get(context.taskId) ?? [];
    values.push(cleanup);
    this.cleanup.set(context.taskId, values);
    return { ok: true as const, value: activeAttempt(context, this.events) };
  }

  async markComplete(context: TaskProvisioningDiagnosticAttemptContext) {
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
