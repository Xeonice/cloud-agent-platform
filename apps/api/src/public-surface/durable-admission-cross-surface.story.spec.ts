import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModuleRef } from '@nestjs/core';
import {
  RepoResponseSchema,
  TaskResponseSchema,
  type TaskProvisioningStage,
  type TaskStatus,
  type TaskResponse,
} from '@cap/contracts';
import {
  BoxLiteSandboxProvider,
  FakeBoxLiteClient,
  InMemorySandboxRunOwnerStore,
  SandboxProviderRouter,
  defineLocalSandboxProvider,
  materializeSandboxGitWorkspaceStaged,
  readBoxLiteProviderConfig,
} from '@cap/sandbox';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { SessionCredentialsService } from '../creds/session-credentials.service';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { GiteeForge } from '../forge/gitee-forge';
import { GithubForge } from '../forge/github-forge';
import { GitlabForge } from '../forge/gitlab-forge';
import {
  RemoteRefsCommandRunner,
  type RemoteRefsCommandRequest,
  type RemoteRefsCommandResult,
} from '../forge/remote-refs-command-runner';
import { GitRemoteRefsProbe } from '../forge/remote-refs-probe';
import { NodeRemoteRefsSecretStore } from '../forge/remote-refs-secret-store';
import { TaskBranchResolver } from '../forge/task-branch-resolver';
import {
  GuardrailsService,
  TERMINAL_GATEWAY_TOKEN,
  type GuardrailsConfig,
  type ITerminalGateway,
} from '../guardrails/guardrails.service';
import { McpServerFactory } from '../mcp/mcp.server';
import { PrismaService } from '../prisma/prisma.service';
import { ReposController } from '../repos/repos.controller';
import { ReposService } from '../repos/repos.service';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import { PrismaProvisionLookup } from '../sandbox/prisma-provision-lookup';
import type { SandboxProvider } from '../sandbox/sandbox-provider.port';
import { encryptToStored } from '../settings/secret-storage';
import { FencedTaskAdmissionProcessor } from '../task-admission/fenced-task-admission.processor';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  RandomTaskAdmissionLeaseTokenFactory,
  SystemTaskAdmissionClock,
  SystemTaskAdmissionScheduler,
} from '../task-admission/task-admission-runtime';
import {
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import { TasksController } from '../tasks/tasks.controller';
import type {
  IGuardrailsService,
  TaskAcceptanceClient,
} from '../tasks/tasks.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskAdmissionGatePort } from '../tasks/task-admission-gate';
import { IdempotencyService } from '../v1/idempotency.service';
import { V1TasksController } from '../v1/v1-tasks.controller';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const REPOSITORY_URL =
  'https://forge.example.test:8443/acme/private-repository.git';
const NORMALIZED_FORGE_HOST = 'forge.example.test:8443';
const DEFAULT_BRANCH = 'master';
const CREATED_AT = new Date('2026-07-16T00:00:00.000Z');
const WORKSPACE_DEADLINE_MS = 900_000;
const DISK_SIZE_GB = 8;
const FORGE_TOKEN = 'story-private-forge-token';
const ENCRYPTION_KEY = '11'.repeat(32);

const PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    id: OWNER_ID,
    githubId: null,
    login: null,
    name: 'Cross-surface owner',
    avatarUrl: null,
    allowed: true,
    role: 'member',
    mustChangePassword: false,
  },
};

const REQUEST = { operatorPrincipal: PRINCIPAL } as AuthenticatedRequest;

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

interface CloneBarrier {
  readonly entered: Deferred<void>;
  readonly release: Deferred<void>;
  released: boolean;
}

function cloneBarrier(): CloneBarrier {
  return {
    entered: deferred<void>(),
    release: deferred<void>(),
    released: false,
  };
}

interface StoryTaskRow extends Record<string, unknown> {
  readonly id: string;
  readonly repoId: string;
  readonly ownerUserId: string | null;
  readonly prompt: string;
  status: TaskStatus;
  lifecycleVersion: number;
  readonly createdAt: Date;
  readonly branch: string | null;
  readonly strategy: string | null;
  readonly skills: string[];
  readonly idleTimeoutMs: number | null;
  readonly deadlineMs: number | null;
  readonly runtime: string | null;
  readonly model: string | null;
  readonly sandboxEnvironmentId: string | null;
  readonly executionMode: string | null;
  readonly deliver: string | null;
  failureCode: string | null;
  failureAt: Date | null;
  failureExitCode: number | null;
}

interface StoryAdmissionWork {
  readonly taskId: string;
  state:
    | 'accepted'
    | 'queued'
    | 'running'
    | 'retrying'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  stage: TaskProvisioningStage;
  attempt: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  causeCode: string | null;
  readonly resolvedBranch: string;
  readonly resourceSnapshot: Record<string, unknown>;
  readonly workspaceMaterializationDeadlineMs: number;
  updatedAt: Date;
  readonly stageTrace: TaskProvisioningStage[];
}

interface StoryRepoRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly gitSource: string;
  readonly createdAt: Date;
  readonly description: string | null;
  defaultBranch: string | null;
  readonly branchCount: number | null;
  readonly updatedAt: Date | null;
  readonly githubId: string | null;
  readonly gitlabProjectId: string | null;
  readonly isDefault: boolean;
  readonly forge: string | null;
}

