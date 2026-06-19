/**
 * Tests for `V1TasksController` (public-v1-api, tasks 3.1 / 3.2 / 3.4 / 3.7).
 *
 * Covers:
 *   1. `POST /v1/tasks` delegates to the SAME `TasksService.create(repoId, body)`
 *      admission path (D1 — one admission path), passing the body's `repoId` and
 *      the principal's githubId, and runs through the idempotency layer.
 *   2. Keyset pagination (`GET /v1/tasks`) walks the full set in `(createdAt,id)`
 *      order across pages with NO dropped or duplicated row, `nextCursor` null on
 *      the last page (3.2).
 *   3. Scope gates (3.4): a `tasks:read`-only api-key is 403'd on `POST /v1/tasks`
 *      (a write); a scopeless session principal passes every gate; an api-key
 *      WITH `tasks:write` passes create.
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';

import { V1TasksController } from './v1-tasks.controller';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';
import type { TaskResponse } from '@cap/contracts';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

const SESSION_PRINCIPAL: OperatorPrincipal = {
  kind: 'session',
  user: {
    githubId: 4242,
    login: 'octocat',
    name: 'Octo Cat',
    avatarUrl: '',
    allowed: true,
  },
} as OperatorPrincipal;

const READ_ONLY_KEY: OperatorPrincipal = {
  kind: 'api-key',
  user: { githubId: 7, login: 'bot', name: 'Bot', avatarUrl: '', allowed: true },
  scopes: ['tasks:read'],
  keyId: 'key-read',
} as OperatorPrincipal;

const WRITE_KEY: OperatorPrincipal = {
  kind: 'api-key',
  user: { githubId: 8, login: 'bot2', name: 'Bot2', avatarUrl: '', allowed: true },
  scopes: ['tasks:read', 'tasks:write'],
  keyId: 'key-write',
} as OperatorPrincipal;

const reqWith = (principal?: OperatorPrincipal): AuthenticatedRequest =>
  ({ operatorPrincipal: principal }) as AuthenticatedRequest;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A valid v4-shaped UUID whose final hex digit encodes `i`, so ids both pass the
 * contract's `z.string().uuid()` validation AND sort lexicographically by `i`
 * (the keyset tie-break the pagination walk exercises). `i` is bounded to one hex
 * digit (0–15), which is plenty for these fixtures.
 */
function uuidFor(prefix: 'a' | 'b', i: number): string {
  return `00000000-0000-4000-${prefix}000-00000000000${i.toString(16)}`;
}

function makeTaskRow(i: number, createdAt: Date): TaskResponse {
  return {
    id: uuidFor('a', i),
    repoId: '00000000-0000-4000-b000-0000000000ff',
    prompt: `p${i}`,
    status: 'pending',
    createdAt,
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
  } as TaskResponse;
}

/**
 * A passthrough idempotency stub that just runs the admit callback and reports the
 * task as NEWLY created (so the controller runs the post-row admission), mirroring
 * `IdempotencyService.run`'s `{ task, created }` contract.
 */
function passthroughIdempotency(): IdempotencyService {
  return {
    async run(args: {
      admit: (tx: unknown) => Promise<TaskResponse>;
    }): Promise<{ task: TaskResponse; created: boolean }> {
      return { task: await args.admit(undefined), created: true };
    },
  } as unknown as IdempotencyService;
}

// ---------------------------------------------------------------------------
// Create — delegation + scope gate (3.1 / 3.4)
// ---------------------------------------------------------------------------

