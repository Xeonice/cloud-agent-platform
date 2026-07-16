import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_ADMISSION_V2_CAPABILITY,
  type CreateTaskBody,
  type TaskResponse,
} from '@cap/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { SandboxEnvironmentsService } from '../sandbox-environments/sandbox-environments.service';
import type { TaskBranchResolver } from '../forge/task-branch-resolver';
import { TasksController } from './tasks.controller';
import {
  TasksService,
  type IGuardrailsService,
} from './tasks.service';
import type { PreparedTaskCreate } from './prepared-task-create';
import {
  TASK_ADMISSION_V2_ATTESTATION_ENV,
  TASK_ADMISSION_V2_ENABLED_ENV,
  taskAdmissionV2Enabled,
  type TaskAdmissionGatePort,
  type TaskAdmissionWakePort,
} from './task-admission-gate';
import { McpServerFactory } from '../mcp/mcp.server';
import type { RuntimeModelPreflightService } from '../runtime-models/runtime-model-preflight.service';
import type { TaskModelCapabilityService } from '../runtime-models/task-model-capability.service';
import { buildRuntimeExecutionEnvironmentSnapshot } from '../runtime-models/runtime-model-snapshot';

const REPO_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MANAGED_ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const VALIDATION_ID = '44444444-4444-4444-8444-444444444444';

function taskAdmissionV2Attestation(): string {
  const roles = ['api', 'worker'] as const;
  return JSON.stringify({
    schemaVersion: 1,
    deploymentId: 'task-acceptance-test',
    expectedWorkers: [{ instanceId: 'cap-all', roles }],
    reports: roles.map((role) => ({
      schemaVersion: 1,
      instanceId: 'cap-all',
      role,
      buildIdentity: 'cap-v2.0.0',
      capabilities: [TASK_ADMISSION_V2_CAPABILITY],
      ready: true,
      reportedAt: '2026-07-15T00:00:00.000Z',
    })),
    attestedAt: '2026-07-15T00:00:00.000Z',
    expiresAt: '2099-07-16T00:00:00.000Z',
  });
}

