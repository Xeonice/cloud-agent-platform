/**
 * Tests for `IdempotencyService` (public-v1-api, task 3.3 / 3.7).
 *
 * Covers the `Idempotency-Key` dedup contract on `POST /v1/tasks`:
 *   1. The first winner atomically commits its Task, admission work, and key.
 *   2. Any key-write or concurrent-commit loser rolls back all staged acceptance.
 *   3. Same-body replay/race returns the winner without a second work item.
 *   4. Different-body replay/race returns 409 without a second work item.
 *   5. An expired record permits a fresh acceptance; canonical body hashing is
 *      stable across object key ordering.
 *
 * Run from apps/api with `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';

import {
  IdempotencyService,
  type TaskCreator,
} from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TaskResponse } from '@cap/contracts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SCOPE = 'github:123';

interface KeyRow {
  key: string;
  scopeUserId: string;
  requestHash: string;
  taskId: string;
  expiresAt: Date;
}

interface AdmissionWorkRow {
  taskId: string;
  state: 'accepted';
}

interface FakePrismaOptions {
  /** Error surfaced by a transaction that loses a concurrent key commit. */
  concurrentConflict?: 'p2002' | 'ordinary';
  /** One-shot failure injected at the idempotency-key insert. */
  keyCreateError?: Error;
  onRootKeyLookup?: (lookup: {
    scopeUserId: string;
    key: string;
    row: KeyRow | null;
  }) => void;
}

interface FakeTaskDelegate {
  create(args: { data: TaskResponse }): Promise<TaskResponse>;
}

