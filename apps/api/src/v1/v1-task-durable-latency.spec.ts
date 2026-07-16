import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OperatorPrincipal } from '../auth/operator-principal';
import { PrismaService } from '../prisma/prisma.service';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import type { TaskBranchResolver } from '../forge/task-branch-resolver';
import {
  TasksService,
  type TaskAcceptanceClient,
} from '../tasks/tasks.service';
import type {
  TaskAdmissionGatePort,
  TaskAdmissionWakePort,
} from '../tasks/task-admission-gate';
import { IdempotencyService } from './idempotency.service';
import { V1TasksController } from './v1-tasks.controller';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-07-16T00:00:00.000Z');
const IDEMPOTENCY_KEY = 'durable-provider-barrier';

const PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: USER_ID,
    githubId: null,
    login: null,
    name: 'Durable V1 Test',
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
    request.operatorPrincipal = PRINCIPAL;
    return true;
  }
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

interface TaskRow extends Record<string, unknown> {
  id: string;
  repoId: string;
  ownerUserId: string | null;
  prompt: string;
  status: 'pending';
  lifecycleVersion: number;
  createdAt: Date;
  branch: string | null;
  strategy: string | null;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  runtime: string | null;
  model: string | null;
  sandboxEnvironmentId: string | null;
  executionMode: string | null;
  deliver: string | null;
}

interface AdmissionWorkRow extends Record<string, unknown> {
  taskId: string;
  state: 'accepted';
  stage: 'accepted';
  attempt: 0;
  resolvedBranch: string;
  resourceSnapshot: Record<string, unknown>;
  workspaceMaterializationDeadlineMs: number;
  updatedAt: Date;
}

interface IdempotencyRow {
  key: string;
  scopeUserId: string;
  requestHash: string;
  taskId: string;
  expiresAt: Date;
}

interface DatabaseState {
  readonly tasks: Map<string, TaskRow>;
  readonly works: Map<string, AdmissionWorkRow>;
  readonly keys: Map<string, IdempotencyRow>;
  readonly audits: Map<string, Record<string, unknown>>;
}

/**
 * Transaction-aware boundary used by the real TasksService and
 * IdempotencyService. The service callbacks see a private staged snapshot; only
 * a successful transaction publishes Task + work + audit + key together.
 */
class DurableCreateDatabase {
  private readonly state: DatabaseState = emptyState();

