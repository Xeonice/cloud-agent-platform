import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  process.env.TASK_MODEL_N_MINUS_ONE_FIXTURE ??
    resolve(here, 'fixtures/task-model-n-minus-one-release.json'),
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const apiBaseUrl = requiredEnv('N1_API_BASE_URL').replace(/\/$/u, '');
const observedRelease = requiredEnv('N1_OBSERVED_RELEASE');
const evidencePath = resolve(requiredEnv('TASK_MODEL_N_MINUS_ONE_EVIDENCE'));
const prisma = new PrismaClient();
const runId = randomUUID();
const shortRunId = runId.slice(0, 8);
const ownerId = randomUUID();
const repoId = randomUUID();
const sessionId = randomUUID();
const apiKeyId = randomUUID();
const mcpTokenId = randomUUID();
const sessionRaw = `n1_session_${runId}`;
const apiKeyRaw = `cap_sk_n1_${runId}`;
const mcpTokenRaw = `mcp_n1_${runId}`;
const selector =
  'provider/model:v1.2+preview@[region]/family_name;$,=n-minus-one';
const directPrompts = {
  console: `n1-${shortRunId}-console-task`,
  v1: `n1-${shortRunId}-v1-task`,
  mcp: `n1-${shortRunId}-mcp-task`,
};
const nestedNames = {
  console: `n1-${shortRunId}-console-schedule`,
  v1: `n1-${shortRunId}-v1-schedule`,
  mcp: `n1-${shortRunId}-mcp-schedule`,
};

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertObject(value, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function assertModelOmitted(value, label) {
  const object = assertObject(value, label);
  assert.equal(
    Object.prototype.hasOwnProperty.call(object, 'model'),
    false,
    `${label} must expose the N-1 model stripping hazard`,
  );
}

async function requestJson(path, options, expectedStatus) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(
        `${options.method ?? 'GET'} ${path} returned non-JSON status ${response.status}`,
      );
    }
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? 'GET'} ${path} failed: ${JSON.stringify(body)}`,
  );
  return body;
}

function taskBody(prompt) {
  return {
    prompt,
    runtime: 'codex',
    model: selector,
  };
}

function scheduleBody(name, prompt) {
  return {
    name,
    cronExpression: '0 0 * * *',
    timezone: 'UTC',
    enabled: false,
    taskTemplate: {
      repoId,
      ...taskBody(prompt),
    },
  };
}

function sessionHeaders() {
  return { cookie: `cap_session=${sessionRaw}` };
}

function apiKeyHeaders(extra = {}) {
  return { authorization: `Bearer ${apiKeyRaw}`, ...extra };
}

async function seed() {
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: ownerId,
        name: 'N-1 compatibility owner',
        email: `n1-${runId}@example.test`,
        role: 'admin',
        allowed: true,
        mustChangePassword: false,
      },
    });
    await tx.repo.create({
      data: {
        id: repoId,
        name: 'N-1 compatibility repository',
        gitSource: 'https://example.invalid/n1-compat.git',
      },
    });
    await tx.session.create({
      data: {
        id: sessionId,
        userId: ownerId,
        tokenHash: sha256(sessionRaw),
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    await tx.apiKey.create({
      data: {
        id: apiKeyId,
        userId: ownerId,
        tokenHash: sha256(apiKeyRaw),
        prefix: 'cap_sk_',
        last4: apiKeyRaw.slice(-4),
        name: 'N-1 compatibility API key',
        scopes: ['tasks:read', 'tasks:write', 'repos:read'],
      },
    });
    await tx.mcpToken.create({
      data: {
        id: mcpTokenId,
        userId: ownerId,
        tokenHash: sha256(mcpTokenRaw),
        prefix: 'mcp_',
        last4: mcpTokenRaw.slice(-4),
        name: 'N-1 compatibility MCP token',
        scopes: ['tasks:read', 'tasks:write', 'repos:read'],
      },
    });
    await tx.systemSettings.upsert({
      where: { id: 'system' },
      create: {
        id: 'system',
        maxConcurrentTasks: 1,
        mcpServerEnabled: true,
      },
      update: { maxConcurrentTasks: 1, mcpServerEnabled: true },
    });
  });
}

async function createVictimSchedules() {
  const surfaces = ['console', 'v1', 'mcp'];
  const victims = {};
  for (const surface of surfaces) {
    const prompt = `n1-${shortRunId}-${surface}-victim-before`;
    const row = await prisma.taskSchedule.create({
      data: {
        ownerUserId: ownerId,
        repoId,
        name: `n1-${shortRunId}-${surface}-victim`,
        taskTemplate: {
          repoId,
          prompt,
          runtime: 'codex',
          model: selector,
          sandboxEnvironmentId: null,
          deliver: 'none',
        },
        cron: '0 0 * * *',
        timezone: 'UTC',
        enabled: false,
        nextRunAt: null,
      },
    });
    assert.equal(row.taskTemplate.model, selector);
    victims[surface] = row.id;
  }
  return victims;
}

async function exerciseRest(victims) {
  const consoleTask = await requestJson(
    `/repos/${repoId}/tasks`,
    { method: 'POST', headers: sessionHeaders(), body: taskBody(directPrompts.console) },
    201,
  );
  assertModelOmitted(consoleTask, 'N-1 Console task response');

  const v1Task = await requestJson(
    '/v1/tasks',
    {
      method: 'POST',
      headers: apiKeyHeaders({ 'idempotency-key': randomUUID() }),
      body: { repoId, ...taskBody(directPrompts.v1) },
    },
    201,
  );
  assertModelOmitted(v1Task, 'N-1 Public V1 task response');

  const consoleSchedule = await requestJson(
    '/schedules',
    {
      method: 'POST',
      headers: sessionHeaders(),
      body: scheduleBody(
        nestedNames.console,
        `n1-${shortRunId}-console-schedule-create`,
      ),
    },
    201,
  );
  assertModelOmitted(
    consoleSchedule.taskTemplate,
    'N-1 Console schedule template response',
  );

  const v1Schedule = await requestJson(
    '/v1/schedules',
    {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: scheduleBody(
        nestedNames.v1,
        `n1-${shortRunId}-v1-schedule-create`,
      ),
    },
    201,
  );
  assertModelOmitted(
    v1Schedule.taskTemplate,
    'N-1 Public V1 schedule template response',
  );

  const consoleUpdatedPrompt = `n1-${shortRunId}-console-victim-after`;
  const consoleVictim = await requestJson(
    `/schedules/${victims.console}`,
    {
      method: 'PATCH',
      headers: sessionHeaders(),
      body: { taskTemplate: { repoId, ...taskBody(consoleUpdatedPrompt) } },
    },
    200,
  );
  assert.equal(consoleVictim.taskTemplate.prompt, consoleUpdatedPrompt);
  assertModelOmitted(
    consoleVictim.taskTemplate,
    'N-1 Console updated schedule template',
  );

  const v1UpdatedPrompt = `n1-${shortRunId}-v1-victim-after`;
  const v1Victim = await requestJson(
    `/v1/schedules/${victims.v1}`,
    {
      method: 'PATCH',
      headers: apiKeyHeaders(),
      body: { taskTemplate: { repoId, ...taskBody(v1UpdatedPrompt) } },
    },
    200,
  );
  assert.equal(v1Victim.taskTemplate.prompt, v1UpdatedPrompt);
  assertModelOmitted(
    v1Victim.taskTemplate,
    'N-1 Public V1 updated schedule template',
  );

  return {
    taskIds: { console: consoleTask.id, v1: v1Task.id },
    scheduleIds: {
      console: consoleSchedule.id,
      v1: v1Schedule.id,
    },
    victimIds: {
      console: victims.console,
      v1: victims.v1,
      mcp: victims.mcp,
    },
    updatedPrompts: {
      console: consoleUpdatedPrompt,
      v1: v1UpdatedPrompt,
    },
  };
}

async function exerciseMcp(victimId) {
  const client = new Client({ name: 'cap-n1-compat', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${apiBaseUrl}/mcp`),
    {
      requestInit: {
        headers: { authorization: `Bearer ${mcpTokenRaw}` },
      },
    },
  );
  try {
    await client.connect(transport);
    const inventory = await client.listTools();
    assert.equal(inventory.tools.length, 16, 'v0.38.0 must expose 16 MCP tools');
    assert.equal(
      inventory.tools.some((tool) => tool.name === 'list_runtime_models'),
      false,
    );
    const createTaskTool = inventory.tools.find(
      (tool) => tool.name === 'create_task',
    );
    const createScheduleTool = inventory.tools.find(
      (tool) => tool.name === 'create_schedule',
    );
    assert.ok(createTaskTool && createScheduleTool);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        createTaskTool.inputSchema.properties ?? {},
        'model',
      ),
      false,
      'N-1 MCP create_task must advertise no model field',
    );
    const advertisedTemplate =
      createScheduleTool.inputSchema.properties?.taskTemplate;
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        advertisedTemplate?.properties ?? {},
        'model',
      ),
      false,
      'N-1 MCP schedule template must advertise no model field',
    );

    const direct = await client.callTool({
      name: 'create_task',
      arguments: { repoId, ...taskBody(directPrompts.mcp) },
    });
    assert.notEqual(direct.isError, true, JSON.stringify(direct.content));
    assertModelOmitted(direct.structuredContent, 'N-1 MCP task response');

    const nested = await client.callTool({
      name: 'create_schedule',
      arguments: scheduleBody(
        nestedNames.mcp,
        `n1-${shortRunId}-mcp-schedule-create`,
      ),
    });
    assert.notEqual(nested.isError, true, JSON.stringify(nested.content));
    const nestedContent = assertObject(
      nested.structuredContent,
      'N-1 MCP schedule response',
    );
    assertModelOmitted(
      nestedContent.taskTemplate,
      'N-1 MCP schedule template response',
    );

    const updatedPrompt = `n1-${shortRunId}-mcp-victim-after`;
    const updated = await client.callTool({
      name: 'update_schedule',
      arguments: {
        id: victimId,
        taskTemplate: { repoId, ...taskBody(updatedPrompt) },
      },
    });
    assert.notEqual(updated.isError, true, JSON.stringify(updated.content));
    const updatedContent = assertObject(
      updated.structuredContent,
      'N-1 MCP updated schedule response',
    );
    assert.equal(updatedContent.taskTemplate.prompt, updatedPrompt);
    assertModelOmitted(
      updatedContent.taskTemplate,
      'N-1 MCP updated schedule template',
    );

    return {
      toolCount: inventory.tools.length,
      taskId: direct.structuredContent.id,
      scheduleId: nestedContent.id,
      updatedPrompt,
    };
  } finally {
    await client.close();
  }
}