interface FakeAdmissionWorkDelegate {
  create(args: { data: AdmissionWorkRow }): Promise<AdmissionWorkRow>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeBarrier(parties: number): () => Promise<void> {
  const released = deferred<void>();
  let arrivals = 0;
  return async () => {
    arrivals += 1;
    assert.ok(arrivals <= parties, 'barrier received too many arrivals');
    if (arrivals === parties) released.resolve();
    await released.promise;
  };
}

/**
 * A transaction-aware in-memory fake of the Prisma surface used by these tests.
 * Each callback writes to a private snapshot. Its task, admission-work, and key
 * mutations are validated and published synchronously as one atomic commit. A
 * concurrent transaction based on an older snapshot therefore either commits
 * all three rows or loses the key race and publishes none of them.
 */
function makeFakePrisma(options: FakePrismaOptions = {}) {
  const rows = new Map<string, KeyRow>();
  const tasks = new Map<string, TaskResponse>();
  const works = new Map<string, AdmissionWorkRow>();
  const compositeKey = (scopeUserId: string, key: string) => `${scopeUserId}\u0000${key}`;
  let nextKeyCreateError = options.keyCreateError;

  const makeIdempotencyDelegate = (
    store: Map<string, KeyRow>,
    injectCreateFailure: boolean,
  ) => ({
    async findUnique({
      where,
    }: {
      where: { scopeUserId_key: { scopeUserId: string; key: string } };
    }) {
      const { scopeUserId, key } = where.scopeUserId_key;
      const row = store.get(compositeKey(scopeUserId, key)) ?? null;
      if (store === rows) {
        options.onRootKeyLookup?.({ scopeUserId, key, row });
      }
      return row;
    },
    async create({ data }: { data: KeyRow }) {
      if (injectCreateFailure && nextKeyCreateError) {
        const error = nextKeyCreateError;
        nextKeyCreateError = undefined;
        throw error;
      }
      const k = compositeKey(data.scopeUserId, data.key);
      if (store.has(k)) throw uniqueConstraintError();
      const row = { ...data };
      store.set(k, row);
      return row;
    },
    async delete({
      where,
    }: {
      where: { scopeUserId_key: { scopeUserId: string; key: string } };
    }) {
      store.delete(
        compositeKey(
          where.scopeUserId_key.scopeUserId,
          where.scopeUserId_key.key,
        ),
      );
      return {};
    },
    async deleteMany({
      where,
    }: {
      where: {
        scopeUserId: string;
        key: string;
        requestHash?: string;
        taskId?: string;
        expiresAt?: { lte: Date };
      };
    }) {
      const k = compositeKey(where.scopeUserId, where.key);
      const current = store.get(k);
      const matches =
        current !== undefined &&
        (where.requestHash === undefined ||
          current.requestHash === where.requestHash) &&
        (where.taskId === undefined || current.taskId === where.taskId) &&
        (where.expiresAt === undefined ||
          current.expiresAt <= where.expiresAt.lte);
      if (matches) store.delete(k);
      return { count: matches ? 1 : 0 };
    },
  });

  const makeTransactionClient = (
    stagedRows: Map<string, KeyRow>,
    stagedTasks: Map<string, TaskResponse>,
    stagedWorks: Map<string, AdmissionWorkRow>,
  ): PrismaService =>
    ({
      idempotencyKey: makeIdempotencyDelegate(stagedRows, true),
      task: {
        async create({ data }: { data: TaskResponse }) {
          if (stagedTasks.has(data.id)) throw uniqueConstraintError();
          stagedTasks.set(data.id, data);
          return data;
        },
      },
      taskAdmissionWork: {
        async create({ data }: { data: AdmissionWorkRow }) {
          if (stagedWorks.has(data.taskId)) throw uniqueConstraintError();
          stagedWorks.set(data.taskId, data);
          return data;
        },
      },
    }) as unknown as PrismaService;

  const prisma = {
    idempotencyKey: makeIdempotencyDelegate(rows, false),
    async $transaction<T>(cb: (tx: PrismaService) => Promise<T>): Promise<T> {
      const initialRows = new Map(rows);
      const initialTasks = new Map(tasks);
      const initialWorks = new Map(works);
      const stagedRows = new Map(initialRows);
      const stagedTasks = new Map(initialTasks);
      const stagedWorks = new Map(initialWorks);
      const tx = makeTransactionClient(stagedRows, stagedTasks, stagedWorks);

      // A throw from the callback drops every staged mutation.
      const result = await cb(tx);

      // Validate every touched unique key before publishing any mutation. This
      // block has no await, so validation + publication is atomic in the fake.
      for (const key of touchedKeys(initialRows, stagedRows)) {
        if (rows.get(key) !== initialRows.get(key)) {
          throw concurrentCommitError(options.concurrentConflict ?? 'p2002');
        }
      }
      for (const taskId of touchedKeys(initialTasks, stagedTasks)) {
        if (tasks.get(taskId) !== initialTasks.get(taskId)) {
          throw concurrentCommitError(options.concurrentConflict ?? 'p2002');
        }
      }
      for (const taskId of touchedKeys(initialWorks, stagedWorks)) {
        if (works.get(taskId) !== initialWorks.get(taskId)) {
          throw concurrentCommitError(options.concurrentConflict ?? 'p2002');
        }
      }

      publishChanges(rows, initialRows, stagedRows);
      publishChanges(tasks, initialTasks, stagedTasks);
      publishChanges(works, initialWorks, stagedWorks);
      return result;
    },
  } as unknown as PrismaService;

  const loadTask = async (taskId: string): Promise<TaskResponse> => {
    const task = tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} was not committed`);
    return task;
  };

  return { prisma, rows, tasks, works, loadTask };
}

function touchedKeys<K, V>(before: Map<K, V>, after: Map<K, V>): Set<K> {
  const touched = new Set<K>();
  for (const [key, value] of before) {
    if (after.get(key) !== value) touched.add(key);
  }
  for (const [key, value] of after) {
    if (before.get(key) !== value) touched.add(key);
  }
  return touched;
}

function publishChanges<K, V>(
  target: Map<K, V>,
  before: Map<K, V>,
  after: Map<K, V>,
): void {
  for (const key of touchedKeys(before, after)) {
    const value = after.get(key);
    if (value === undefined) target.delete(key);
    else target.set(key, value);
  }
}

function uniqueConstraintError(): Error & { code: 'P2002' } {
  const error = new Error('Unique constraint failed') as Error & {
    code: 'P2002';
  };
  error.code = 'P2002';
  return error;
}

function concurrentCommitError(kind: 'p2002' | 'ordinary'): Error {
  return kind === 'p2002'
    ? uniqueConstraintError()
    : new Error('transaction serialization conflict');
}

async function writeTaskAndAdmissionWork(
  tx: Pick<PrismaService, 'task' | 'taskAdmissionWork'>,
  task: TaskResponse,
): Promise<TaskResponse> {
  await (tx.task as unknown as FakeTaskDelegate).create({ data: task });
  await (
    tx.taskAdmissionWork as unknown as FakeAdmissionWorkDelegate
  ).create({
    data: { taskId: task.id, state: 'accepted' },
  });
  return task;
}

let taskSeq = 0;
function makeTask(): TaskResponse {
  taskSeq += 1;
  return {
    id: `00000000-0000-4000-a000-00000000000${taskSeq}`,
    repoId: '00000000-0000-4000-a000-0000000000aa',
    prompt: 'hello',
    status: 'pending',
    createdAt: new Date(),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: 'codex',
  } as TaskResponse;
}

async function runCreate(
  svc: IdempotencyService,
  args: {
    key: string | null;
    scopeUserId: string;
    body: unknown;
    admit: (tx: TaskCreator) => Promise<TaskResponse>;
    loadTask: (taskId: string) => Promise<TaskResponse>;
  },
) {
  const lookup = await svc.lookup(args);
  if (lookup.kind === 'replay') {
    return { task: lookup.task, created: false };
  }
  return svc.commit({
    key: args.key,
    scopeUserId: args.scopeUserId,
    requestHash: lookup.requestHash,
    create: args.admit,
    loadTask: args.loadTask,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('no Idempotency-Key admits unconditionally and writes no dedup row', async () => {
  const { prisma, rows } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  let admits = 0;
  const task = makeTask();

  const result = await runCreate(svc, {
    key: null,
    scopeUserId: SCOPE,
    body: { prompt: 'a' },
    admit: async () => {
      admits += 1;
      return task;
    },
    loadTask: async () => {
      throw new Error('loadTask must not be called for a keyless create');
    },
  });

  assert.equal(result.task.id, task.id);
  assert.equal(result.created, true, 'keyless create is newly created');
  assert.equal(admits, 1, 'admitted exactly once');
  assert.equal(rows.size, 0, 'no dedup row written without a key');
});

test('first key use atomically commits one task, one admission work item, and one key', async () => {
  const { prisma, rows, tasks, works } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  let admits = 0;
  const task = makeTask();

  const result = await runCreate(svc, {
    key: 'k1',
    scopeUserId: SCOPE,
    body: { prompt: 'a' },
    admit: async (tx) => {
      admits += 1;
      return writeTaskAndAdmissionWork(tx, task);
    },
    loadTask: async () => {
      throw new Error('loadTask must not run on a first use');
    },
  });

  assert.equal(result.task.id, task.id);
  assert.equal(result.created, true, 'first key use is newly created');
  assert.equal(admits, 1);
  assert.equal(rows.size, 1, 'one dedup row recorded');
  assert.equal(tasks.size, 1, 'one Task row committed');
  assert.equal(works.size, 1, 'one admission-work row committed');
  assert.equal(rows.values().next().value?.taskId, task.id);
  assert.ok(tasks.has(task.id));
  assert.ok(works.has(task.id));
});

test('a key insert failure rolls back its staged task and admission work', async () => {
  const keyFailure = new Error('idempotency key insert failed');
  const { prisma, rows, tasks, works } = makeFakePrisma({
    keyCreateError: keyFailure,
  });
  const svc = new IdempotencyService(prisma);
  const task = makeTask();
  let stagedAdmissions = 0;

  await assert.rejects(
    () =>
      runCreate(svc, {
        key: 'key-insert-failure',
        scopeUserId: SCOPE,
        body: { prompt: 'a' },
        admit: async (tx) => {
          const created = await writeTaskAndAdmissionWork(tx, task);
          stagedAdmissions += 1;
          return created;
        },
        loadTask: async () => {
          throw new Error('loadTask must not run when the key insert fails');
        },
      }),
    (error: unknown) => error === keyFailure,
  );

  assert.equal(stagedAdmissions, 1, 'task and work were staged before key insert');
  assert.equal(rows.size, 0, 'failed transaction commits no key');
  assert.equal(tasks.size, 0, 'failed transaction commits no Task');
  assert.equal(works.size, 0, 'failed transaction commits no admission work');
});

test('same key + same body returns the SAME task and admits nothing new', async () => {
  const { prisma } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  const first = makeTask();
  let admits = 0;

  const body = { prompt: 'a', repoId: 'r' };
  const r1 = await runCreate(svc, {
    key: 'k2',
    scopeUserId: SCOPE,
    body,
    admit: async () => {
      admits += 1;
      return first;
    },
    loadTask: async (id) => ({ ...first, id }),
  });

  const r2 = await runCreate(svc, {
    key: 'k2',
    scopeUserId: SCOPE,
    body: { repoId: 'r', prompt: 'a' }, // same body, different key order
    admit: async () => {
      admits += 1;
      return makeTask(); // MUST NOT be reached
    },
    loadTask: async (id) => ({ ...first, id }),
  });

  assert.equal(r1.task.id, first.id);
  assert.equal(r1.created, true, 'first call newly creates');
  assert.equal(r2.task.id, first.id, 'retry returns the FIRST task');
  assert.equal(r2.created, false, 'retry is a dedup hit — caller must NOT re-admit');
  assert.equal(admits, 1, 'exactly one admission across both calls');
});

test('same key + different body within the window is 409', async () => {
  const { prisma } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  const first = makeTask();
  let admits = 0;

  await runCreate(svc, {
    key: 'k3',
    scopeUserId: SCOPE,
    body: { prompt: 'a' },
    admit: async () => {
      admits += 1;
      return first;
    },
    loadTask: async (id) => ({ ...first, id }),
  });

  await assert.rejects(
    () =>
      runCreate(svc, {
        key: 'k3',
        scopeUserId: SCOPE,
        body: { prompt: 'DIFFERENT' },
        admit: async () => {
          admits += 1;
          return makeTask();
        },
        loadTask: async (id) => ({ ...first, id }),
      }),
    (err: unknown) => err instanceof ConflictException,
  );

  assert.equal(admits, 1, 'no second admission on a body mismatch');
});

test('an expired record does not dedup', async () => {
  const { prisma, rows } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  // Seed an EXPIRED record for (SCOPE, k4).
  rows.set(`${SCOPE}\u0000k4`, {
    key: 'k4',
    scopeUserId: SCOPE,
    requestHash: 'stale',
    taskId: 'old-task',
    expiresAt: new Date(Date.now() - 1000),
  });
  const fresh = makeTask();
  let admits = 0;

  const result = await runCreate(svc, {
    key: 'k4',
    scopeUserId: SCOPE,
    body: { prompt: 'a' },
    admit: async () => {
      admits += 1;
      return fresh;
    },
    loadTask: async () => {
      throw new Error('expired record must not dedup');
    },
  });

  assert.equal(result.task.id, fresh.id, 'expired key admits a fresh task');
  assert.equal(result.created, true, 'expired key re-creates');
  assert.equal(admits, 1);
});

test('same-body race commits one admission and makes the loser replay the winner', async (t) => {
  for (const concurrentConflict of ['p2002', 'ordinary'] as const) {
    await t.test(`loser surfaces ${concurrentConflict}`, async () => {
      const { prisma, rows, tasks, works, loadTask } = makeFakePrisma({
        concurrentConflict,
      });
      const svc = new IdempotencyService(prisma);
      const barrier = makeBarrier(2);
      const first = makeTask();
      const second = makeTask();
      const body = { prompt: 'a', repoId: 'r' };
      let stagedAdmissions = 0;

      const race = (task: TaskResponse) =>
        runCreate(svc, {
          key: `same-body-${concurrentConflict}`,
          scopeUserId: SCOPE,
          body,
          admit: async (tx) => {
            const created = await writeTaskAndAdmissionWork(tx, task);
            stagedAdmissions += 1;
            await barrier();
            return created;
          },
          loadTask,
        });

      const [left, right] = await Promise.all([race(first), race(second)]);

      assert.equal(stagedAdmissions, 2, 'both racers staged Task + work');
      assert.deepEqual(
        [left.created, right.created].sort(),
        [false, true],
        'one request creates and the losing request is an exact replay',
      );
      assert.equal(left.task.id, right.task.id, 'loser returns the winner Task');
      assert.equal(rows.size, 1, 'one idempotency key committed');
      assert.equal(tasks.size, 1, 'loser Task was rolled back');
      assert.equal(works.size, 1, 'loser admission work was rolled back');
      assert.equal(rows.values().next().value?.taskId, left.task.id);
      assert.ok(tasks.has(left.task.id));
      assert.ok(works.has(left.task.id));
    });
  }
});

test('mismatched-body race returns one 409 and never commits a second admission', async (t) => {
  for (const concurrentConflict of ['p2002', 'ordinary'] as const) {
    await t.test(`loser surfaces ${concurrentConflict}`, async () => {
      const { prisma, rows, tasks, works, loadTask } = makeFakePrisma({
        concurrentConflict,
      });
      const svc = new IdempotencyService(prisma);
      const barrier = makeBarrier(2);
      const first = makeTask();
      const second = makeTask();
      let stagedAdmissions = 0;

      const race = (task: TaskResponse, prompt: string) =>
        runCreate(svc, {
          key: `mismatched-body-${concurrentConflict}`,
          scopeUserId: SCOPE,
          body: { prompt, repoId: 'r' },
          admit: async (tx) => {
            const created = await writeTaskAndAdmissionWork(tx, task);
            stagedAdmissions += 1;
            await barrier();
            return created;
          },
          loadTask,
        });

      const settled = await Promise.allSettled([
        race(first, 'first'),
        race(second, 'second'),
      ]);
      const success = settled.find((result) => result.status === 'fulfilled');
      const failure = settled.find((result) => result.status === 'rejected');

      assert.ok(success && success.status === 'fulfilled');
      assert.ok(failure && failure.status === 'rejected');
      assert.equal(success.value.created, true, 'the winner is the sole create');
      assert.ok(
        failure.reason instanceof ConflictException,
        'the mismatched loser receives 409',
      );
      assert.equal(stagedAdmissions, 2, 'both racers staged Task + work');
      assert.equal(rows.size, 1, 'one idempotency key committed');
      assert.equal(tasks.size, 1, 'mismatched loser Task was rolled back');
      assert.equal(works.size, 1, 'mismatched loser work was rolled back');
      assert.equal(rows.values().next().value?.taskId, success.value.task.id);
      assert.ok(tasks.has(success.value.task.id));
      assert.ok(works.has(success.value.task.id));
    });
  }
});

test('commit rechecks a key that appeared after the side-effect-free lookup', async () => {
  const { prisma, rows } = makeFakePrisma();
  const svc = new IdempotencyService(prisma);
  const body = { repoId: 'r', prompt: 'a', model: 'provider/model:a' };
  const lookup = await svc.lookup({
    key: 'race-recheck',
    scopeUserId: SCOPE,
    body,
    loadTask: async () => {
      throw new Error('initial lookup must miss');
    },
  });
  assert.equal(lookup.kind, 'missing');
  const winner = makeTask();
  rows.set(`${SCOPE}${String.fromCharCode(0)}race-recheck`, {
    key: 'race-recheck',
    scopeUserId: SCOPE,
    requestHash: lookup.requestHash,
    taskId: winner.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  let creates = 0;

  const result = await svc.commit({
    key: 'race-recheck',
    scopeUserId: SCOPE,
    requestHash: lookup.requestHash,
    create: async () => {
      creates += 1;
      return makeTask();
    },
    loadTask: async (id) => ({ ...winner, id }),
  });

  assert.equal(result.created, false);
  assert.equal(result.task.id, winner.id);
  assert.equal(creates, 0, 'transaction recheck must skip the losing Task write');
});

test('bounded winner lookup recovers a same-body commit racing a failed preflight', async () => {
  const firstMiss = deferred<void>();
  let observedFirstMiss = false;
  const { prisma, rows } = makeFakePrisma({
    onRootKeyLookup: ({ key, row }) => {
      if (key === 'preflight-race' && row === null && !observedFirstMiss) {
        observedFirstMiss = true;
        firstMiss.resolve();
      }
    },
  });
  const svc = new IdempotencyService(prisma);
  const winner = makeTask();
  const body = { repoId: 'r', prompt: 'a', model: 'provider/model:a' };
  const requestHash = IdempotencyService.hashBody(body);
  const pending = svc.waitForWinner({
    key: 'preflight-race',
    scopeUserId: SCOPE,
    requestHash,
    loadTask: async (id) => ({ ...winner, id }),
    maxWaitMs: 100,
    pollMs: 2,
  });

  await firstMiss.promise;
  rows.set(`${SCOPE}${String.fromCharCode(0)}preflight-race`, {
    key: 'preflight-race',
    scopeUserId: SCOPE,
    requestHash,
    taskId: winner.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const resolved = await pending;

  assert.equal(resolved?.id, winner.id);
});

test('hashBody is canonical across key ordering', () => {
  const a = IdempotencyService.hashBody({ prompt: 'x', repoId: 'r', skills: ['s1', 's2'] });
  const b = IdempotencyService.hashBody({ repoId: 'r', skills: ['s1', 's2'], prompt: 'x' });
  assert.equal(a, b, 'key order does not change the hash');

  const c = IdempotencyService.hashBody({ prompt: 'y', repoId: 'r' });
  assert.notEqual(a, c, 'a different body hashes differently');

  // Array order IS significant.
  const d = IdempotencyService.hashBody({ skills: ['s2', 's1'] });
  const e = IdempotencyService.hashBody({ skills: ['s1', 's2'] });
  assert.notEqual(d, e, 'array order is preserved in the hash');

  const modelA = IdempotencyService.hashBody({ prompt: 'x', model: 'model/a' });
  const modelB = IdempotencyService.hashBody({ prompt: 'x', model: 'model/b' });
  assert.notEqual(modelA, modelB, 'requested model is part of idempotency intent');
});
