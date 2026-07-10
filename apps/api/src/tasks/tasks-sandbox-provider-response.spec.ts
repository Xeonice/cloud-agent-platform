/**
 * Task response sandbox-provider summary tests
 * (surface-task-sandbox-provider-label).
 *
 * Exercises the real TasksService mapper with a fake Prisma surface. The public
 * response may expose only `{ id, label }`; provider-private routing data must
 * stay out of the task response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TasksService } from './tasks.service';
import { PrismaService } from '../prisma/prisma.service';

const REPO_ID = '00000000-0000-4000-a000-000000000101';

interface FakeSandboxRunRow {
  providerId: string;
  createdAt: Date;
  providerSandboxId?: string;
  connectionJson?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface FakeTaskRow {
  id: string;
  repoId: string;
  prompt: string;
  status: string;
  createdAt: Date;
  branch: string | null;
  strategy: string | null;
  skills: string[];
  idleTimeoutMs: number | null;
  deadlineMs: number | null;
  runtime: string | null;
  executionMode: string | null;
  deliver: string | null;
  deliverStatus: string | null;
  branchPushed: string | null;
  commitSha: string | null;
  changeRequestUrl: string | null;
  changeRequestNumber: number | null;
  sandboxRuns?: FakeSandboxRunRow[];
}

function makeTask(
  id: string,
  sandboxRuns: FakeSandboxRunRow[] = [],
  overrides: Partial<FakeTaskRow> = {},
): FakeTaskRow {
  return {
    id,
    repoId: REPO_ID,
    prompt: `prompt ${id}`,
    status: 'running',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: null,
    executionMode: null,
    deliver: null,
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    sandboxRuns,
    ...overrides,
  };
}

function projectTask(row: FakeTaskRow, args: Record<string, unknown> = {}) {
  const { sandboxRuns: rawSandboxRuns, ...task } = row;
  const include = args.include as
    | {
        sandboxRuns?: {
          orderBy?: { createdAt?: 'asc' | 'desc' };
          take?: number;
          select?: { providerId?: boolean; metadata?: boolean };
        };
      }
    | undefined;

  if (!include?.sandboxRuns) return task;

  const sortedRuns = [...(rawSandboxRuns ?? [])].sort((a, b) => {
    const diff = a.createdAt.getTime() - b.createdAt.getTime();
    return include.sandboxRuns?.orderBy?.createdAt === 'desc' ? -diff : diff;
  });
  const take = include.sandboxRuns.take ?? sortedRuns.length;
  return {
    ...task,
    sandboxRuns: sortedRuns.slice(0, take).map((run) => {
      if (include.sandboxRuns?.select?.providerId) {
        return {
          providerId: run.providerId,
          ...(include.sandboxRuns.select.metadata ? { metadata: run.metadata } : {}),
        };
      }
      return run;
    }),
  };
}

function buildService(rows: FakeTaskRow[]): {
  service: TasksService;
  calls: { findMany: unknown[]; findUnique: unknown[]; update: unknown[] };
} {
  const calls = { findMany: [] as unknown[], findUnique: [] as unknown[], update: [] as unknown[] };
  const prisma = {
    task: {
      findMany: async (args: Record<string, unknown>) => {
        calls.findMany.push(args);
        return [...rows]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((row) => projectTask(row, args));
      },
      findUnique: async (args: { where: { id: string } }) => {
        calls.findUnique.push(args);
        const row = rows.find((candidate) => candidate.id === args.where.id);
        return row ? projectTask(row, args) : null;
      },
      update: async (args: { where: { id: string }; data: { status?: string } }) => {
        calls.update.push(args);
        const row = rows.find((candidate) => candidate.id === args.where.id);
        if (!row) return null;
        if (args.data.status) row.status = args.data.status;
        return projectTask(row, args);
      },
    },
    sandboxRun: {
      findMany() {
        throw new Error('task response enrichment must not issue per-row sandboxRun reads');
      },
      findFirst() {
        throw new Error('task response enrichment must not issue per-row sandboxRun reads');
      },
    },
  } as unknown as PrismaService;

  return { service: new TasksService(prisma), calls };
}

function assertProviderInclude(args: unknown): void {
  const include = (args as { include?: unknown }).include as {
    sandboxRuns?: {
      orderBy?: { createdAt?: string };
      take?: number;
      select?: Record<string, unknown>;
    };
  };
  assert.equal(include.sandboxRuns?.orderBy?.createdAt, 'desc');
  assert.equal(include.sandboxRuns?.take, 1);
  assert.deepEqual(include.sandboxRuns?.select, { providerId: true, metadata: true });
}

function assertNoPrivateProviderFields(row: Record<string, unknown>): void {
  for (const key of [
    'providerSandboxId',
    'connectionJson',
    'endpointUrl',
    'baseUrl',
    'wsUrl',
    'nativeTerminalUrl',
    'token',
    'metadata',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, key),
      false,
      `${key} is not public`,
    );
  }
}

test('list exposes latest BoxLite/AIO provider summaries without per-row sandboxRun reads', async () => {
  const { service, calls } = buildService([
    makeTask('00000000-0000-4000-a000-000000000201', [
      {
        providerId: 'aio-local',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        providerSandboxId: 'aio-secret',
      },
    ]),
    makeTask('00000000-0000-4000-a000-000000000202', [
      {
        providerId: 'aio-local',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        providerId: 'boxlite',
        createdAt: new Date('2026-01-01T01:00:00.000Z'),
        providerSandboxId: 'box-secret',
        connectionJson: { baseUrl: 'http://internal', wsUrl: 'ws://internal' },
        metadata: { provider: 'boxlite' },
      },
    ]),
  ]);

  const listed = await service.list();

  assert.deepEqual(listed[0].sandboxProvider, {
    id: 'aio-local',
    label: 'AIO Sandbox',
  });
  assert.deepEqual(listed[1].sandboxProvider, {
    id: 'boxlite',
    label: 'BoxLite Sandbox',
  });
  assert.equal(listed[1].sandboxMetadata, null);
  assertNoPrivateProviderFields(listed[1] as unknown as Record<string, unknown>);
  assertProviderInclude(calls.findMany[0]);
});

test('task response exposes only the parsed effective sandbox metadata snapshot', async () => {
  const taskId = '00000000-0000-4000-a000-000000000205';
  const snapshot = {
    schemaVersion: 1 as const,
    sandboxVersion: 'v1.2.3',
    dependencies: { codex: '0.132.0', 'company-cli': '4.5.6' },
  };
  const { service } = buildService([
    makeTask(taskId, [
      {
        providerId: 'aio-local',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        metadata: { sandboxMetadata: snapshot, privateField: 'not-public' },
      },
    ]),
  ]);

  const fetched = await service.findById(taskId);

  assert.deepEqual(fetched.sandboxMetadata, snapshot);
  assertNoPrivateProviderFields(fetched as unknown as Record<string, unknown>);
});

test('findById returns null sandboxProvider when no provider has been recorded', async () => {
  const taskId = '00000000-0000-4000-a000-000000000203';
  const { service, calls } = buildService([makeTask(taskId)]);

  const fetched = await service.findById(taskId);

  assert.equal(fetched.sandboxProvider, null);
  assertProviderInclude(calls.findUnique[0]);
});

test('transition response includes the selected provider summary', async () => {
  const taskId = '00000000-0000-4000-a000-000000000204';
  const { service, calls } = buildService([
    makeTask(taskId, [
      {
        providerId: 'boxlite',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
  ]);

  const updated = await service.transition(taskId, 'completed');

  assert.equal(updated.status, 'completed');
  assert.deepEqual(updated.sandboxProvider, {
    id: 'boxlite',
    label: 'BoxLite Sandbox',
  });
  assertProviderInclude(calls.update[0]);
});

test('unknown provider ids use the neutral public label', async () => {
  const taskId = '00000000-0000-4000-a000-000000000205';
  const { service } = buildService([
    makeTask(taskId, [
      {
        providerId: 'future-provider',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
  ]);

  const fetched = await service.findById(taskId);

  assert.deepEqual(fetched.sandboxProvider, {
    id: 'future-provider',
    label: 'Sandbox Provider',
  });
});