async function verifyDatabase(rest, mcp, victims) {
  const tasks = await prisma.task.findMany({
    where: { prompt: { in: Object.values(directPrompts) } },
    select: {
      id: true,
      prompt: true,
      ownerUserId: true,
      runtime: true,
      model: true,
      executionEnvironmentSnapshot: true,
      executionMode: true,
    },
    orderBy: { prompt: 'asc' },
  });
  assert.equal(tasks.length, 3);
  const expectedIds = new Set([
    rest.taskIds.console,
    rest.taskIds.v1,
    mcp.taskId,
  ]);
  for (const task of tasks) {
    assert.ok(expectedIds.has(task.id));
    assert.equal(task.ownerUserId, ownerId);
    assert.equal(task.runtime, 'codex');
    assert.equal(task.model, null, `${task.prompt} silently lost model intent`);
    assert.equal(task.executionEnvironmentSnapshot, null);
    assert.equal(
      task.executionMode,
      task.prompt === directPrompts.console ? null : 'headless-exec',
    );
  }

  const createdScheduleIds = [
    rest.scheduleIds.console,
    rest.scheduleIds.v1,
    mcp.scheduleId,
  ];
  const createdSchedules = await prisma.taskSchedule.findMany({
    where: { id: { in: createdScheduleIds } },
    select: { id: true, ownerUserId: true, taskTemplate: true },
  });
  assert.equal(createdSchedules.length, 3);
  for (const schedule of createdSchedules) {
    assert.equal(schedule.ownerUserId, ownerId);
    assertModelOmitted(
      schedule.taskTemplate,
      `persisted N-1 create schedule ${schedule.id}`,
    );
  }

  const victimRows = await prisma.taskSchedule.findMany({
    where: { id: { in: Object.values(victims) } },
    select: { id: true, taskTemplate: true },
  });
  assert.equal(victimRows.length, 3);
  const expectedPrompts = new Map([
    [victims.console, rest.updatedPrompts.console],
    [victims.v1, rest.updatedPrompts.v1],
    [victims.mcp, mcp.updatedPrompt],
  ]);
  for (const victim of victimRows) {
    assert.equal(victim.taskTemplate.prompt, expectedPrompts.get(victim.id));
    assertModelOmitted(
      victim.taskTemplate,
      `persisted N-1 updated schedule ${victim.id}`,
    );
  }

  return { tasks, createdSchedules, victimRows };
}

