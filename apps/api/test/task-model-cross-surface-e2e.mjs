/**
 * N-version task-model cross-surface integration test.
 *
 * Boots the real AppModule against a migrated disposable Postgres database and
 * keeps every product-owned write/read path real: Console REST, Public V1, the
 * MCP server factory/tool callbacks, TasksService, ScheduledTasksService and
 * Prisma. Only external deployment boundaries are replaced:
 *   - runtime-model discovery returns one deterministic, immutable snapshot;
 *   - the deployment cutover capability is open;
 *   - guardrails admission performs a database-only queued transition instead
 *     of provisioning an execution sandbox.
 *
 * Prerequisite: DATABASE_URL points to a migrated disposable Postgres database.
 */
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Prisma } from '@prisma/client';
import {
  ScheduleResponseSchema,
  TaskResponseSchema,
  V1ListScheduleRunsResponseSchema,
  V1ListTasksResponseSchema,
} from '@cap/contracts';
import {
  DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
  taskModelLaunchMaterial,
} from '@cap/sandbox';

import { AppModule } from '../dist/app.module.js';
import { CodexRuntime } from '../dist/agent-runtime/codex-runtime.js';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { PrismaProvisionLookup } from '../dist/sandbox/prisma-provision-lookup.js';
import {
  GUARDRAILS_SERVICE_TOKEN,
} from '../dist/tasks/tasks.service.js';
import { RuntimeModelPreflightService } from '../dist/runtime-models/runtime-model-preflight.service.js';
import { RuntimeModelCatalogService } from '../dist/runtime-models/runtime-model-catalog.service.js';
import { buildRuntimeExecutionEnvironmentSnapshot } from '../dist/runtime-models/runtime-model-snapshot.js';
import { TaskModelCapabilityService } from '../dist/runtime-models/task-model-capability.service.js';
import { McpServerFactory } from '../dist/mcp/mcp.server.js';
import { ScheduledTasksService } from '../dist/scheduled-tasks/scheduled-tasks.service.js';
import { hashSessionToken } from '../dist/auth/session-token.js';

const MODEL = 'fixture/codex-cross-surface';
const MODEL_DIGEST = `sha256:${'1'.repeat(64)}`;
const SNAPSHOT = buildRuntimeExecutionEnvironmentSnapshot({
  schemaVersion: 1,
  kind: 'deployment-default',
  managedEnvironmentId: null,
  validationId: null,
  validationContractVersion: null,
  provider: 'aio-local',
  providerFamily: 'aio',
  source: {
    kind: 'aio-docker-image',
    locator: MODEL_DIGEST,
    digest: MODEL_DIGEST,
    checksum: null,
  },
  immutableIdentity: MODEL_DIGEST,
  sandboxMetadata: {
    schemaVersion: 1,
    sandboxVersion: '1.0.0',
    dependencies: { codex: '0.144.1' },
  },
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'3'.repeat(64)}`,
  resolvedAt: '2026-07-14T00:00:00.000Z',
});
const RETARGETED_DIGEST = `sha256:${'4'.repeat(64)}`;
const RETARGETED_SNAPSHOT = buildRuntimeExecutionEnvironmentSnapshot({
  schemaVersion: 1,
  kind: 'deployment-default',
  managedEnvironmentId: null,
  validationId: null,
  validationContractVersion: null,
  provider: 'aio-local',
  providerFamily: 'aio',
  source: {
    kind: 'aio-docker-image',
    locator: RETARGETED_DIGEST,
    digest: RETARGETED_DIGEST,
    checksum: null,
  },
  immutableIdentity: RETARGETED_DIGEST,
  sandboxMetadata: SNAPSHOT.sandboxMetadata,
  cliVersion: '0.144.1',
  cliArtifactChecksum: `sha256:${'6'.repeat(64)}`,
  resolvedAt: '2026-07-14T00:01:00.000Z',
});

const ALL_FIELDS_TASK = Object.freeze({
  prompt: 'task-model cross-surface all-fields fixture',
  branch: 'feature/task-model-cross-surface',
  strategy: 'openspec',
  skills: Object.freeze(['openspec']),
  deadlineMs: 7_200_000,
  idleTimeoutMs: 1_800_000,
  runtime: 'codex',
  model: MODEL,
  sandboxEnvironmentId: null,
  deliver: 'branch',
});

function assertDatabaseConfigured() {
  assert.ok(
    process.env.DATABASE_URL,
    'DATABASE_URL must point to a migrated disposable Postgres database',
  );
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableTaskFields(value) {
  return {
    repoId: value.repoId,
    prompt: value.prompt,
    branch: value.branch,
    strategy: value.strategy,
    skills: value.skills,
    deadlineMs: value.deadlineMs,
    idleTimeoutMs: value.idleTimeoutMs,
    runtime: value.runtime,
    model: value.model,
    sandboxEnvironmentId: value.sandboxEnvironmentId,
    deliver: value.deliver,
    executionMode: value.executionMode,
  };
}

function expectedTaskFields(repoId, executionMode, task = ALL_FIELDS_TASK) {
  return {
    repoId,
    prompt: task.prompt,
    branch: task.branch,
    strategy: task.strategy,
    skills: [...task.skills],
    deadlineMs: task.deadlineMs,
    idleTimeoutMs: task.idleTimeoutMs,
    runtime: task.runtime,
    model: task.model,
    sandboxEnvironmentId: task.sandboxEnvironmentId,
    deliver: task.deliver,
    executionMode,
  };
}

function countModelArguments(line) {
  return line.split('--model "$M"').length - 1;
}

function createDefaultClosedTaskModelCapability() {
  const names = [
    'CAP_TASK_MODEL_SELECTION_ENABLED',
    'CAP_TASK_MODEL_SELECTION_ATTESTATION_JSON',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const capability = new TaskModelCapabilityService();
    const gate = capability.evaluate();
    assert.equal(gate.open, false);
    assert.equal(gate.reason, 'disabled');
    return capability;
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function responseJson(response, expectedStatus) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    assert.fail(`Expected JSON from ${response.url}, received: ${text}`);
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${response.request?.method ?? 'request'} ${response.url}: ${text}`,
  );
  return body;
}

