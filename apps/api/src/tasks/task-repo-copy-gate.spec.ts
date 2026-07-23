/**
 * add-repo-content-store (5.1 / 5.2) — task creation gates on repo-copy readiness.
 *
 * Requirement: "repo-and-task-management/Repo carries a content-copy status and
 * task creation gates on copy readiness".
 *
 * Covers, against the REAL `TasksService` create path with a fake Prisma:
 *   1. `missing` / `refreshing` / `failed` are rejected with the stable code,
 *      409, the current copy status, and copy naming `refresh-copy`
 *   2. `ready` is admitted
 *   3. an upgraded pre-content-store Repo (DB default `missing`) is rejected and
 *      pointed at `refresh-copy` — the one entry point that also ACQUIRES
 *   4. an unrecognized stored status fails closed (never read as ready)
 *   5. nothing is written when the gate rejects, and an ALREADY-ACCEPTED task is
 *      unaffected by its Repo's copy status moving afterwards
 *   6. `/v1` and MCP inherit the rejection through the existing public error
 *      boundary (409 + preserved body; MCP `conflict` envelope + message)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLIC_V1_OPERATIONS,
  TASK_REPO_COPY_NOT_READY_ERROR,
  TaskRepoCopyNotReadyErrorSchema,
  type PublicV1OperationShape,
} from '@cap/contracts';

import { TasksService, type IAgentRuntimeRegistry } from './tasks.service';
import {
  RepoCopyNotReadyException,
  classifyRepoCopyGate,
} from './task-repo-copy-gate';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizePublicSurfaceFailure,
  projectPublicSurfaceErrorToMcp,
  projectPublicV1SurfaceErrorToRest,
} from '../public-surface/public-surface-error';

const REPO_ID = '00000000-0000-4000-c000-000000000001';
const TASK_ID = '00000000-0000-4000-c000-000000000002';

interface GateHarness {
  readonly service: TasksService;
  readonly repoReads: () => number;
  readonly createdTasks: () => number;
  readonly setCopyStatus: (status: string | null | undefined) => void;
}

/**
 * A fake Prisma whose Repo row carries the given copy status. `undefined` omits
 * the column entirely, which is how an adapter that predates the content store
 * (never a real row: the column is NOT NULL with a `missing` default) reads.
 */
function makeHarness(copyStatus: string | null | undefined): GateHarness {
  let currentCopyStatus = copyStatus;
  let repoReads = 0;
  let createdTasks = 0;

  const repoRow = () => ({
    id: REPO_ID,
    name: 'Gated Repo',
    gitSource: 'https://github.com/test/repo',
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    description: null,
    defaultBranch: null,
    branchCount: null,
    updatedAt: null,
    githubId: null,
    isDefault: false,
    ...(currentCopyStatus === undefined
      ? {}
      : { copyStatus: currentCopyStatus, copyUpdatedAt: null }),
  });

  let taskRow: Record<string, unknown> | null = null;

  const prisma = {
    repo: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        repoReads += 1;
        return where.id === REPO_ID ? repoRow() : null;
      },
    },
    accountSettings: { findUnique: async () => null },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdTasks += 1;
        taskRow = {
          id: TASK_ID,
          repoId: REPO_ID,
          prompt: data.prompt,
          status: 'pending',
          createdAt: new Date('2026-07-20T00:00:01.000Z'),
          branch: null,
          strategy: null,
          skills: [],
          idleTimeoutMs: null,
          deadlineMs: null,
          runtime: null,
        };
        return taskRow;
      },
      findMany: async () => [],
      findUnique: async () => taskRow,
    },
  } as unknown as PrismaService;

  const registry: IAgentRuntimeRegistry = {
    resolve(runtime) {
      return {
        id: runtime ?? 'codex',
        executionModes: new Set(['interactive-pty', 'headless-exec'] as const),
      };
    },
  };

  // Positional DI: (prisma, guardrails?, audit?, sandbox?, runtimes?, ...).
  const service = new TasksService(prisma, undefined, undefined, undefined, registry);

  return {
    service,
    repoReads: () => repoReads,
    createdTasks: () => createdTasks,
    setCopyStatus: (status) => {
      currentCopyStatus = status;
    },
  };
}

async function rejection(
  harness: GateHarness,
): Promise<RepoCopyNotReadyException> {
  let caught: unknown;
  try {
    await harness.service.create(REPO_ID, { prompt: 'hello' }, 'owner-1');
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof RepoCopyNotReadyException,
    `expected a RepoCopyNotReadyException, got ${String(caught)}`,
  );
  return caught;
}

function operationById(id: string): PublicV1OperationShape {
  const operation = PUBLIC_V1_OPERATIONS.find((entry) => entry.id === id);
  assert.ok(operation, `missing public v1 operation ${id}`);
  return operation;
}

// ---------------------------------------------------------------------------
// 1 + 3 + 4: non-ready copy states are rejected with actionable, stable errors
// ---------------------------------------------------------------------------

for (const status of ['missing', 'refreshing', 'failed'] as const) {
  test(`create against a repo whose copy is "${status}" is rejected with task_repo_copy_not_ready`, async () => {
    const harness = makeHarness(status);
    const error = await rejection(harness);

    assert.equal(error.getStatus(), 409, 'a copy-readiness refusal is a 409');
    assert.equal(error.copyStatus, status);

    const body = TaskRepoCopyNotReadyErrorSchema.parse(error.getResponse());
    assert.equal(body.error, TASK_REPO_COPY_NOT_READY_ERROR);
    assert.equal(body.repoId, REPO_ID);
    assert.equal(body.copyStatus, status);
    assert.match(
      body.message,
      new RegExp(`copyStatus "${status}"`),
      'the message must name the CURRENT copy status',
    );
    assert.match(
      body.message,
      /POST \/repos\/[0-9a-f-]+\/refresh-copy/,
      'the message must name the refresh-copy retry path',
    );

    assert.equal(
      harness.createdTasks(),
      0,
      'a rejected create must not write a task row',
    );
  });
}