interface StoryIdempotencyRow {
  readonly key: string;
  readonly scopeUserId: string;
  readonly requestHash: string;
  readonly taskId: string;
  readonly expiresAt: Date;
}

interface CredentialLookup {
  readonly userId: string;
  readonly kind: string;
  readonly host: string;
}

interface StoryState {
  readonly repos: Map<string, StoryRepoRow>;
  readonly tasks: Map<string, StoryTaskRow>;
  readonly works: Map<string, StoryAdmissionWork>;
  readonly idempotency: Map<string, StoryIdempotencyRow>;
  readonly audits: Map<string, Record<string, unknown>>;
}

class StoryDatabase {
  readonly state: StoryState = emptyStoryState();
  readonly credentialLookups: CredentialLookup[] = [];
  private taskSequence = 0;
  private auditSequence = 0;
  private readonly tokenCiphertext: string;

  readonly prisma: PrismaService;

  constructor() {
    this.tokenCiphertext = encryptToStored(FORGE_TOKEN, {
      CODEX_CRED_ENC_KEY: ENCRYPTION_KEY,
    });
    this.prisma = this.rootClient() as unknown as PrismaService;
  }

  task(taskId: string): StoryTaskRow {
    const task = this.state.tasks.get(taskId);
    assert.ok(task, `missing task ${taskId}`);
    return task;
  }

  work(taskId: string): StoryAdmissionWork {
    const work = this.state.works.get(taskId);
    assert.ok(work, `missing work ${taskId}`);
    return work;
  }