async function openMcpClient(factory, ownerUserId) {
  const server = factory.createServer();
  const client = new Client({
    name: 'task-model-cross-surface-e2e',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: 'mcp_cross_surface_fixture',
        clientId: 'task-model-cross-surface-e2e',
        scopes: ['tasks:read', 'tasks:write', 'repos:read'],
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        resource: 'cap:mcp',
        extra: { userId: ownerUserId },
      },
    });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

test('Console, V1, MCP and schedule recovery preserve one canonical explicit-model contract', async () => {
  assertDatabaseConfigured();
  process.env.SCHEDULED_TASKS_DISABLED = '1';

  const preflightCalls = [];
  let currentSnapshot = SNAPSHOT;
  const preflight = {
    async preflight(input) {
      preflightCalls.push(jsonClone(input));
      if (input.model.endsWith('/unavailable')) {
        return {
          ok: false,
          error: {
            code: 'runtime_model_not_available',
            message: 'The requested runtime model is not available.',
            retryable: false,
            context: { runtime: input.query.runtime, model: input.model },
          },
        };
      }
      if (input.model.endsWith('/catalog-outage')) {
        return {
          ok: false,
          error: {
            code: 'runtime_model_catalog_unavailable',
            message: 'Runtime model discovery is temporarily unavailable.',
            retryable: true,
            context: { runtime: input.query.runtime, model: input.model },
          },
        };
      }
      assert.equal(input.model, MODEL);
      return {
        ok: true,
        value: {
          intent: 'explicit',
          model: MODEL,
          executionEnvironmentSnapshot: currentSnapshot,
        },
      };
    },
  };
  const capability = {
    assertOpen() {},
  };

  let prisma;
  const admission = {
    mode: 'queue',
    calls: [],
    async admit(taskId) {
      this.calls.push({ taskId, mode: this.mode });
      if (this.mode === 'hold') {
        throw new Error('simulated interrupted post-commit admission');
      }
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'queued' },
      });
      return 'queued';
    },
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
    async loadPersistedCeiling() {},
  };

  let app;
  let fixture;
  let mcp;
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GUARDRAILS_SERVICE_TOKEN)
      .useValue(admission)
      .overrideProvider(RuntimeModelPreflightService)
      .useValue(preflight)
      .overrideProvider(TaskModelCapabilityService)
      .useValue(capability)
      .compile();

    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const user = await prisma.user.create({
      data: {
        name: 'Task model cross-surface E2E',
        email: `task-model-cross-surface-${randomUUID()}@example.com`,
        allowed: true,
      },
    });
    const repo = await prisma.repo.create({
      data: {
        name: `task-model-cross-surface-${randomUUID()}`,
        gitSource: 'https://example.invalid/task-model-cross-surface.git',
        copyStatus: 'ready',
        copyUpdatedAt: new Date(),
      },
    });
    const rawApiKey = `cap_sk_${randomUUID().replaceAll('-', '')}`;
    await prisma.apiKey.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(rawApiKey),
        prefix: 'cap_sk_',
        last4: rawApiKey.slice(-4),
        name: 'task-model-cross-surface-e2e',
        scopes: ['tasks:read', 'tasks:write', 'repos:read'],
      },
    });
    fixture = { user, repo };

    const headers = {
      Authorization: `Bearer ${rawApiKey}`,
      'Content-Type': 'application/json',
    };
    const request = async (path, options = {}, expectedStatus = 200) =>
      responseJson(
        await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: { ...headers, ...options.headers },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
        expectedStatus,
      );

    mcp = await openMcpClient(moduleRef.get(McpServerFactory), user.id);

    // One identical, all-fields create fixture through each public task writer.
    const consoleCreated = TaskResponseSchema.parse(
      await request(
        `/repos/${repo.id}/tasks`,
        { method: 'POST', body: ALL_FIELDS_TASK },
        201,
      ),
    );
    const v1Created = TaskResponseSchema.parse(
      await request(
        '/v1/tasks',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `task-model-e2e-${randomUUID()}` },
          body: { repoId: repo.id, ...ALL_FIELDS_TASK },
        },
        201,
      ),
    );
    const mcpCreatedResult = await mcp.client.callTool({
      name: 'create_task',
      arguments: { repoId: repo.id, ...ALL_FIELDS_TASK },
    });
    assert.notEqual(mcpCreatedResult.isError, true);
    const mcpCreated = TaskResponseSchema.parse(
      mcpCreatedResult.structuredContent,
    );

    assert.equal(preflightCalls.length, 3);
    assert.ok(
      preflightCalls.every((call) => call.ownerUserId === user.id),
      'every public writer must resolve the catalog with the authenticated owner id',
    );

    assert.deepEqual(
      stableTaskFields(consoleCreated),
      expectedTaskFields(repo.id, 'interactive-pty'),
    );
    for (const created of [v1Created, mcpCreated]) {
      assert.deepEqual(
        stableTaskFields(created),
        expectedTaskFields(repo.id, 'headless-exec'),
      );
    }

    const directRows = await prisma.task.findMany({
      where: {
        id: { in: [consoleCreated.id, v1Created.id, mcpCreated.id] },
      },
      orderBy: { id: 'asc' },
    });
    assert.equal(directRows.length, 3);
    for (const row of directRows) {
      assert.equal(row.ownerUserId, user.id);
      assert.equal(row.model, MODEL);
      assert.deepEqual(row.executionEnvironmentSnapshot, SNAPSHOT);
      assert.equal(row.status, 'queued');
      assert.deepEqual(
        stableTaskFields({
          ...row,
          executionMode: row.executionMode ?? 'interactive-pty',
        }),
        expectedTaskFields(
          repo.id,
          row.id === consoleCreated.id ? 'interactive-pty' : 'headless-exec',
        ),
      );
    }

    // Real persisted seam: Prisma row -> production provision lookup -> fixed-path
    // launch material -> both fresh Codex launch modes. Retargeting the current
    // resolver after preflight must not change any already-created Task identity.
    currentSnapshot = RETARGETED_SNAPSHOT;
    const provisionLookup = new PrismaProvisionLookup(prisma);
    const runtime = new CodexRuntime();
    for (const created of [consoleCreated, v1Created, mcpCreated]) {
      const launchContext = await provisionLookup.getTaskLaunchContext(created.id);
      assert.equal(launchContext.modelIntent.kind, 'explicit');
      assert.equal(
        launchContext.environment?.metadata?.immutableIdentity,
        SNAPSHOT.immutableIdentity,
      );
      assert.notEqual(
        launchContext.environment?.metadata?.immutableIdentity,
        currentSnapshot.immutableIdentity,
        'a mutable source retarget cannot replace the persisted launch identity',
      );
      const material = taskModelLaunchMaterial(launchContext.modelIntent);
      const runtimeContext = {
        taskId: created.id,
        workspaceDir: '/home/gem/workspace',
        model: material,
      };
      const line =
        created.executionMode === 'headless-exec'
          ? runtime.buildHeadlessLine(runtimeContext)
          : runtime.buildLaunchLine(runtimeContext);
      assert.equal(countModelArguments(line), 1);
      assert.equal(
        line.includes(MODEL),
        false,
        'raw selector text must not enter the nested launch command',
      );
    }
    currentSnapshot = SNAPSHOT;

    // Historical nullable rows remain runtime-default. Restore the row before
    // the transport parity assertions below so the same task still proves the
    // public explicit-model response contract.
    await prisma.task.update({
      where: { id: consoleCreated.id },
      data: {
        model: null,
        executionEnvironmentSnapshot: Prisma.DbNull,
      },
    });
    assert.deepEqual(
      await provisionLookup.getTaskLaunchContext(consoleCreated.id),
      {
        modelIntent: { kind: 'runtime-default' },
        ownerUserId: user.id,
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        workspaceMaterializationDeadlineMs:
          DEFAULT_SANDBOX_GIT_MATERIALIZATION_DEADLINE_MS,
      },
    );
    await prisma.task.update({
      where: { id: consoleCreated.id },
      data: {
        model: MODEL,
        executionEnvironmentSnapshot: SNAPSHOT,
      },
    });

    // Read one persisted task through all three get/list surfaces. Full JSON
    // equality proves they share the canonical TaskResponse projection.
    const consoleGet = await request(`/tasks/${consoleCreated.id}`);
    const v1Get = await request(`/v1/tasks/${consoleCreated.id}`);
    const mcpGetResult = await mcp.client.callTool({
      name: 'get_task',
      arguments: { id: consoleCreated.id },
    });
    assert.notEqual(mcpGetResult.isError, true);
    assert.deepEqual(jsonClone(v1Get), jsonClone(consoleGet));
    assert.deepEqual(jsonClone(mcpGetResult.structuredContent), jsonClone(consoleGet));

    const consoleList = await request('/tasks');
    const v1List = V1ListTasksResponseSchema.parse(
      await request('/v1/tasks?limit=100'),
    );
    const mcpListResult = await mcp.client.callTool({
      name: 'list_tasks',
      arguments: { limit: 100 },
    });
    assert.notEqual(mcpListResult.isError, true);
    const mcpList = V1ListTasksResponseSchema.parse(
      mcpListResult.structuredContent,
    );
    const consoleListed = consoleList.find((item) => item.id === consoleCreated.id);
    const v1Listed = v1List.items.find((item) => item.id === consoleCreated.id);
    const mcpListed = mcpList.items.find((item) => item.id === consoleCreated.id);
    assert.ok(consoleListed && v1Listed && mcpListed);
    assert.deepEqual(jsonClone(v1Listed), jsonClone(consoleListed));
    assert.deepEqual(jsonClone(mcpListed), jsonClone(consoleListed));

    // Schedule path: Console create -> V1 update -> MCP fire -> real recovery.
    const scheduleTask = {
      ...ALL_FIELDS_TASK,
      prompt: 'task-model scheduled all-fields fixture',
    };
    const createdSchedule = ScheduleResponseSchema.parse(
      await request(
        '/schedules',
        {
          method: 'POST',
          body: {
            name: 'Task model cross-surface schedule',
            recurrence: { kind: 'daily', time: '00:00', timezone: 'UTC' },
            overlapPolicy: 'enqueue',
            misfirePolicy: 'fire-once',
            taskTemplate: { repoId: repo.id, ...scheduleTask },
          },
        },
        201,
      ),
    );
    const updatedSchedule = ScheduleResponseSchema.parse(
      await request(`/v1/schedules/${createdSchedule.id}`, {
        method: 'PATCH',
        body: {
          taskTemplate: {
            repoId: repo.id,
            ...scheduleTask,
            branch: 'feature/task-model-schedule-updated',
          },
        },
      }),
    );
    assert.equal(
      updatedSchedule.taskTemplate.branch,
      'feature/task-model-schedule-updated',
    );
    assert.equal(updatedSchedule.taskTemplate.model, MODEL);

    admission.mode = 'hold';
    const dispatchResult = await mcp.client.callTool({
      name: 'dispatch_schedule',
      arguments: { id: createdSchedule.id },
    });
    assert.notEqual(dispatchResult.isError, true);
    const dispatchedSchedule = ScheduleResponseSchema.parse(
      dispatchResult.structuredContent,
    );
    assert.equal(dispatchedSchedule.latestRun?.status, 'created');
    assert.ok(dispatchedSchedule.latestRun?.taskId);

    const runBeforeRecovery = await prisma.taskScheduleRun.findFirstOrThrow({
      where: { scheduleId: createdSchedule.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { task: true },
    });
    assert.equal(runBeforeRecovery.status, 'created');
    assert.equal(runBeforeRecovery.task?.status, 'pending');
    assert.ok(runBeforeRecovery.admissionClaimUntil);
    assert.equal(runBeforeRecovery.task?.model, MODEL);
    assert.deepEqual(
      runBeforeRecovery.task?.executionEnvironmentSnapshot,
      SNAPSHOT,
    );
    assert.deepEqual(
      stableTaskFields({
        ...runBeforeRecovery.task,
        executionMode: runBeforeRecovery.task?.executionMode,
      }),
      expectedTaskFields(repo.id, 'headless-exec', {
        ...scheduleTask,
        branch: 'feature/task-model-schedule-updated',
      }),
    );

    const preflightCountBeforeRecovery = preflightCalls.length;
    await prisma.taskScheduleRun.update({
      where: { id: runBeforeRecovery.id },
      data: { admissionClaimUntil: new Date(0) },
    });
    admission.mode = 'queue';
    const recovered = await moduleRef
      .get(ScheduledTasksService)
      .recoverPendingAdmissions();
    assert.equal(recovered, 1);
    assert.equal(
      preflightCalls.length,
      preflightCountBeforeRecovery,
      'post-commit admission recovery must not re-run model discovery',
    );

    const runAfterRecovery = await prisma.taskScheduleRun.findUniqueOrThrow({
      where: { id: runBeforeRecovery.id },
      include: { task: true },
    });
    assert.equal(runAfterRecovery.task?.status, 'queued');
    assert.equal(runAfterRecovery.admissionClaimToken, null);
    assert.equal(runAfterRecovery.admissionClaimUntil, null);
    assert.equal(runAfterRecovery.task?.model, MODEL);
    assert.deepEqual(
      runAfterRecovery.task?.executionEnvironmentSnapshot,
      SNAPSHOT,
      'recovery must preserve the accepted immutable execution identity',
    );

    const consoleScheduleGet = await request(`/schedules/${createdSchedule.id}`);
    const v1ScheduleGet = await request(`/v1/schedules/${createdSchedule.id}`);
    const mcpScheduleGetResult = await mcp.client.callTool({
      name: 'get_schedule',
      arguments: { id: createdSchedule.id },
    });
    assert.notEqual(mcpScheduleGetResult.isError, true);
    assert.deepEqual(jsonClone(v1ScheduleGet), jsonClone(consoleScheduleGet));
    assert.deepEqual(
      jsonClone(mcpScheduleGetResult.structuredContent),
      jsonClone(consoleScheduleGet),
    );

    const runsResult = await mcp.client.callTool({
      name: 'list_schedule_runs',
      arguments: { id: createdSchedule.id, limit: 100 },
    });
    assert.notEqual(runsResult.isError, true);
    const structuredRuns = V1ListScheduleRunsResponseSchema.parse(
      runsResult.structuredContent,
    );
    assert.equal(structuredRuns.items[0]?.taskId, runAfterRecovery.taskId);
    assert.equal(structuredRuns.items[0]?.taskStatus, 'queued');

    // The recovered scheduled Task is also readable identically through every
    // task transport, with model intent intact and the internal snapshot hidden.
    const scheduledTaskId = runAfterRecovery.taskId;
    assert.ok(scheduledTaskId);
    const scheduledConsoleTask = await request(`/tasks/${scheduledTaskId}`);
    const scheduledV1Task = await request(`/v1/tasks/${scheduledTaskId}`);
    const scheduledMcpTaskResult = await mcp.client.callTool({
      name: 'get_task',
      arguments: { id: scheduledTaskId },
    });
    assert.deepEqual(jsonClone(scheduledV1Task), jsonClone(scheduledConsoleTask));
    assert.deepEqual(
      jsonClone(scheduledMcpTaskResult.structuredContent),
      jsonClone(scheduledConsoleTask),
    );
    assert.equal(scheduledConsoleTask.model, MODEL);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        scheduledConsoleTask,
        'executionEnvironmentSnapshot',
      ),
      false,
    );

    const recoveredLaunchContext = await provisionLookup.getTaskLaunchContext(
      scheduledTaskId,
    );
    assert.equal(recoveredLaunchContext.modelIntent.kind, 'explicit');
    assert.equal(recoveredLaunchContext.executionMode, 'headless-exec');
    assert.equal(
      recoveredLaunchContext.environment?.metadata?.immutableIdentity,
      SNAPSHOT.immutableIdentity,
    );
    const reAdoptedLine = runtime.buildHeadlessLine({
      taskId: scheduledTaskId,
      workspaceDir: '/home/gem/workspace',
      model: taskModelLaunchMaterial(recoveredLaunchContext.modelIntent),
    });
    assert.equal(countModelArguments(reAdoptedLine), 1);

    // Real route/database failure story: both permanent disappearance and a
    // transient catalog outage fail before Task/admission, while a rejected
    // schedule update leaves the existing template and run ledger unchanged.
    const tasksBeforeFailure = await prisma.task.count();
    const runsBeforeFailure = await prisma.taskScheduleRun.count();
    const admissionsBeforeFailure = admission.calls.length;

    const unavailable = await request(
      `/repos/${repo.id}/tasks`,
      {
        method: 'POST',
        body: { ...ALL_FIELDS_TASK, model: `${MODEL}/unavailable` },
      },
      422,
    );
    assert.equal(unavailable.code, 'runtime_model_not_available');

    const outage = await request(
      '/v1/tasks',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `task-model-outage-${randomUUID()}` },
        body: {
          repoId: repo.id,
          ...ALL_FIELDS_TASK,
          model: `${MODEL}/catalog-outage`,
        },
      },
      503,
    );
    assert.equal(outage.code, 'runtime_model_catalog_unavailable');

    const scheduleBeforeRejectedUpdate = await request(
      `/schedules/${createdSchedule.id}`,
    );
    const rejectedUpdate = await request(
      `/schedules/${createdSchedule.id}`,
      {
        method: 'PATCH',
        body: {
          taskTemplate: {
            ...scheduleBeforeRejectedUpdate.taskTemplate,
            model: `${MODEL}/unavailable`,
          },
        },
      },
      422,
    );
    assert.equal(rejectedUpdate.code, 'runtime_model_not_available');
    const scheduleAfterRejectedUpdate = await request(
      `/schedules/${createdSchedule.id}`,
    );
    assert.deepEqual(
      scheduleAfterRejectedUpdate.taskTemplate,
      scheduleBeforeRejectedUpdate.taskTemplate,
    );
    assert.equal(await prisma.task.count(), tasksBeforeFailure);
    assert.equal(await prisma.taskScheduleRun.count(), runsBeforeFailure);
    assert.equal(admission.calls.length, admissionsBeforeFailure);
  } finally {
    await mcp?.close();
    if (prisma && fixture) {
      await prisma.repo
        .delete({ where: { id: fixture.repo.id } })
        .catch(() => undefined);
      await prisma.user
        .delete({ where: { id: fixture.user.id } })
        .catch(() => undefined);
    }
    await app?.close();
  }
});