  readonly prisma = {
    repo: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === REPO_ID
          ? {
              id: REPO_ID,
              gitSource: 'https://gitee.example/acme/repo.git',
              defaultBranch: 'master',
            }
          : null,
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.readTask(where.id),
      // The real TasksService owns bootstrap recovery. This test database starts
      // empty, so its startup snapshot honestly contains no legacy orphan.
      findMany: async () => [],
    },
    taskAdmissionWork: {
      findUnique: async ({ where }: { where: { taskId: string } }) =>
        this.state.works.get(where.taskId) ?? null,
      // The request is issued only after Nest bootstrap, before any work exists.
      findMany: async () => [],
    },
    idempotencyKey: this.idempotencyDelegate(this.state.keys),
    $transaction: async <T>(
      operation: (client: TaskAcceptanceClient & {
        idempotencyKey: ReturnType<
          DurableCreateDatabase['idempotencyDelegate']
        >;
      }) => Promise<T>,
    ): Promise<T> => {
      const staged = cloneState(this.state);
      const result = await operation(this.transactionClient(staged));
      publishState(this.state, staged);
      return result;
    },
  } as unknown as PrismaService;

  get counts(): {
    readonly tasks: number;
    readonly works: number;
    readonly keys: number;
    readonly audits: number;
  } {
    return {
      tasks: this.state.tasks.size,
      works: this.state.works.size,
      keys: this.state.keys.size,
      audits: this.state.audits.size,
    };
  }

  private readTask(taskId: string): Record<string, unknown> | null {
    const task = this.state.tasks.get(taskId);
    if (!task) return null;
    const work = this.state.works.get(taskId);
    return {
      ...task,
      admissionWork: work
        ? {
            state: work.state,
            stage: work.stage,
            attempt: work.attempt,
            resolvedBranch: work.resolvedBranch,
            updatedAt: work.updatedAt,
          }
        : null,
      sandboxRuns: [],
      sandboxEnvironment: null,
      scheduleRun: null,
    };
  }

  private transactionClient(
    state: DatabaseState,
  ): TaskAcceptanceClient & {
    idempotencyKey: ReturnType<DurableCreateDatabase['idempotencyDelegate']>;
  } {
    return {
      task: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (state.tasks.has(TASK_ID)) throw uniqueConstraintError();
          const row: TaskRow = {
            id: TASK_ID,
            repoId: String(data.repoId),
            ownerUserId:
              typeof data.ownerUserId === 'string' ? data.ownerUserId : null,
            prompt: String(data.prompt),
            status: 'pending',
            lifecycleVersion: 0,
            failureCode: null,
            failureAt: null,
            failureExitCode: null,
            createdAt: CREATED_AT,
            branch: stringOrNull(data.branch),
            strategy: stringOrNull(data.strategy),
            skills: Array.isArray(data.skills)
              ? data.skills.map((value) => String(value))
              : [],
            idleTimeoutMs: numberOrNull(data.idleTimeoutMs),
            deadlineMs: numberOrNull(data.deadlineMs),
            runtime: stringOrNull(data.runtime),
            model: stringOrNull(data.model),
            sandboxEnvironmentId: stringOrNull(data.sandboxEnvironmentId),
            executionMode: stringOrNull(data.executionMode),
            deliver: stringOrNull(data.deliver),
            deliverStatus: null,
            branchPushed: null,
            commitSha: null,
            changeRequestUrl: null,
            changeRequestNumber: null,
            ...(data.executionEnvironmentSnapshot === undefined
              ? {}
              : {
                  executionEnvironmentSnapshot:
                    data.executionEnvironmentSnapshot,
                }),
          };
          state.tasks.set(row.id, row);
          return row as never;
        },
      } as never,
      taskAdmissionWork: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const taskId = String(data.taskId);
          if (state.works.has(taskId)) throw uniqueConstraintError();
          const row: AdmissionWorkRow = {
            taskId,
            state: 'accepted',
            stage: 'accepted',
            attempt: 0,
            resolvedBranch: String(data.resolvedBranch),
            resourceSnapshot:
              typeof data.resourceSnapshot === 'object' &&
              data.resourceSnapshot !== null
                ? { ...(data.resourceSnapshot as Record<string, unknown>) }
                : {},
            workspaceMaterializationDeadlineMs: Number(
              data.workspaceMaterializationDeadlineMs,
            ),
            updatedAt: CREATED_AT,
          };
          state.works.set(taskId, row);
          return row as never;
        },
      } as never,
      auditEvent: {
        upsert: async ({
          create,
        }: {
          create: Record<string, unknown>;
        }) => {
          const key = String(create.dedupeKey);
          const current = state.audits.get(key);
          if (current) return current as never;
          const row = { ...create };
          state.audits.set(key, row);
          return row as never;
        },
      } as never,
      idempotencyKey: this.idempotencyDelegate(state.keys),
    };
  }

  private idempotencyDelegate(store: Map<string, IdempotencyRow>) {
    return {
      findUnique: async ({
        where,
      }: {
        where: { scopeUserId_key: { scopeUserId: string; key: string } };
      }) => {
        const { scopeUserId, key } = where.scopeUserId_key;
        return store.get(compositeKey(scopeUserId, key)) ?? null;
      },
      create: async ({ data }: { data: IdempotencyRow }) => {
        const key = compositeKey(data.scopeUserId, data.key);
        if (store.has(key)) throw uniqueConstraintError();
        const row = { ...data };
        store.set(key, row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: {
          scopeUserId: string;
          key: string;
          requestHash?: string;
          taskId?: string;
          expiresAt?: { lte: Date };
        };
      }) => {
        const key = compositeKey(where.scopeUserId, where.key);
        const current = store.get(key);
        const matches =
          current !== undefined &&
          (where.requestHash === undefined ||
            current.requestHash === where.requestHash) &&
          (where.taskId === undefined || current.taskId === where.taskId) &&
          (where.expiresAt === undefined ||
            current.expiresAt <= where.expiresAt.lte);
        if (matches) store.delete(key);
        return { count: matches ? 1 : 0 };
      },
    };
  }
}

function emptyState(): DatabaseState {
  return {
    tasks: new Map(),
    works: new Map(),
    keys: new Map(),
    audits: new Map(),
  };
}

function cloneState(source: DatabaseState): DatabaseState {
  return {
    tasks: new Map(source.tasks),
    works: new Map(source.works),
    keys: new Map(source.keys),
    audits: new Map(source.audits),
  };
}