  private rootClient(): Record<string, unknown> {
    return {
      ...this.clientFor(this.state),
      accountSettings: {
        findUnique: async () => ({ defaultSandboxEnvironmentId: null }),
      },
      systemSettings: {
        findFirst: async () => null,
        findUnique: async () => null,
      },
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === OWNER_ID ? { id: OWNER_ID } : null,
      },
      forgeConnection: {
        findUnique: async ({ where }: { where: { host: string } }) =>
          where.host === NORMALIZED_FORGE_HOST
            ? {
                host: NORMALIZED_FORGE_HOST,
                kind: 'gitee',
                apiBaseUrl: `https://${NORMALIZED_FORGE_HOST}/api/v5`,
              }
            : null,
      },
      forgeCredential: {
        findUnique: async ({
          where,
        }: {
          where: {
            userId_kind_host: CredentialLookup;
          };
        }) => {
          const lookup = { ...where.userId_kind_host };
          this.credentialLookups.push(lookup);
          return lookup.userId === OWNER_ID &&
            lookup.kind === 'gitee' &&
            lookup.host === NORMALIZED_FORGE_HOST
            ? { tokenCiphertext: this.tokenCiphertext }
            : null;
        },
        findFirst: async () => {
          assert.fail('exact-host credentials must not use legacy fallback');
        },
      },
      $transaction: async <T>(
        operation: (client: TaskAcceptanceClient) => Promise<T>,
      ): Promise<T> => {
        const staged = cloneStoryState(this.state);
        const result = await operation(
          this.clientFor(staged) as unknown as TaskAcceptanceClient,
        );
        publishStoryState(this.state, staged);
        return result;
      },
      $executeRaw: async (query: unknown) =>
        this.executeRootStatement(this.state, query),
    };
  }

  private clientFor(state: StoryState): Record<string, unknown> {
    return {
      repo: this.repoDelegate(state),
      task: this.taskDelegate(state),
      taskAdmissionWork: this.workDelegate(state),
      idempotencyKey: this.idempotencyDelegate(state),
      auditEvent: this.auditDelegate(state),
      systemSettings: {
        findUnique: async () => null,
      },
      $queryRaw: async (query: unknown) => this.queryRows(state, query),
      $executeRaw: async (query: unknown) =>
        this.executeTransactionStatement(state, query),
    };
  }

  private repoDelegate(state: StoryState) {
    return {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.repos.get(where.id) ?? null,
      findMany: async () => [...state.repos.values()],
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        [...state.repos.values()].find((repo) =>
          Object.entries(where).every(
            ([key, value]) => repo[key] === value,
          ),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(state.repos.size, 0, 'story imports one canonical repo');
        const row: StoryRepoRow = {
          id: REPO_ID,
          name: String(data.name),
          gitSource: String(data.gitSource),
          createdAt: CREATED_AT,
          description: stringOrNull(data.description),
          defaultBranch: stringOrNull(data.defaultBranch),
          branchCount: null,
          updatedAt: null,
          githubId: stringOrNull(data.githubId),
          gitlabProjectId: stringOrNull(data.gitlabProjectId),
          isDefault: false,
          forge: stringOrNull(data.forge),
        };
        state.repos.set(row.id, row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.repos.get(where.id);
        assert.ok(row);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; defaultBranch?: null };
        data: { defaultBranch: string };
      }) => {
        const row = state.repos.get(where.id);
        if (!row || (where.defaultBranch === null && row.defaultBranch !== null)) {
          return { count: 0 };
        }
        row.defaultBranch = data.defaultBranch;
        return { count: 1 };
      },
    };
  }

  private taskDelegate(state: StoryState) {
    return {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        this.taskSequence += 1;
        const id = `44444444-4444-4444-8444-${this.taskSequence
          .toString()
          .padStart(12, '0')}`;
        const row: StoryTaskRow = {
          id,
          repoId: String(data.repoId),
          ownerUserId: stringOrNull(data.ownerUserId),
          prompt: String(data.prompt),
          status: 'pending',
          lifecycleVersion: 0,
          createdAt: new Date(CREATED_AT.getTime() + this.taskSequence),
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
          failureCode: null,
          failureAt: null,
          failureExitCode: null,
          queuedAdmissionToken: null,
          runningAdmissionToken: null,
          executionEnvironmentSnapshot:
            data.executionEnvironmentSnapshot ?? null,
        };
        state.tasks.set(id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        this.readTask(state, where.id),
      findMany: async () =>
        [...state.tasks.keys()].map((id) => this.readTask(state, id)),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          status?: TaskStatus;
          lifecycleVersion?: number;
        };
        data: Record<string, unknown>;
      }) => {
        const row = state.tasks.get(where.id);
        if (
          !row ||
          (where.status !== undefined && row.status !== where.status) ||
          (where.lifecycleVersion !== undefined &&
            row.lifecycleVersion !== where.lifecycleVersion)
        ) {
          return { count: 0 };
        }
        if (typeof data.status === 'string') {
          row.status = data.status as TaskStatus;
        }
        if (
          data.lifecycleVersion &&
          typeof data.lifecycleVersion === 'object' &&
          (data.lifecycleVersion as { increment?: unknown }).increment === 1
        ) {
          row.lifecycleVersion += 1;
        }
        for (const key of [
          'failureCode',
          'failureAt',
          'failureExitCode',
          'queuedAdmissionToken',
          'runningAdmissionToken',
        ] as const) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            row[key] = data[key] as never;
          }
        }
        return { count: 1 };
      },
    };
  }

  private workDelegate(state: StoryState) {
    return {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const taskId = String(data.taskId);
        assert.equal(state.works.has(taskId), false);
        const row: StoryAdmissionWork = {
          taskId,
          state: 'accepted',
          stage: 'accepted',
          attempt: 0,
          leaseOwner: null,
          leaseUntil: null,
          causeCode: null,
          resolvedBranch: String(data.resolvedBranch),
          resourceSnapshot: objectRecord(data.resourceSnapshot),
          workspaceMaterializationDeadlineMs: Number(
            data.workspaceMaterializationDeadlineMs,
          ),
          updatedAt: CREATED_AT,
          stageTrace: ['accepted'],
        };
        state.works.set(taskId, row);
        return row;
      },
      findUnique: async ({ where }: { where: { taskId: string } }) =>
        state.works.get(where.taskId) ?? null,
      findMany: async () => [],
    };
  }

  private idempotencyDelegate(state: StoryState) {
    return {
      findUnique: async ({
        where,
      }: {
        where: { scopeUserId_key: { scopeUserId: string; key: string } };
      }) =>
        state.idempotency.get(
          idempotencyKey(
            where.scopeUserId_key.scopeUserId,
            where.scopeUserId_key.key,
          ),
        ) ?? null,
      create: async ({ data }: { data: StoryIdempotencyRow }) => {
        const key = idempotencyKey(data.scopeUserId, data.key);
        if (state.idempotency.has(key)) throw uniqueConstraintError();
        const row = { ...data };
        state.idempotency.set(key, row);
        return row;
      },
      deleteMany: async ({
        where,
      }: {
        where: { scopeUserId: string; key: string };
      }) => {
        const key = idempotencyKey(where.scopeUserId, where.key);
        const existed = state.idempotency.delete(key);
        return { count: existed ? 1 : 0 };
      },
    };
  }

  private auditDelegate(state: StoryState) {
    return {
      upsert: async ({
        where,
        create,
      }: {
        where: { dedupeKey: string };
        create: Record<string, unknown>;
      }) => {
        const current = state.audits.get(where.dedupeKey);
        if (current) return current;
        const row = { ...create };
        state.audits.set(where.dedupeKey, row);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        this.auditSequence += 1;
        const key = String(data.dedupeKey ?? `audit:${this.auditSequence}`);
        const row = { ...data };
        state.audits.set(key, row);
        return row;
      },
      findFirst: async () => null,
    };
  }

  private readTask(
    state: StoryState,
    taskId: string,
  ): Record<string, unknown> | null {
    const task = state.tasks.get(taskId);
    if (!task) return null;
    const work = state.works.get(taskId) ?? null;
    const repo = state.repos.get(task.repoId) ?? null;
    return {
      ...task,
      repo,
      admissionWork: work,
      sandboxRuns: [],
      sandboxEnvironment: null,
      scheduleRun: null,
    };
  }

  private queryRows(
    state: StoryState,
    query: unknown,
  ): readonly Record<string, unknown>[] {
    const text = sqlText(query);
    if (!text || text.includes('pg_advisory_xact_lock')) return [];
    const leased = [...state.works.values()].find(
      (work) =>
        work.state === 'running' &&
        work.leaseOwner !== null &&
        work.leaseUntil !== null &&
        work.leaseUntil.getTime() > Date.now(),
    );
    if (text.includes('AS "blocked"')) return [{ blocked: false }];
    if (text.includes('AS "occupied"')) {
      const occupied = [...state.tasks.values()].filter(
        ({ status }) => status === 'running' || status === 'awaiting_input',
      ).length;
      return [{ occupied }];
    }
    if (text.includes('FOR UPDATE OF t, w')) {
      if (!leased) return [];
      const task = state.tasks.get(leased.taskId);
      return task
        ? [{ status: task.status, lifecycleVersion: task.lifecycleVersion }]
        : [];
    }
    return [];
  }

  private executeTransactionStatement(
    state: StoryState,
    query: unknown,
  ): number {
    const text = sqlText(query);
    if (!text.includes('UPDATE "task_admission_work"')) return 0;
    const leased = [...state.works.values()].find(
      (work) => work.state === 'running' && work.leaseOwner !== null,
    );
    if (!leased) return 0;
    const values = sqlValues(query);
    const requestedStage = values.find(isTaskProvisioningStage);
    const causeCode = values.find(
      (value): value is string =>
        typeof value === 'string' && value.startsWith('provisioning_'),
    );
    if (requestedStage && stageIndex(requestedStage) > stageIndex(leased.stage)) {
      leased.stage = requestedStage;
      pushStage(leased, requestedStage);
    }
    leased.causeCode = causeCode ?? leased.causeCode;
    leased.updatedAt = new Date();
    return 1;
  }

  private executeRootStatement(state: StoryState, query: unknown): number {
    const text = sqlText(query);
    if (!text.includes('UPDATE "task_admission_work" AS w')) return 0;
    const work = [...state.works.values()].find(
      (candidate) =>
        candidate.state === 'running' && candidate.causeCode !== null,
    );
    if (!work) return 0;
    const task = state.tasks.get(work.taskId);
    if (!task || task.status !== 'failed') return 0;
    work.state = 'failed';
    work.leaseOwner = null;
    work.leaseUntil = null;
    work.updatedAt = new Date();
    return 1;
  }
}