test('POST /v1/tasks delegates to TasksService.createTaskRow + admitCreatedTask (one admission path)', async () => {
  const rowCalls: Array<{ repoId: string; body: unknown }> = [];
  const admitCalls: Array<{ taskId: string; githubId?: number }> = [];
  const tasksService = {
    // V.1 — the admit callback creates the ROW (on the idempotency tx); the
    // provision is the separate post-commit step.
    async createTaskRow(repoId: string, body: unknown) {
      rowCalls.push({ repoId, body });
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask(taskId: string, _body: unknown, githubId?: number) {
      admitCalls.push({ taskId, githubId });
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await controller.create(
    { repoId: 'repo-1', prompt: 'hello' } as never,
    reqWith(SESSION_PRINCIPAL),
    undefined,
  );

  assert.equal(rowCalls.length, 1, 'exactly one row create via createTaskRow');
  assert.equal(rowCalls[0].repoId, 'repo-1', 'repoId comes from the body');
  assert.ok(
    !(rowCalls[0].body as { repoId?: string }).repoId,
    'repoId is stripped from the create body (it is a route/service arg)',
  );
  assert.equal(admitCalls.length, 1, 'the newly-created task is admitted exactly once');
  assert.equal(admitCalls[0].githubId, 4242, 'admission attributes to the session githubId');
});

test('a tasks:read-only api-key is 403 on POST /v1/tasks and admits nothing', async () => {
  let admitted = false;
  const tasksService = {
    async createTaskRow() {
      admitted = true;
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask() {
      admitted = true;
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await assert.rejects(
    () =>
      controller.create(
        { repoId: 'repo-1', prompt: 'hi' } as never,
        reqWith(READ_ONLY_KEY),
        undefined,
      ),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.equal(admitted, false, 'no task created when the scope gate rejects');
});

test('an api-key WITH tasks:write passes POST /v1/tasks', async () => {
  let rowCreated = false;
  let admitted = false;
  const tasksService = {
    async createTaskRow() {
      rowCreated = true;
      return makeTaskRow(1, new Date());
    },
    async admitCreatedTask() {
      admitted = true;
    },
  } as unknown as TasksService;

  const controller = new V1TasksController(
    tasksService,
    {} as PrismaService,
    passthroughIdempotency(),
  );

  await controller.create(
    { repoId: 'repo-1', prompt: 'hi' } as never,
    reqWith(WRITE_KEY),
    undefined,
  );
  assert.equal(rowCreated, true, 'a tasks:write key creates the task row');
  assert.equal(admitted, true, 'and the newly-created task is admitted (provisioned)');
});

test('a scopeless session principal passes the read gate on GET /v1/tasks', async () => {
  const prisma = {
    task: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const controller = new V1TasksController(
    {} as TasksService,
    prisma,
    passthroughIdempotency(),
  );

  const page = await controller.list({ limit: 50 } as never, reqWith(SESSION_PRINCIPAL));
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});

// ---------------------------------------------------------------------------
// Keyset pagination walks the set with no drop/dup (3.2)
// ---------------------------------------------------------------------------

test('GET /v1/tasks paginates the full set in (createdAt,id) order with no drop/dup', async () => {
  // 10 rows where adjacent PAIRS share a timestamp, so every page boundary that
  // lands mid-pair forces the `(createdAt, id)` id tie-break — the case a
  // createdAt-only cursor would drop or duplicate.
  const base = Date.parse('2026-06-19T00:00:00.000Z');
  const all: TaskResponse[] = [];
  for (let i = 0; i < 10; i += 1) {
    all.push(makeTaskRow(i, new Date(base + Math.floor(i / 2) * 1000)));
  }
  // Sort the source by the same keyset the controller orders on.
  const sorted = [...all].sort((a, b) => {
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const prisma = {
    task: {
      async findMany({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy: unknown;
        take: number;
      }) {
        // Emulate the keyset WHERE against the in-memory sorted set.
        let rows = sorted;
        const or = (where as { OR?: Array<Record<string, { gt?: Date }> | Record<string, unknown>> }).OR;
        if (or) {
          // cursor row = the last returned; reconstruct the boundary from the OR.
          const gtClause = or[0] as { createdAt: { gt: Date } };
          const eqClause = or[1] as { createdAt: Date; id: { gt: string } };
          rows = sorted.filter(
            (r) =>
              r.createdAt.getTime() > gtClause.createdAt.gt.getTime() ||
              (r.createdAt.getTime() === eqClause.createdAt.getTime() &&
                r.id > eqClause.id.gt),
          );
        }
        return rows.slice(0, take);
      },
    },
  } as unknown as PrismaService;

  const controller = new V1TasksController(
    {} as TasksService,
    prisma,
    passthroughIdempotency(),
  );

  // Walk in pages of 3, following nextCursor.
  const seen: string[] = [];
  let cursor: string | undefined;
  let guard = 0;
  do {
    const page = await controller.list(
      { limit: 3, cursor } as never,
      reqWith(SESSION_PRINCIPAL),
    );
    for (const t of page.items) seen.push(t.id);
    cursor = page.nextCursor ?? undefined;
    guard += 1;
    assert.ok(guard < 20, 'pagination must terminate');
  } while (cursor);

  // No drop: every row seen. No dup: each id once. Correct order.
  assert.equal(seen.length, sorted.length, 'every row returned exactly once (no drop)');
  assert.equal(new Set(seen).size, sorted.length, 'no duplicate rows across pages');
  assert.deepEqual(
    seen,
    sorted.map((r) => r.id),
    'rows walked in (createdAt,id) order',
  );
});