function publishState(target: DatabaseState, source: DatabaseState): void {
  replaceMap(target.tasks, source.tasks);
  replaceMap(target.works, source.works);
  replaceMap(target.keys, source.keys);
  replaceMap(target.audits, source.audits);
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function compositeKey(scopeUserId: string, key: string): string {
  return `${scopeUserId}\u0000${key}`;
}

function uniqueConstraintError(): Error & { code: 'P2002' } {
  const error = new Error('Unique constraint failed') as Error & {
    code: 'P2002';
  };
  error.code = 'P2002';
  return error;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

test(
  'keyed V1 create and exact replay return while real durable provisioning remains behind a barrier',
  { timeout: 10_000 },
  async (t) => {
    const database = new DurableCreateDatabase();
    const provisionEntered = deferred<void>();
    const releaseProvision = deferred<void>();
    const providerOperations: Promise<void>[] = [];
    let providerCalls = 0;
    let providerCompletions = 0;
    let wakeCalls = 0;

    const provider: Pick<SandboxProvider, 'provision'> = {
      async provision(context) {
        providerCalls += 1;
        assert.equal(context.taskId, TASK_ID);
        assert.equal(context.executionMode, 'headless-exec');
        provisionEntered.resolve();
        await releaseProvision.promise;
        return {
          taskId: context.taskId,
          baseUrl: 'http://sandbox.test/task',
          wsUrl: 'ws://sandbox.test/task/ws',
        };
      },
    };
    const wake: TaskAdmissionWakePort = {
      wake(taskId) {
        wakeCalls += 1;
        const operation = provider
          .provision({
            taskId,
            modelIntent: { kind: 'runtime-default' },
            runtimeId: 'codex',
            executionMode: 'headless-exec',
            environment: null,
            resources: Object.freeze({ diskSizeGb: 12 }),
            workspace: null,
            cloneSpec: null,
          })
          .then(() => {
            providerCompletions += 1;
          });
        providerOperations.push(operation);
      },
    };
    const gate: TaskAdmissionGatePort = { isEnabled: () => true };
    const environments = {
      async resolveTaskAdmission() {
        return Object.freeze({
          environment: null,
          providerId: 'boxlite',
          providerFamily: 'boxlite' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({ diskSizeGb: 12 }),
            workspaceMaterializationDeadlineMs: 900_000,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService;
    const branches = {
      async prepareForCreate() {
        return {
          repositoryUrl: 'https://gitee.example/acme/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          source: 'repo-default-branch' as const,
        };
      },
    } as unknown as TaskBranchResolver;
    const tasks = new TasksService(
      database.prisma,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      environments,
      undefined,
      undefined,
      gate,
      branches,
      wake,
    );
    let prepareCalls = 0;
    let acceptanceCalls = 0;
    const prepareTaskCreate = tasks.prepareTaskCreate.bind(tasks);
    tasks.prepareTaskCreate = async (
      ...args: Parameters<TasksService['prepareTaskCreate']>
    ) => {
      prepareCalls += 1;
      return prepareTaskCreate(...args);
    };
    const acceptPreparedTask = tasks.acceptPreparedTask.bind(tasks);
    tasks.acceptPreparedTask = async (
      ...args: Parameters<TasksService['acceptPreparedTask']>
    ) => {
      acceptanceCalls += 1;
      return acceptPreparedTask(...args);
    };

    const idempotency = new IdempotencyService(database.prisma);
    const moduleRef = await Test.createTestingModule({
      controllers: [V1TasksController],
      providers: [
        { provide: APP_GUARD, useClass: TestPrincipalGuard },
        { provide: TasksService, useValue: tasks },
        { provide: PrismaService, useValue: database.prisma },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();
    let app: INestApplication | undefined = moduleRef.createNestApplication();

    t.after(async () => {
      releaseProvision.resolve();
      await Promise.all(providerOperations);
      await app?.close();
      app = undefined;
    });

    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number } | null;
    assert.ok(address?.port, 'Nest test server must bind an ephemeral port');
    const url = `http://127.0.0.1:${address.port}/v1/tasks`;
    const requestBody = {
      repoId: REPO_ID,
      prompt: 'provision the verified master branch',
      sandboxEnvironmentId: null,
    };
    const create = () =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify(requestBody),
      });

    const firstResponsePromise = create();
    await provisionEntered.promise;
    const firstResponse = await firstResponsePromise;
    assert.equal(firstResponse.status, 201);
    const first = (await firstResponse.json()) as Record<string, unknown>;
    assert.equal(first.id, TASK_ID);
    assert.equal(first.status, 'pending');
    assert.deepEqual(first.provisioning, {
      state: 'accepted',
      stage: 'accepted',
      attempt: 0,
      resolvedBranch: 'master',
      updatedAt: CREATED_AT.toISOString(),
    });
    assert.equal(providerCompletions, 0, 'the provider barrier is still held');
    assert.deepEqual(database.counts, {
      tasks: 1,
      works: 1,
      keys: 1,
      audits: 1,
    });
    assert.deepEqual(
      { prepareCalls, acceptanceCalls, wakeCalls, providerCalls },
      {
        prepareCalls: 1,
        acceptanceCalls: 1,
        wakeCalls: 1,
        providerCalls: 1,
      },
    );

    const replayResponse = await create();
    assert.equal(replayResponse.status, 201);
    const replay = (await replayResponse.json()) as Record<string, unknown>;
    assert.deepEqual(replay, first, 'the replay returns the canonical winner');
    assert.equal(providerCompletions, 0, 'replay does not wait for provisioning');
    assert.deepEqual(database.counts, {
      tasks: 1,
      works: 1,
      keys: 1,
      audits: 1,
    });
    assert.deepEqual(
      { prepareCalls, acceptanceCalls, wakeCalls, providerCalls },
      {
        prepareCalls: 1,
        acceptanceCalls: 1,
        wakeCalls: 1,
        providerCalls: 1,
      },
      'an exact replay performs no current preparation, acceptance, wake, or provider call',
    );
  },
);
