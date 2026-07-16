import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  InMemorySandboxRunOwnerStore,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
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
import {
  TaskAdmissionCoordinationError,
  type TaskAdmissionProcessorContext,
} from '../task-admission/task-admission.types';
import type { IGuardrailsService } from './tasks.service';
import { TasksService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = 'lease:terminal-cleanup';
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
  assert.equal(authorizations, 2);
  assert.deepEqual(
    [...auditRows.values()].map((row) => row.type),
    ['task.failed', 'task.provisioning.failed:provisioning_unknown'],
  );
  assert.equal(auditRows.size, 2);

  await guardrails.recoverDurableTerminalAdmission(recoveryContext);
  assert.equal(guardrails.runningCount, 0);
  assert.equal(providerTeardownCalls, 1);
  assert.equal(lateCreatorDeletes, 1);
  assert.equal(auditRows.size, 2, 'recovery replay keeps terminal audit stable');
  assert.deepEqual(destroyedSessions, [TASK_ID, TASK_ID]);
});