async function writeEvidence(rest, mcp, database) {
  const createdScheduleSurfaces = new Map([
    [rest.scheduleIds.console, 'console-rest'],
    [rest.scheduleIds.v1, 'public-v1'],
    [mcp.scheduleId, 'streamable-http-mcp'],
  ]);
  const victimSurfaces = new Map([
    [rest.victimIds?.console, 'console-rest'],
    [rest.victimIds?.v1, 'public-v1'],
    [rest.victimIds?.mcp, 'streamable-http-mcp'],
  ]);
  const evidence = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    predecessor: {
      schemaVersion: fixture.schemaVersion,
      release: fixture.release,
      observedRelease,
      image: fixture.image,
      platform: fixture.platform,
      tagDigest: fixture.tagDigest,
      platformDigest: fixture.platformDigest,
    },
    assertions: {
      realWriters: ['console-rest', 'public-v1', 'streamable-http-mcp'],
      mcpToolCount: mcp.toolCount,
      directCreates: database.tasks.map((task) => ({
        surface:
          task.prompt === directPrompts.console
            ? 'console-rest'
            : task.prompt === directPrompts.v1
              ? 'public-v1'
              : 'streamable-http-mcp',
        responseOmittedModel: true,
        persistedModel: task.model,
        persistedSnapshot: task.executionEnvironmentSnapshot,
        executionMode: task.executionMode,
      })),
      nestedCreates: database.createdSchedules.map((schedule) => ({
        surface: createdScheduleSurfaces.get(schedule.id),
        responseOmittedModel: true,
        persistedTemplateOmittedModel: !Object.prototype.hasOwnProperty.call(
          schedule.taskTemplate,
          'model',
        ),
      })),
      destructiveNMinusOneUpdates: database.victimRows.map((schedule) => ({
        surface: victimSurfaces.get(schedule.id),
        modelExistedBeforeUpdate: true,
        nonModelPromptUpdatePersisted: true,
        modelRemovedByNMinusOneWriter: !Object.prototype.hasOwnProperty.call(
          schedule.taskTemplate,
          'model',
        ),
      })),
      maintenanceCutoverRequired: true,
    },
  };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `task-model N-1 compatibility evidence written to ${evidencePath}\n`,
  );
}

try {
  assert.equal(fixture.schemaVersion, 1);
  assert.match(fixture.release, /^v\d+\.\d+\.\d+$/u);
  assert.equal(observedRelease, fixture.release);
  assert.match(fixture.platformDigest, /^sha256:[a-f0-9]{64}$/u);
  await seed();
  const victims = await createVictimSchedules();
  const rest = await exerciseRest(victims);
  const mcp = await exerciseMcp(victims.mcp);
  const database = await verifyDatabase(rest, mcp, victims);
  await writeEvidence(rest, mcp, database);
} finally {
  await prisma.$disconnect();
}