test('default-closed N gate fences every production write/catalog seam before database acceptance', async () => {
  assertDatabaseConfigured();
  process.env.SCHEDULED_TASKS_DISABLED = '1';

  const closedError = {
    code: 'runtime_model_catalog_unavailable',
    message: 'Runtime model selection is temporarily unavailable.',
    retryable: true,
  };
  const capability = createDefaultClosedTaskModelCapability();
  let preflightCalls = 0;
  let catalogCalls = 0;
  let prisma;
  const admission = {
    calls: [],
    async admit(taskId) {
      this.calls.push(taskId);
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'queued' },
      });
      return 'queued';
    },
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
    async loadPersistedCeiling() {},
  };

  let app;
  let fixture;
  let mcp;
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GUARDRAILS_SERVICE_TOKEN)
      .useValue(admission)
      .overrideProvider(RuntimeModelPreflightService)
      .useValue({
        async preflight() {
          preflightCalls += 1;
          throw new Error('closed gate must precede model preflight');
        },
      })
      .overrideProvider(RuntimeModelCatalogService)
      .useValue({
        async query() {
          catalogCalls += 1;
          throw new Error('closed gate must precede catalog discovery');
        },
      })
      .overrideProvider(TaskModelCapabilityService)
      .useValue(capability)
      .compile();

    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const user = await prisma.user.create({
      data: {
        name: 'Task model closed-gate E2E',
        email: `task-model-closed-gate-${randomUUID()}@example.com`,
        allowed: true,
      },
    });
    const repo = await prisma.repo.create({
      data: {
        name: `task-model-closed-gate-${randomUUID()}`,
        gitSource: 'https://example.invalid/task-model-closed-gate.git',
        copyStatus: 'ready',
        copyUpdatedAt: new Date(),
      },
    });
    const rawApiKey = `cap_sk_${randomUUID().replaceAll('-', '')}`;
    await prisma.apiKey.create({
      data: {
        userId: user.id,
        tokenHash: hashSessionToken(rawApiKey),
        prefix: 'cap_sk_',
        last4: rawApiKey.slice(-4),
        name: 'task-model-closed-gate-e2e',
        scopes: ['tasks:read', 'tasks:write', 'repos:read'],
      },
    });
    fixture = { user, repo };

    const headers = {
      Authorization: `Bearer ${rawApiKey}`,
      'Content-Type': 'application/json',
    };
    const request = async (path, options = {}, expectedStatus = 200) =>
      responseJson(
        await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: { ...headers, ...options.headers },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
        expectedStatus,
      );
    const assertClosedRest = async (path, options) => {
      assert.deepEqual(await request(path, options, 503), closedError);
    };
    const assertClosedMcp = async (name, args) => {
      const result = await mcp.client.callTool({ name, arguments: args });
      assert.equal(
        result.isError,
        true,
        `${name} must fail while the gate is closed`,
      );
      assert.equal(result.structuredContent, undefined);
      assert.deepEqual(
        result._meta?.['com.cloud-agent-platform/public-error'],
        closedError,
      );
      const text = result.content?.find((entry) => entry.type === 'text')?.text;
      assert.deepEqual(JSON.parse(text ?? '{}'), closedError);
    };

    mcp = await openMcpClient(moduleRef.get(McpServerFactory), user.id);

    // In-process metadata is intentionally still static. Production keeps it
    // unreachable with maintenance ingress/MCP disablement, while this test
    // proves that a leaked picker/tool or raw payload cannot become the safety
    // boundary and bypass the server-side gate.
    const openapi = await request('/v1/openapi.json');
    assert.ok(openapi.paths?.['/v1/runtime-models/query']);
    const inventory = await mcp.client.listTools();
    assert.ok(inventory.tools.some((tool) => tool.name === 'list_runtime_models'));

    await assertClosedRest('/v1/runtime-models/query', {
      method: 'POST',
      body: { runtime: 'codex', sandboxEnvironmentId: null },
    });
    await assertClosedMcp('list_runtime_models', {
      runtime: 'codex',
      sandboxEnvironmentId: null,
    });
    assert.equal(catalogCalls, 0, 'gate must run before catalog discovery');

    const explicitTask = {
      prompt: 'closed-gate explicit task',
      runtime: 'codex',
      model: MODEL,
      sandboxEnvironmentId: null,
    };
    await assertClosedRest(`/repos/${repo.id}/tasks`, {
      method: 'POST',
      body: explicitTask,
    });
    await assertClosedRest('/v1/tasks', {
      method: 'POST',
      headers: { 'Idempotency-Key': `closed-gate-${randomUUID()}` },
      body: { repoId: repo.id, ...explicitTask },
    });
    await assertClosedMcp('create_task', {
      repoId: repo.id,
      ...explicitTask,
    });
    assert.equal(await prisma.task.count({ where: { repoId: repo.id } }), 0);
    assert.equal(
      await prisma.idempotencyKey.count({
        where: { scopeUserId: `user:${user.id}` },
      }),
      0,
      'a closed V1 create must not persist an idempotency winner',
    );
    assert.equal(preflightCalls, 0, 'gate must run before model preflight');
    assert.deepEqual(admission.calls, []);

    const explicitScheduleBody = {
      name: 'closed-gate explicit schedule',
      recurrence: { kind: 'daily', time: '00:00', timezone: 'UTC' },
      overlapPolicy: 'enqueue',
      misfirePolicy: 'fire-once',
      taskTemplate: {
        repoId: repo.id,
        ...explicitTask,
        prompt: 'closed-gate scheduled task',
      },
    };
    await assertClosedRest('/schedules', {
      method: 'POST',
      body: explicitScheduleBody,
    });
    await assertClosedRest('/v1/schedules', {
      method: 'POST',
      body: explicitScheduleBody,
    });
    await assertClosedMcp('create_schedule', explicitScheduleBody);
    assert.equal(
      await prisma.taskSchedule.count({ where: { ownerUserId: user.id } }),
      0,
    );
    assert.equal(preflightCalls, 0);

    // Omitted-model creates remain on the existing path on every writer.
    const omittedTask = {
      prompt: 'closed-gate omitted-model task',
      runtime: 'codex',
      sandboxEnvironmentId: null,
    };
    const consoleOmitted = TaskResponseSchema.parse(
      await request(
        `/repos/${repo.id}/tasks`,
        { method: 'POST', body: omittedTask },
        201,
      ),
    );
    const v1Omitted = TaskResponseSchema.parse(
      await request(
        '/v1/tasks',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': `omitted-${randomUUID()}` },
          body: { repoId: repo.id, ...omittedTask },
        },
        201,
      ),
    );
    const mcpOmittedResult = await mcp.client.callTool({
      name: 'create_task',
      arguments: { repoId: repo.id, ...omittedTask },
    });
    assert.notEqual(mcpOmittedResult.isError, true);
    const mcpOmitted = TaskResponseSchema.parse(
      mcpOmittedResult.structuredContent,
    );
    for (const task of [consoleOmitted, v1Omitted, mcpOmitted]) {
      assert.equal(task.model, null);
      assert.equal(task.status, 'pending');
    }
    const omittedRows = await prisma.task.findMany({
      where: {
        id: { in: [consoleOmitted.id, v1Omitted.id, mcpOmitted.id] },
      },
    });
    assert.equal(omittedRows.length, 3);
    assert.ok(omittedRows.every((row) => row.model === null));
    assert.equal(preflightCalls, 0);
    assert.equal(admission.calls.length, 3);

    // Seed one previously accepted explicit template. Every manual transport
    // must reject before a new run, Task, claim, or cadence mutation is written.
    const nextRunAt = new Date(Date.now() + 24 * 60 * 60_000);
    const explicitSchedule = await prisma.taskSchedule.create({
      data: {
        ownerUserId: user.id,
        repoId: repo.id,
        name: 'accepted explicit schedule before gate closure',
        taskTemplate: {
          repoId: repo.id,
          prompt: 'accepted explicit scheduled task',
          runtime: 'codex',
          model: MODEL,
          sandboxEnvironmentId: null,
          deliver: 'none',
        },
        cron: '0 0 * * *',
        timezone: 'UTC',
        enabled: true,
        nextRunAt,
        overlapPolicy: 'enqueue',
        misfirePolicy: 'fire-once',
      },
    });
    const beforeDispatch = await prisma.taskSchedule.findUniqueOrThrow({
      where: { id: explicitSchedule.id },
    });
    const taskCountBeforeDispatch = await prisma.task.count({
      where: { repoId: repo.id },
    });

    await assertClosedRest(`/schedules/${explicitSchedule.id}/dispatch`, {
      method: 'POST',
      body: {},
    });
    await assertClosedRest(`/v1/schedules/${explicitSchedule.id}/dispatch`, {
      method: 'POST',
      body: {},
    });
    await assertClosedMcp('dispatch_schedule', { id: explicitSchedule.id });

    const afterDispatch = await prisma.taskSchedule.findUniqueOrThrow({
      where: { id: explicitSchedule.id },
    });
    assert.equal(
      await prisma.taskScheduleRun.count({
        where: { scheduleId: explicitSchedule.id },
      }),
      0,
    );
    assert.equal(
      await prisma.task.count({ where: { repoId: repo.id } }),
      taskCountBeforeDispatch,
    );
    assert.equal(afterDispatch.nextRunAt?.getTime(), beforeDispatch.nextRunAt?.getTime());
    assert.equal(afterDispatch.updatedAt.getTime(), beforeDispatch.updatedAt.getTime());
    assert.equal(afterDispatch.claimToken, beforeDispatch.claimToken);
    assert.equal(afterDispatch.claimUntil, beforeDispatch.claimUntil);
    assert.equal(preflightCalls, 0);
    assert.equal(catalogCalls, 0);
    assert.equal(admission.calls.length, 3);
  } finally {
    await mcp?.close();
    if (prisma && fixture) {
      await prisma.repo
        .delete({ where: { id: fixture.repo.id } })
        .catch(() => undefined);
      await prisma.user
        .delete({ where: { id: fixture.user.id } })
        .catch(() => undefined);
    }
    await app?.close();
  }
});