const EXPLICIT_MODEL_SNAPSHOT = buildRuntimeExecutionEnvironmentSnapshot({
  schemaVersion: 1,
  kind: 'managed',
  managedEnvironmentId: MANAGED_ENVIRONMENT_ID,
  validationId: VALIDATION_ID,
  validationContractVersion: 'sandbox-environment-v2',
  provider: 'boxlite',
  providerFamily: 'boxlite',
  resources: Object.freeze({ diskSizeGb: 17 }),
  source: {
    kind: 'boxlite-image',
    locator: 'registry.example/codex@sha256:image',
    digest: 'sha256:image',
    checksum: null,
  },
  immutableIdentity: 'sha256:image',
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: '1.2.3',
    dependencies: { codex: '0.144.1' },
  },
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'b'.repeat(64)}`,
  resolvedAt: '2026-07-15T00:00:00.000Z',
});

interface AcceptanceState {
  tasks: Array<Record<string, unknown>>;
  works: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
}

function fakeAcceptancePrisma(options: { failAudit?: boolean } = {}) {
  const state: AcceptanceState = { tasks: [], works: [], audits: [] };
  let sequence = 0;

  const clientFor = (target: AcceptanceState) => ({
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        sequence += 1;
        const row = {
          id: `44444444-4444-4444-8444-${sequence.toString().padStart(12, '0')}`,
          ...data,
          status: 'pending',
          createdAt: new Date('2026-07-15T00:00:00.000Z'),
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
        target.tasks.find((row) => row.id === where.id) ?? null,
    },
    taskAdmissionWork: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (target.works.some((row) => row.taskId === data.taskId)) {
          throw Object.assign(new Error('duplicate admission work'), {
            code: 'P2002',
          });
        }
        target.works.push({ ...data });
        return {
          ...data,
          state: 'accepted',
          stage: 'accepted',
          attempt: 0,
          resolvedBranch: data.resolvedBranch ?? null,
          updatedAt: new Date('2026-07-15T00:00:00.000Z'),
        };
      },
      findUnique: async ({ where }: { where: { taskId: string } }) =>
        target.works.find((row) => row.taskId === where.taskId) ?? null,
    },
    auditEvent: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        if (options.failAudit) throw new Error('audit unavailable');
        const existing = target.audits.find(
          (row) => row.dedupeKey === create.dedupeKey,
        );
        if (!existing) target.audits.push({ ...create });
        return existing ?? create;
      },
    },
  });

  const root = clientFor(state);
  const prisma = {
    ...root,
    repo: {
      findUnique: async () => ({
        id: REPO_ID,
        gitSource: 'https://gitee.example/acme/repo.git',
        defaultBranch: 'master',
      }),
    },
    accountSettings: {
      findUnique: async () => null,
    },
    $transaction: async <T>(
      operation: (client: ReturnType<typeof clientFor>) => Promise<T>,
    ): Promise<T> => {
      const staged: AcceptanceState = {
        tasks: [...state.tasks],
        works: [...state.works],
        audits: [...state.audits],
      };
      const result = await operation(clientFor(staged));
      state.tasks.splice(0, state.tasks.length, ...staged.tasks);
      state.works.splice(0, state.works.length, ...staged.works);
      state.audits.splice(0, state.audits.length, ...staged.audits);
      return result;
    },
  };
  return { prisma: prisma as unknown as PrismaService, state };
}

function durablePrepared(
  overrides: Partial<PreparedTaskCreate> = {},
): PreparedTaskCreate {
  return {
    repoId: REPO_ID,
    ownerUserId: USER_ID,
    body: Object.freeze({ prompt: 'prepare repository', branch: undefined }),
    runtime: 'codex',
    executionMode: 'interactive-pty',
    sandboxEnvironmentId: null,
    model: null,
    executionEnvironmentSnapshot: null,
    admissionMode: 'durable-v2',
    resolvedBranch: 'master',
    resourceSnapshot: Object.freeze({}),
    workspaceMaterializationDeadlineMs: 900_000,
    ...overrides,
  } as PreparedTaskCreate;
}

function serviceWith(
  prisma: PrismaService,
  options: {
    guardrails?: IGuardrailsService;
    audit?: AuditRecorderPort;
    environments?: SandboxEnvironmentsService;
    gate?: TaskAdmissionGatePort;
    branches?: TaskBranchResolver;
    wake?: TaskAdmissionWakePort;
    runtimeModelPreflight?: RuntimeModelPreflightService;
    taskModelCapability?: TaskModelCapabilityService;
  } = {},
): TasksService {
  return new TasksService(
    prisma,
    options.guardrails,
    options.audit,
    undefined,
    undefined,
    undefined,
    undefined,
    options.environments,
    options.runtimeModelPreflight,
    options.taskModelCapability,
    options.gate,
    options.branches,
    options.wake,
  );
}

test('admission rollout flag alone never bypasses the required deployment attestation', () => {
  for (const value of ['1', ' 1 ', 'true', ' TRUE ']) {
    assert.equal(
      taskAdmissionV2Enabled({ [TASK_ADMISSION_V2_ENABLED_ENV]: value }),
      false,
      value,
    );
    assert.equal(
      taskAdmissionV2Enabled({
        [TASK_ADMISSION_V2_ENABLED_ENV]: value,
        [TASK_ADMISSION_V2_ATTESTATION_ENV]: taskAdmissionV2Attestation(),
      }),
      true,
      `${value} with complete attestation`,
    );
  }
  for (const value of [undefined, '', '0', 'false', 'yes']) {
    assert.equal(
      taskAdmissionV2Enabled({
        [TASK_ADMISSION_V2_ENABLED_ENV]: value,
        [TASK_ADMISSION_V2_ATTESTATION_ENV]: taskAdmissionV2Attestation(),
      }),
      false,
      String(value),
    );
  }
});

test('missing admission-gate injection defaults to legacy Task-only acceptance', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const service = serviceWith(prisma);

  const prepared = await service.prepareTaskCreate(
    REPO_ID,
    { prompt: 'legacy default', sandboxEnvironmentId: null },
    'interactive-pty',
    USER_ID,
  );
  assert.equal(prepared.admissionMode, 'legacy');

  await service.acceptPreparedTask(prepared);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.works.length, 0);
  assert.equal(state.audits.length, 0);
});

test('durable writer atomically commits nullable caller branch, immutable snapshots, and task.created identity', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const service = serviceWith(prisma);

  const task = await service.acceptPreparedTask(durablePrepared());

  assert.equal(task.branch, null, 'caller omission remains nullable Task intent');
  assert.deepEqual(task.provisioning, {
    state: 'accepted',
    stage: 'accepted',
    attempt: 0,
    resolvedBranch: 'master',
    updatedAt: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.equal(state.tasks.length, 1);
  assert.deepEqual(state.works, [
    {
      taskId: task.id,
      resolvedBranch: 'master',
      resourceSnapshot: {},
      workspaceMaterializationDeadlineMs: 900_000,
    },
  ]);
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0]?.dedupeKey, `task.created:${task.id}`);
  assert.equal(state.audits[0]?.userId, USER_ID);
});

test('audit failure rolls back Task and admission work as one acceptance transaction', async () => {
  const { prisma, state } = fakeAcceptancePrisma({ failAudit: true });
  const service = serviceWith(prisma);

  await assert.rejects(
    () => service.acceptPreparedTask(durablePrepared()),
    /audit unavailable/,
  );
  assert.deepEqual(state, { tasks: [], works: [], audits: [] });
});

test('runtime snapshot validation rejects invalid branch/resources and rolls back the staged Task', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const service = serviceWith(prisma);
  const malformed = {
    ...durablePrepared(),
    resolvedBranch: ' invalid branch ',
    resourceSnapshot: { diskSizeGb: 0, providerNative: true },
  } as unknown as PreparedTaskCreate;

  await assert.rejects(() => service.acceptPreparedTask(malformed));
  assert.deepEqual(state, { tasks: [], works: [], audits: [] });
});

test('runtime snapshot validation rejects a missing or out-of-policy workspace deadline', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const service = serviceWith(prisma);
  const malformed = {
    ...durablePrepared(),
    workspaceMaterializationDeadlineMs: 999,
  } as unknown as PreparedTaskCreate;

  await assert.rejects(() => service.acceptPreparedTask(malformed));
  assert.deepEqual(state, { tasks: [], works: [], audits: [] });
});

test('runtime snapshot validation rejects a resolved branch that conflicts with caller intent', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const service = serviceWith(prisma);
  const malformed = durablePrepared({
    body: Object.freeze({ prompt: 'conflict', branch: 'release/next' }),
    resolvedBranch: 'master',
  });

  await assert.rejects(() => service.acceptPreparedTask(malformed));
  assert.deepEqual(state, { tasks: [], works: [], audits: [] });
});

test('gate is read once during preparation and a later flip cannot change the writer mode', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const resources = { diskSizeGb: 12 };
  let enabled = true;
  let gateReads = 0;
  let branchPreparations = 0;
  const resourceResolutions: unknown[] = [];
  const service = serviceWith(prisma, {
    gate: {
      isEnabled() {
        gateReads += 1;
        return enabled;
      },
    },
    branches: {
      async prepareForCreate() {
        branchPreparations += 1;
        return {
          repositoryUrl: 'https://gitee.example/acme/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          source: 'repo-default-branch' as const,
        };
      },
    } as unknown as TaskBranchResolver,
    environments: {
      async resolveForTask() {
        return null;
      },
      async resolveTaskAdmission(args: unknown) {
        resourceResolutions.push(args);
        return Object.freeze({
          environment: null,
          providerId: 'aio-local',
          providerFamily: 'aio' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({ ...resources }),
            workspaceMaterializationDeadlineMs: 900_000,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService,
  });

  const durable = await service.prepareTaskCreate(
    REPO_ID,
    { prompt: 'durable', sandboxEnvironmentId: null },
    'interactive-pty',
    USER_ID,
  );
  assert.equal(durable.admissionMode, 'durable-v2');
  assert.deepEqual(durable.resourceSnapshot, { diskSizeGb: 12 });
  assert.equal(Object.isFrozen(durable.resourceSnapshot), true);
  assert.equal(durable.workspaceMaterializationDeadlineMs, 900_000);
  resources.diskSizeGb = 99;
  enabled = false;
  await service.acceptPreparedTask(durable);
  assert.deepEqual(state.works[0]?.resourceSnapshot, { diskSizeGb: 12 });
  assert.equal(
    state.works[0]?.workspaceMaterializationDeadlineMs,
    900_000,
  );

  const legacy = await service.prepareTaskCreate(
    REPO_ID,
    { prompt: 'legacy', sandboxEnvironmentId: null },
    'interactive-pty',
    USER_ID,
  );
  assert.equal(legacy.admissionMode, 'legacy');
  enabled = true;
  await service.acceptPreparedTask(legacy);

  assert.equal(gateReads, 2, 'one read for each independently prepared create');
  assert.equal(branchPreparations, 1, 'legacy mode performs no durable branch preparation');
  assert.equal(state.tasks.length, 2);
  assert.equal(state.works.length, 1, 'gate-off acceptance writes only its Task');
  assert.equal(state.audits.length, 1, 'gate-off audit remains post-commit legacy work');
  assert.deepEqual(resourceResolutions, [
    {
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
    },
  ]);
});

test('explicit-model durable preparation freezes snapshot resources through one provider-policy seam without reselecting the managed environment', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const policyCalls: unknown[] = [];
  let legacyEnvironmentCalls = 0;
  const service = serviceWith(prisma, {
    gate: { isEnabled: () => true },
    taskModelCapability: {
      assertOpen() {},
    } as unknown as TaskModelCapabilityService,
    runtimeModelPreflight: {
      async preflight() {
        return {
          ok: true as const,
          value: {
            intent: 'explicit' as const,
            model: 'openai/codex:v1',
            executionEnvironmentSnapshot: EXPLICIT_MODEL_SNAPSHOT,
          },
        };
      },
    } as unknown as RuntimeModelPreflightService,
    environments: {
      async resolveForTask() {
        legacyEnvironmentCalls += 1;
        throw new Error('explicit durable preparation must not reselect managed env');
      },
      async resolveTaskAdmission(args: unknown) {
        policyCalls.push(args);
        return Object.freeze({
          environment: null,
          providerId: 'boxlite',
          providerFamily: 'boxlite' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({ diskSizeGb: 17 }),
            workspaceMaterializationDeadlineMs: 1_200_000,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService,
    branches: {
      async prepareForCreate() {
        return {
          repositoryUrl: 'https://gitee.example/acme/repo.git',
          callerBranch: null,
          resolvedBranch: 'master',
          source: 'repo-default-branch' as const,
        };
      },
    } as unknown as TaskBranchResolver,
  });

  const prepared = await service.prepareTaskCreate(
    REPO_ID,
    { prompt: 'explicit', model: 'openai/codex:v1' },
    'headless-exec',
    USER_ID,
  );
  assert.deepEqual(policyCalls, [
    {
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
      providerFamily: 'boxlite',
      resources: { diskSizeGb: 17 },
    },
  ]);
  assert.equal(legacyEnvironmentCalls, 0);
  assert.equal(prepared.sandboxEnvironmentId, MANAGED_ENVIRONMENT_ID);
  assert.deepEqual(prepared.resourceSnapshot, { diskSizeGb: 17 });
  assert.equal(prepared.workspaceMaterializationDeadlineMs, 1_200_000);

  const task = await service.acceptPreparedTask(prepared);
  assert.deepEqual(state.works[0], {
    taskId: task.id,
    resolvedBranch: 'master',
    resourceSnapshot: { diskSizeGb: 17 },
    workspaceMaterializationDeadlineMs: 1_200_000,
  });
});

test('explicit-model durable preparation fails closed when provider capability routing changes after preflight', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  let branchCalls = 0;
  const policyCalls: unknown[] = [];
  const service = serviceWith(prisma, {
    gate: { isEnabled: () => true },
    taskModelCapability: {
      assertOpen() {},
    } as unknown as TaskModelCapabilityService,
    runtimeModelPreflight: {
      async preflight() {
        return {
          ok: true as const,
          value: {
            intent: 'explicit' as const,
            model: 'openai/codex:v1',
            executionEnvironmentSnapshot: EXPLICIT_MODEL_SNAPSHOT,
          },
        };
      },
    } as unknown as RuntimeModelPreflightService,
    environments: {
      async resolveTaskAdmission(args: unknown) {
        policyCalls.push(args);
        return Object.freeze({
          environment: null,
          // Native and cap-rest deployments commonly retain the same provider
          // id; the frozen resource capability is the meaningful fence.
          providerId: 'boxlite',
          providerFamily: 'boxlite' as const,
          provisioningPolicy: Object.freeze({
            resources: Object.freeze({}),
            workspaceMaterializationDeadlineMs: 1_200_000,
          }),
        });
      },
    } as unknown as SandboxEnvironmentsService,
    branches: {
      async prepareForCreate() {
        branchCalls += 1;
        throw new Error('branch resolution must not run after policy mismatch');
      },
    } as unknown as TaskBranchResolver,
  });

  await assert.rejects(
    () =>
      service.prepareTaskCreate(
        REPO_ID,
        { prompt: 'downgraded', model: 'openai/codex:v1' },
        'headless-exec',
        USER_ID,
      ),
    /provider policy changed after model preflight/,
  );
  assert.deepEqual(policyCalls, [
    {
      selection: { kind: 'deployment-default' },
      runtimeId: 'codex',
      providerFamily: 'boxlite',
      resources: { diskSizeGb: 17 },
    },
  ]);
  assert.equal(branchCalls, 0);
  assert.deepEqual(state, { tasks: [], works: [], audits: [] });
});

test('existing admission work is a provider barrier: post-commit only wakes and never waits for guardrails', async () => {
  const { prisma, state } = fakeAcceptancePrisma();
  const taskId = '55555555-5555-4555-8555-555555555555';
  state.works.push({ taskId, resolvedBranch: 'master', resourceSnapshot: {} });
  let providerEntered!: () => void;
  const providerBarrier = new Promise<'provider-called'>((resolve) => {
    providerEntered = () => resolve('provider-called');
  });
  let wakeCount = 0;
  let auditCount = 0;
  const service = serviceWith(prisma, {
    guardrails: {
      admit() {
        providerEntered();
        return new Promise<never>(() => undefined);
      },
      async onTerminal() {},
      recordFailure() {},
      recordSuccess() {},
    },
    audit: {
      async recordTaskCreated() {
        auditCount += 1;
      },
    } as unknown as AuditRecorderPort,
    wake: {
      wake(id) {
        assert.equal(id, taskId);
        wakeCount += 1;
      },
    },
  });

  const outcome = await Promise.race([
    service
      .admitCreatedTask(taskId, { prompt: 'durable' }, USER_ID)
      .then(() => 'returned' as const),
    providerBarrier,
  ]);
  assert.equal(outcome, 'returned');
  assert.equal(wakeCount, 1);
  assert.equal(auditCount, 0);
});

test('gate-off task without admission work retains post-commit legacy audit and guardrails admission', async () => {
  const { prisma } = fakeAcceptancePrisma();
  let auditCount = 0;
  let admitCount = 0;
  const service = serviceWith(prisma, {
    guardrails: {
      async admit() {
        admitCount += 1;
        return 'running';
      },
      async onTerminal() {},
      recordFailure() {},
      recordSuccess() {},
    },
    audit: {
      async recordTaskCreated() {
        auditCount += 1;
      },
    } as unknown as AuditRecorderPort,
  });

  await service.admitCreatedTask(
    '66666666-6666-4666-8666-666666666666',
    { prompt: 'legacy' },
    USER_ID,
  );
  assert.equal(auditCount, 1);
  assert.equal(admitCount, 1);
});

test('Console and MCP create delegates converge on TasksService.create', async () => {
  const calls: Array<{
    repoId: string;
    mode: string | undefined;
    userId: string | undefined;
  }> = [];
  const response = {
    id: '77777777-7777-4777-8777-777777777777',
  } as TaskResponse;
  const tasks = {
    async create(
      repoId: string,
      _body: CreateTaskBody,
      userId?: string,
      mode?: string,
    ) {
      calls.push({ repoId, userId, mode });
      return response;
    },
  } as TasksService;

  const consoleController = new TasksController(tasks);
  await consoleController.create(
    REPO_ID,
    { prompt: 'console' },
    { operatorPrincipal: { user: { id: USER_ID } } } as never,
  );
  const mcp = new McpServerFactory(
    tasks,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await mcp.createTask(REPO_ID, { prompt: 'mcp' }, USER_ID);

  assert.deepEqual(calls, [
    { repoId: REPO_ID, userId: USER_ID, mode: undefined },
    { repoId: REPO_ID, userId: USER_ID, mode: 'headless-exec' },
  ]);
});