function emptyStoryState(): StoryState {
  return {
    repos: new Map(),
    tasks: new Map(),
    works: new Map(),
    idempotency: new Map(),
    audits: new Map(),
  };
}

function cloneStoryState(source: StoryState): StoryState {
  return {
    repos: new Map(
      [...source.repos].map(([key, row]) => [key, { ...row }]),
    ),
    tasks: new Map(
      [...source.tasks].map(([key, row]) => [key, { ...row, skills: [...row.skills] }]),
    ),
    works: new Map(
      [...source.works].map(([key, row]) => [
        key,
        {
          ...row,
          resourceSnapshot: { ...row.resourceSnapshot },
          stageTrace: [...row.stageTrace],
        },
      ]),
    ),
    idempotency: new Map(
      [...source.idempotency].map(([key, row]) => [key, { ...row }]),
    ),
    audits: new Map(
      [...source.audits].map(([key, row]) => [key, { ...row }]),
    ),
  };
}

function publishStoryState(target: StoryState, source: StoryState): void {
  replaceMap(target.repos, source.repos);
  replaceMap(target.tasks, source.tasks);
  replaceMap(target.works, source.works);
  replaceMap(target.idempotency, source.idempotency);
  replaceMap(target.audits, source.audits);
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function sqlText(query: unknown): string {
  if (query && typeof query === 'object' && 'sql' in query) {
    const value = (query as { sql?: unknown }).sql;
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function sqlValues(query: unknown): readonly unknown[] {
  if (query && typeof query === 'object' && 'values' in query) {
    const value = (query as { values?: unknown }).values;
    return Array.isArray(value) ? value : [];
  }
  return [];
}

const STAGE_ORDER = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
] as const satisfies readonly TaskProvisioningStage[];

function isTaskProvisioningStage(value: unknown): value is TaskProvisioningStage {
  return typeof value === 'string' &&
    (STAGE_ORDER as readonly string[]).includes(value);
}

function stageIndex(stage: TaskProvisioningStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function pushStage(work: StoryAdmissionWork, stage: TaskProvisioningStage): void {
  if (work.stageTrace.at(-1) !== stage) work.stageTrace.push(stage);
}

function idempotencyKey(scopeUserId: string, key: string): string {
  return `${scopeUserId}\u0000${key}`;
}

function uniqueConstraintError(): Error & { code: 'P2002' } {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' as const });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

class StoryAdmissionStore extends TaskAdmissionStore {
  constructor(private readonly database: StoryDatabase) {
    super();
  }

  async claim(
    request: TaskAdmissionClaimRequest,
  ): Promise<TaskAdmissionClaim | null> {
    const work = [...this.database.state.works.values()].find(
      (candidate) => candidate.state === 'accepted',
    );
    if (!work) return null;
    const task = this.database.task(work.taskId);
    const sourceState = 'accepted' as const;
    work.state = 'running';
    work.attempt += 1;
    work.leaseOwner = request.leaseToken;
    work.leaseUntil = new Date(Date.now() + request.leaseDurationMs);
    work.updatedAt = new Date();
    return {
      taskId: work.taskId,
      leaseToken: request.leaseToken,
      leaseUntil: work.leaseUntil,
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
    return this.owns(request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const work = this.database.work(request.taskId);
    work.leaseUntil = new Date(Date.now() + request.leaseDurationMs);
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const work = this.database.work(request.taskId);
    if (stageIndex(request.stage) >= stageIndex(work.stage)) {
      work.stage = request.stage;
      pushStage(work, request.stage);
      work.updatedAt = new Date();
    }
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const work = this.database.work(request.taskId);
    work.state = request.settlement.state;
    if (stageIndex(request.settlement.stage) >= stageIndex(work.stage)) {
      work.stage = request.settlement.stage;
      pushStage(work, request.settlement.stage);
    }
    work.causeCode =
      request.settlement.state === 'failed'
        ? request.settlement.causeCode
        : work.causeCode;
    work.leaseOwner = null;
    work.leaseUntil = null;
    work.updatedAt = new Date();
    return true;
  }

  private owns(request: TaskAdmissionAuthorityRequest): boolean {
    const work = this.database.state.works.get(request.taskId);
    const task = this.database.state.tasks.get(request.taskId);
    return Boolean(
      work &&
        task &&
        work.state === 'running' &&
        work.leaseOwner === request.leaseToken &&
        work.leaseUntil &&
        work.leaseUntil.getTime() > Date.now() &&
        request.taskFences.some(
          (fence) =>
            fence.status === task.status &&
            fence.lifecycleVersion === task.lifecycleVersion,
        ),
    );
  }
}

class ControlledRemoteRefsRunner extends RemoteRefsCommandRunner {
  readonly configProofs: Array<{
    readonly exactOrigin: true;
    readonly expectedAuthorization: true;
  }> = [];
  calls = 0;

  async run(
    request: RemoteRefsCommandRequest,
  ): Promise<RemoteRefsCommandResult> {
    this.calls += 1;
    const argv = request.args.join(' ');
    assert.equal(argv.includes(FORGE_TOKEN), false);
    const include = request.args.find((arg) => arg.startsWith('include.path='));
    assert.ok(include, 'real refs probe must pass its secure config by path');
    const config = await readFile(include.slice('include.path='.length), 'utf8');
    const expectedAuthorization = `Authorization: Basic ${Buffer.from(
      `x-access-token:${FORGE_TOKEN}`,
      'utf8',
    ).toString('base64')}`;
    assert.equal(config.includes(expectedAuthorization), true);
    assert.equal(config.includes(`https://${NORMALIZED_FORGE_HOST}/`), true);
    this.configProofs.push({
      exactOrigin: true,
      expectedAuthorization: true,
    });
    return {
      exitCode: 0,
      stdout: `ref: refs/heads/${DEFAULT_BRANCH}\tHEAD\n0123456789abcdef\tHEAD\n`,
      stderr: '',
    };
  }
}

class CloneBarrierController {
  private current: CloneBarrier | null = null;
  readonly cloneSandboxIds: string[] = [];

  arm(): CloneBarrier {
    assert.equal(this.current, null, 'clone barriers run serially');
    const barrier = cloneBarrier();
    this.current = barrier;
    return barrier;
  }

  releaseCurrent(): void {
    if (!this.current) return;
    this.current.release.resolve();
  }

  async exec(request: {
    readonly sandboxId: string;
    readonly command: string;
  }): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly output: string;
    readonly timedOut: false;
  }> {
    if (!request.command.includes('clone --no-checkout')) {
      return successfulExec();
    }
    const barrier = this.current;
    assert.ok(barrier, 'a create surface must arm its clone barrier');
    this.cloneSandboxIds.push(request.sandboxId);
    barrier.entered.resolve();
    await barrier.release.promise;
    barrier.released = true;
    this.current = null;
    const stderr = 'fatal: write error: No space left on device';
    return {
      exitCode: 1,
      stdout: '',
      stderr,
      output: stderr,
      timedOut: false,
    };
  }
}

function successfulExec(): {
  readonly exitCode: 0;
  readonly stdout: '';
  readonly stderr: '';
  readonly output: '';
  readonly timedOut: false;
} {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    output: '',
    timedOut: false,
  };
}

function storyBoxLiteConfig() {
  const result = readBoxLiteProviderConfig({
    BOXLITE_ENDPOINT: 'https://boxlite.story.test',
    BOXLITE_API_TOKEN: 'boxlite-story-control-token',
    BOXLITE_IMAGE: 'ghcr.io/xeonice/cap-boxlite-sandbox:story',
    BOXLITE_PROVIDER_ID: 'boxlite-cross-surface-story',
    BOXLITE_PROVIDER_LOCATION: 'local',
    BOXLITE_TERMINAL_MODE: 'pty',
    BOXLITE_CAPABILITIES:
      'command.exec,terminal.websocket,workspace.git.materialize,resource.disk-size-gb',
    BOXLITE_DISK_SIZE_GB: String(DISK_SIZE_GB),
    BOXLITE_GIT_CLONE_TIMEOUT_MS: String(WORKSPACE_DEADLINE_MS),
  });
  if (result.status !== 'valid') {
    throw new Error('invalid BoxLite story config');
  }
  return result.config;
}

class StoryHarness {
  readonly database = new StoryDatabase();
  readonly refsRunner = new ControlledRemoteRefsRunner();
  readonly cloneController = new CloneBarrierController();
  readonly ownerStore = new InMemorySandboxRunOwnerStore();
  readonly forgeRegistry: DefaultForgeRegistry;
  readonly forgeResolver: ForgeTargetResolver;
  readonly repos: ReposService;
  readonly branchResolver: TaskBranchResolver;
  readonly provisionLookup: PrismaProvisionLookup;
  readonly client: FakeBoxLiteClient;
  readonly provider: BoxLiteSandboxProvider;
  readonly router: SandboxProviderRouter;
  readonly audit: AuditService;
  readonly store: StoryAdmissionStore;
  readonly worker: TaskAdmissionWorker;
  readonly guardrails: GuardrailsService;
  readonly tasks: TasksService;
  readonly idempotency: IdempotencyService;
  readonly mcpFactory: McpServerFactory;
  readonly reposController: ReposController;
  readonly tasksController: TasksController;
  readonly v1TasksController: V1TasksController;

  constructor() {
    const remoteRefs = new GitRemoteRefsProbe(
      (this.forgeRegistry = new DefaultForgeRegistry(
        this.database.prisma,
        new GithubForge(),
        new GiteeForge(),
        new GitlabForge(),
      )),
      this.refsRunner,
      new NodeRemoteRefsSecretStore(),
    );
    this.forgeResolver = new ForgeTargetResolver(
      this.database.prisma,
      this.forgeRegistry,
    );
    this.repos = new ReposService(
      this.database.prisma,
      this.forgeResolver,
      remoteRefs,
      this.forgeRegistry,
    );
    this.branchResolver = new TaskBranchResolver(
      this.database.prisma,
      this.forgeResolver,
      remoteRefs,
    );

    const sandboxEnvironments = {
      async resolveTaskAdmission(args: {
        readonly selection?: {
          readonly kind: string;
          readonly environmentId?: string;
        };
      }) {
        assert.deepEqual(args.selection, {
          kind: 'managed',
          environmentId: ENVIRONMENT_ID,
        });
        return Object.freeze({
          environment: Object.freeze({
            id: ENVIRONMENT_ID,
            environmentId: ENVIRONMENT_ID,
            name: 'Cross-surface BoxLite',
            providerFamily: 'boxlite' as const,
            resources: Object.freeze({ diskSizeGb: DISK_SIZE_GB }),
          }),
          providerId: 'boxlite-cross-surface-story',
          providerFamily: 'boxlite' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({ diskSizeGb: DISK_SIZE_GB }),
            workspaceMaterializationDeadlineMs: WORKSPACE_DEADLINE_MS,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService;

    this.provisionLookup = new PrismaProvisionLookup(
      this.database.prisma,
      this.forgeResolver,
      this.forgeRegistry,
      sandboxEnvironments,
      this.branchResolver,
    );

    this.client = new FakeBoxLiteClient({
      execHandler: (request) => this.cloneController.exec(request),
    });
    this.provider = new BoxLiteSandboxProvider({
      config: storyBoxLiteConfig(),
      client: this.client,
      workspaceMaterialization: materializeSandboxGitWorkspaceStaged,
    });
    this.router = new SandboxProviderRouter(
      [
        defineLocalSandboxProvider({
          id: this.provider.getProviderId(),
          provider: this.provider,
          capabilities: this.provider.getProviderCapabilities(),
        }),
      ],
      { ownerStore: this.ownerStore },
    );

    this.audit = new AuditService(this.database.prisma);
    this.store = new StoryAdmissionStore(this.database);
    const clock = new SystemTaskAdmissionClock();
    const scheduler = new SystemTaskAdmissionScheduler();
    const leaseTokens = new RandomTaskAdmissionLeaseTokenFactory(clock);
    const forgeResolver = this.forgeResolver;
    const forgeRegistry = this.forgeRegistry;
    const branchResolver = this.branchResolver;
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
    const moduleRef = {
      get(token: unknown) {
        if (token === GuardrailsService) return guardrails;
        if (token === TasksService) return tasks;
        if (token === TERMINAL_GATEWAY_TOKEN) return gateway;
        if (token === ForgeTargetResolver) return forgeResolver;
        if (token === DefaultForgeRegistry) return forgeRegistry;
        if (token === TaskBranchResolver) return branchResolver;
        throw new Error(`unexpected story module token: ${String(token)}`);
      },
    } as unknown as ModuleRef;
    const processor = new FencedTaskAdmissionProcessor(moduleRef);
    this.worker = new TaskAdmissionWorker(
      this.store,
      processor,
      scheduler,
      clock,
      leaseTokens,
      {
        ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
        leaseDurationMs: 60_000,
        renewIntervalMs: 30_000,
        pollIntervalMs: 60_000,
        maxInFlight: 1,
      },
      undefined,
      this.audit,
    );
    const guardrailsConfig: GuardrailsConfig = {
      maxConcurrentTasks: 1,
      defaultIdleTimeoutMs: null,
      circuitBreakerThreshold: 3,
    };
    const guardrails = new GuardrailsService(
      moduleRef,
      {
        destroyForSession() {},
      } as unknown as SessionCredentialsService,
      this.router as unknown as SandboxProvider,
      guardrailsConfig,
      this.provisionLookup,
      this.audit,
      this.database.prisma,
    );
    const gate: TaskAdmissionGatePort = { isEnabled: () => true };
    const tasks = new TasksService(
      this.database.prisma,
      guardrails as unknown as IGuardrailsService,
      this.audit,
      undefined,
      undefined,
      undefined,
      undefined,
      sandboxEnvironments,
      undefined,
      undefined,
      gate,
      this.branchResolver,
      this.worker,
      this.worker,
    );
    this.guardrails = guardrails;
    this.tasks = tasks;
    this.guardrails.onModuleInit();
    this.idempotency = new IdempotencyService(this.database.prisma);
    this.mcpFactory = new McpServerFactory(
      this.tasks,
      this.repos,
      {} as never,
      {} as never,
      { assertOpen() {} } as never,
      this.database.prisma,
      {} as never,
      {} as never,
      this.router as unknown as SandboxProvider,
    );
    this.reposController = new ReposController(this.repos);
    this.tasksController = new TasksController(this.tasks);
    this.v1TasksController = new V1TasksController(
      this.tasks,
      this.database.prisma,
      this.idempotency,
    );
  }

  async close(): Promise<void> {
    this.cloneController.releaseCurrent();
    await this.tasks.beforeApplicationShutdown();
  }
}

interface SurfaceOutcome {
  readonly name: string;
  readonly initial: TaskResponse;
  readonly active: TaskResponse;
  readonly terminal: TaskResponse;
  readonly stageTrace: readonly TaskProvisioningStage[];
}

async function runSurfaceStory(args: {
  readonly name: string;
  readonly harness: StoryHarness;
  readonly create: () => Promise<TaskResponse>;
  readonly read: (taskId: string) => Promise<TaskResponse>;
  readonly executionMode: 'interactive-pty' | 'headless-exec';
}): Promise<SurfaceOutcome> {
  const barrier = args.harness.cloneController.arm();
  const initial = await args.create();
  assert.equal(
    barrier.released,
    false,
    `${args.name} returned before the controllable worker began clone settlement`,
  );
  const workerRun = args.harness.worker.runOnce();
  await Promise.race([
    barrier.entered.promise,
    workerRun.then((outcome) => {
      assert.fail(
        `${args.name} worker completed before entering clone: ${outcome.kind}`,
      );
    }),
  ]);
  assert.equal(barrier.released, false, `${args.name} clone remains unsettled`);
  assert.equal(initial.status, 'pending');
  assert.equal(initial.executionMode, args.executionMode);
  assert.deepEqual(initial.provisioning, {
    state: 'accepted',
    stage: 'accepted',
    attempt: 0,
    resolvedBranch: DEFAULT_BRANCH,
    updatedAt: CREATED_AT,
  });

  const active = await args.read(initial.id);
  assert.equal(active.status, 'running');
  assert.equal(active.provisioning?.state, 'running');
  assert.equal(active.provisioning?.stage, 'workspace_transfer');
  assert.equal(active.provisioning?.attempt, 1);
  assert.equal(active.provisioning?.resolvedBranch, DEFAULT_BRANCH);

  barrier.release.resolve();
  const workerOutcome = await workerRun;
  assert.equal(workerOutcome.kind, 'failed');
  assert.equal(barrier.released, true);
  const terminal = await args.read(initial.id);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.failure?.code, 'provisioning_capacity_exhausted');
  assert.equal(terminal.failure?.action, 'increase_sandbox_capacity');
  assert.equal(terminal.provisioning?.state, 'failed');
  assert.equal(terminal.provisioning?.attempt, 1);
  assert.ok(terminal.provisioning);
  assert.ok(
    stageIndex(terminal.provisioning.stage) >= stageIndex('workspace_transfer'),
    'credential cleanup may monotonically advance the visible terminal stage',
  );
  return {
    name: args.name,
    initial,
    active,
    terminal,
    stageTrace: [...args.harness.database.work(initial.id).stageTrace],
  };
}

test(
  'Console REST, Public V1, and MCP share durable admission and exact-host credentials',
  { timeout: 30_000 },
  async (t) => {
    const previousEncryptionKey = process.env.CODEX_CRED_ENC_KEY;
    process.env.CODEX_CRED_ENC_KEY = ENCRYPTION_KEY;
    const harness = new StoryHarness();
    let mcpClient: Client | null = null;
    let mcpServer: ReturnType<McpServerFactory['createServer']> | null = null;
    t.after(async () => {
      harness.cloneController.releaseCurrent();
      await mcpClient?.close().catch(() => undefined);
      await mcpServer?.close().catch(() => undefined);
      await harness.close();
      if (previousEncryptionKey === undefined) {
        delete process.env.CODEX_CRED_ENC_KEY;
      } else {
        process.env.CODEX_CRED_ENC_KEY = previousEncryptionKey;
      }
    });

    const imported = RepoResponseSchema.parse(
      await harness.reposController.create(REQUEST, {
        name: 'Private master repository',
        gitSource: REPOSITORY_URL,
        forge: 'gitee',
        importSource: 'url',
      }),
    );
    assert.equal(imported.id, REPO_ID);
    assert.equal(imported.defaultBranch, DEFAULT_BRANCH);
    assert.equal(harness.refsRunner.calls, 1);

    mcpServer = harness.mcpFactory.createServer();
    mcpClient = new Client({
      name: 'durable-cross-surface-story',
      version: '1.0.0',
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: {
          token: 'mcp_cross_surface_story',
          clientId: 'story',
          scopes: ['tasks:read', 'tasks:write', 'repos:read'],
          expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
          extra: { userId: OWNER_ID },
        },
      });
    await mcpServer.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    const consoleOutcome = await runSurfaceStory({
      name: 'Console REST',
      harness,
      executionMode: 'interactive-pty',
      create: () =>
        harness.tasksController.create(
          REPO_ID,
          {
            prompt: 'console durable story',
            sandboxEnvironmentId: ENVIRONMENT_ID,
          },
          REQUEST,
        ),
      read: (taskId) => harness.tasksController.findById(taskId),
    });

    const v1Outcome = await runSurfaceStory({
      name: 'Public V1',
      harness,
      executionMode: 'headless-exec',
      create: () =>
        harness.v1TasksController.create(
          {
            repoId: REPO_ID,
            prompt: 'v1 durable story',
            sandboxEnvironmentId: ENVIRONMENT_ID,
          },
          REQUEST,
          'cross-surface-v1-only',
        ),
      read: (taskId) => harness.v1TasksController.findById(taskId, REQUEST),
    });

    const mcpOutcome = await runSurfaceStory({
      name: 'MCP',
      harness,
      executionMode: 'headless-exec',
      create: async () => {
        assert.ok(mcpClient);
        const result = await mcpClient.callTool({
          name: 'create_task',
          arguments: {
            repoId: REPO_ID,
            prompt: 'mcp durable story',
            sandboxEnvironmentId: ENVIRONMENT_ID,
          },
        });
        return TaskResponseSchema.parse(result.structuredContent);
      },
      read: async (taskId) => {
        assert.ok(mcpClient);
        const result = await mcpClient.callTool({
          name: 'get_task',
          arguments: { id: taskId },
        });
        return TaskResponseSchema.parse(result.structuredContent);
      },
    });

    const outcomes = [consoleOutcome, v1Outcome, mcpOutcome];
    const expectedTrace: readonly TaskProvisioningStage[] = [
      'accepted',
      'sandbox_creation',
      'credential_setup',
      'remote_ref_resolution',
      'workspace_transfer',
      'credential_cleanup',
    ];
    for (const outcome of outcomes) {
      assert.deepEqual(outcome.stageTrace, expectedTrace, outcome.name);
      assert.equal(
        outcome.terminal.provisioning?.stage,
        outcomes[0]?.terminal.provisioning?.stage,
      );
      assert.ok(outcome.terminal.failure?.occurredAt instanceof Date);
      assert.deepEqual(
        failureSemantics(outcome.terminal.failure),
        failureSemantics(outcomes[0]?.terminal.failure),
      );
    }

    assert.equal(harness.database.state.tasks.size, 3);
    assert.equal(harness.database.state.works.size, 3);
    assert.equal(harness.database.state.idempotency.size, 1);
    assert.equal(
      [...harness.database.state.audits.keys()].filter((key) =>
        key.startsWith('task.created:'),
      ).length,
      3,
    );
    const taskRows = [...harness.database.state.tasks.values()];
    assert.deepEqual(
      taskRows.map(({ ownerUserId, repoId, sandboxEnvironmentId }) => ({
        ownerUserId,
        repoId,
        sandboxEnvironmentId,
      })),
      Array.from({ length: 3 }, () => ({
        ownerUserId: OWNER_ID,
        repoId: REPO_ID,
        sandboxEnvironmentId: ENVIRONMENT_ID,
      })),
    );
    assert.deepEqual(
      taskRows.map(({ executionMode }) => executionMode),
      [null, 'headless-exec', 'headless-exec'],
    );
    assert.equal(harness.client.createCalls.length, 3);
    assert.equal(harness.cloneController.cloneSandboxIds.length, 3);
    assert.equal(harness.client.deletedSandboxIds.length, 3);
    assert.deepEqual(await harness.ownerStore.listActiveSandboxRunOwners(), []);

    assert.deepEqual(
      harness.database.credentialLookups,
      Array.from({ length: 4 }, () => ({
        userId: OWNER_ID,
        kind: 'gitee',
        host: NORMALIZED_FORGE_HOST,
      })),
      'import plus all three task workspace plans use the same exact-host owner resolver',
    );
    assert.deepEqual(harness.refsRunner.configProofs, [
      { exactOrigin: true, expectedAuthorization: true },
    ]);
    const serializedPublicState = JSON.stringify({
      outcomes,
      audits: [...harness.database.state.audits.values()],
      createCalls: harness.client.createCalls,
      execCalls: harness.client.execCalls,
    });
    assert.equal(serializedPublicState.includes(FORGE_TOKEN), false);
  },
);

function failureSemantics(failure: TaskResponse['failure']): unknown {
  if (!failure) return failure;
  const { occurredAt: _occurredAt, ...semantics } = failure;
  return semantics;
}