test('a repo upgraded from before the content store (DB default "missing") is refused and pointed at refresh-copy', async () => {
  // The Prisma column default after migration. This is exactly what every
  // pre-existing Repo reads as until an operator triggers acquisition, and
  // `refresh-copy` is the single entry point that also ACQUIRES a missing copy.
  const harness = makeHarness('missing');
  const error = await rejection(harness);

  const body = TaskRepoCopyNotReadyErrorSchema.parse(error.getResponse());
  assert.equal(body.copyStatus, 'missing');
  assert.ok(
    body.message.includes(`POST /repos/${REPO_ID}/refresh-copy`),
    'the remedy must name the concrete refresh-copy path for this repo',
  );
  assert.equal(harness.createdTasks(), 0);
});

test('an unrecognized stored copy status fails closed as "unknown" (never read as ready)', async () => {
  const harness = makeHarness('half-written');
  const error = await rejection(harness);

  assert.equal(error.copyStatus, 'unknown');
  const body = TaskRepoCopyNotReadyErrorSchema.parse(error.getResponse());
  assert.equal(body.copyStatus, 'unknown');
  assert.match(body.message, /refresh-copy/);
  assert.equal(harness.createdTasks(), 0);
});

test('classifyRepoCopyGate admits only "ready"; an absent column stays admitting for pre-content-store adapters', () => {
  assert.equal(classifyRepoCopyGate('ready'), 'ready');
  assert.equal(classifyRepoCopyGate('missing'), 'missing');
  assert.equal(classifyRepoCopyGate('refreshing'), 'refreshing');
  assert.equal(classifyRepoCopyGate('failed'), 'failed');
  assert.equal(classifyRepoCopyGate('nonsense'), 'unknown');
  // A real row ALWAYS carries the column (NOT NULL + default), so this branch
  // only ever sees an adapter that predates the content store.
  assert.equal(classifyRepoCopyGate(undefined), 'ready');
  assert.equal(classifyRepoCopyGate(null), 'ready');
});

// ---------------------------------------------------------------------------
// 2 + 5: ready is admitted, and an accepted task ignores later status changes
// ---------------------------------------------------------------------------

test('create against a repo whose copy is "ready" is admitted', async () => {
  const harness = makeHarness('ready');

  const task = await harness.service.create(
    REPO_ID,
    { prompt: 'hello' },
    'owner-1',
  );

  assert.equal(task.id, TASK_ID);
  assert.equal(task.repoId, REPO_ID);
  assert.equal(harness.createdTasks(), 1);
});

test('an already-accepted task is unaffected when its repo copy later goes not-ready', async () => {
  const harness = makeHarness('ready');
  const task = await harness.service.create(
    REPO_ID,
    { prompt: 'hello' },
    'owner-1',
  );
  const readsAfterCreate = harness.repoReads();

  // The copy fails/expires while the task is already in flight.
  harness.setCopyStatus('failed');

  // Post-commit dispatch (the shared Console/`/v1`/MCP admission wake) and the
  // read path keep working: the gate is a CREATE-time check only.
  await harness.service.admitCreatedTask(task.id, { prompt: 'hello' }, 'owner-1');
  const readBack = await harness.service.findById(task.id);
  assert.equal(readBack?.id, TASK_ID);
  assert.equal(
    harness.repoReads(),
    readsAfterCreate,
    'supplying an accepted task must not re-read the repo copy status',
  );

  // ...while a NEW create against the same repo is now refused.
  await rejection(harness);
});

// ---------------------------------------------------------------------------
// 6: the public boundary carries the refusal to /v1 and MCP
// ---------------------------------------------------------------------------

test('the /v1 tasks.create boundary projects the refusal as 409 with the stable body preserved', () => {
  const operation = operationById('tasks.create');
  const normalized = normalizePublicSurfaceFailure(
    new RepoCopyNotReadyException(REPO_ID, 'missing'),
  );

  assert.equal(
    normalized.code,
    'conflict',
    'a copy-readiness refusal maps onto the already-declared conflict code',
  );
  const projected = projectPublicV1SurfaceErrorToRest(operation, normalized);
  assert.equal(projected.status, 409);

  const body = TaskRepoCopyNotReadyErrorSchema.parse(projected.body);
  assert.equal(body.error, TASK_REPO_COPY_NOT_READY_ERROR);
  assert.equal(body.copyStatus, 'missing');
  assert.match(body.message, /refresh-copy/);
});

test('the MCP create_task boundary carries the refusal in its declared safe envelope', () => {
  const operation = operationById('tasks.create');
  assert.ok(
    (operation.errors as readonly string[]).includes('conflict'),
    'create_task must declare conflict so the refusal is not an internal error',
  );

  const normalized = normalizePublicSurfaceFailure(
    new RepoCopyNotReadyException(REPO_ID, 'refreshing'),
  );
  const mcp = projectPublicSurfaceErrorToMcp(normalized);

  assert.equal(mcp.data.code, 'conflict');
  assert.equal(mcp.data.retryable, false);
  assert.match(mcp.data.message, /copyStatus "refreshing"/);
  assert.match(mcp.data.message, /refresh-copy/);
});
