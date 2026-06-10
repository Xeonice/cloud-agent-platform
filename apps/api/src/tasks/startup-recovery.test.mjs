/**
 * Unit tests for the two-phase startup recovery (configurable-task-slots
 * 6.1–6.3): Phase 1 reclaims orphaned in-flight tasks, the persisted slot
 * ceiling is loaded ceiling-first, then Phase 2 re-offers DB `queued` tasks
 * FIFO with their persisted guardrail params restored.
 *
 * This inlines a FAITHFUL mirror of ONLY the seams under test — the
 * `onApplicationBootstrap` / `reclaimOrphanedOnStartup` /
 * `reofferQueuedOnStartup` logic of `tasks.service.ts` — plus a fake
 * guardrails service whose `admit` mirrors the capacity-bounded FIFO
 * semantics of `GuardrailsService.admit` over `ConcurrencySemaphore.offer`,
 * matching the sibling no-transpile `.mjs` tests (`task-lifecycle.test.mjs`,
 * `guardrails-exit-roundtrip.test.mjs`). The REAL modules are additionally
 * exercised end-to-end by `test/api-e2e.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- fakes -------------------------------------------------------------------

/**
 * Minimal Prisma fake over an in-memory task table. Supports exactly the two
 * `findMany` shapes the recovery issues:
 *   { where: { status: { in: [...] } }, select: { id } }                 (Phase 1)
 *   { where: { status: 'queued' }, orderBy: { createdAt: 'asc' },
 *     select: { id, deadlineMs, idleTimeoutMs } }                        (Phase 2)
 */
class FakePrisma {
  constructor(rows) {
    this.rows = rows;
  }

  get task() {
    const rows = this.rows;
    return {
      async findMany({ where, orderBy, select }) {
        let matched = rows.filter((row) =>
          typeof where.status === 'string'
            ? row.status === where.status
            : where.status.in.includes(row.status),
        );
        if (orderBy?.createdAt === 'asc') {
          matched = [...matched].sort((a, b) => a.createdAt - b.createdAt);
        }
        return matched.map((row) =>
          Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])),
        );
      },
    };
  }
}

/**
 * Fake guardrails service. `admit` mirrors `GuardrailsService.admit` over the
 * semaphore: under the ceiling the task takes a running slot and its guardrail
 * params arm the (recorded) watchers; at the ceiling it joins the FIFO queue.
 * `loadPersistedCeiling` mirrors the guardrails-bootstrap seam (4.2): the env
 * value seeds the ceiling at construction; the persisted DB value, when
 * present, overrides it (`dbSetting ?? envDefault`).
 */
class FakeGuardrails {
  constructor({ envCeiling, persistedCeiling = null }) {
    this.ceiling = envCeiling;
    this.persistedCeiling = persistedCeiling;
    this.running = [];
    this.queue = [];
    this.armed = new Map(); // taskId -> params handed to admit (watcher arming)
    this.events = []; // ordered log proving phase/ceiling ordering
  }

  async loadPersistedCeiling() {
    this.events.push('loadPersistedCeiling');
    if (this.persistedCeiling !== null) {
      this.ceiling = this.persistedCeiling;
    }
  }

  async admit(taskId, params = {}) {
    this.events.push(`admit:${taskId}`);
    if (this.running.length < this.ceiling) {
      this.running.push(taskId);
      this.armed.set(taskId, params);
      return 'running';
    }
    this.queue.push(taskId);
    return 'queued';
  }
}

// --- inline mirror of tasks.service.ts startup recovery ----------------------

class RecoveryHarness {
  constructor(prisma, guardrails) {
    this.prisma = prisma;
    this.guardrails = guardrails;
    this.failed = []; // taskIds reclaimed -> failed (Phase 1)
  }

  // mirrors TasksService.onApplicationBootstrap (two-phase, ceiling-first)
  async onApplicationBootstrap() {
    await this.reclaimOrphanedOnStartup();
    if (this.guardrails?.loadPersistedCeiling) {
      try {
        await this.guardrails.loadPersistedCeiling();
      } catch {
        // best-effort: env seed stays effective
      }
    }
    await this.reofferQueuedOnStartup();
  }

  // mirrors TasksService.reclaimOrphanedOnStartup (transition spied as `failed`)
  async reclaimOrphanedOnStartup() {
    const orphaned = await this.prisma.task.findMany({
      where: { status: { in: ['running', 'awaiting_input'] } },
      select: { id: true },
    });
    for (const { id } of orphaned) {
      this.failed.push(id);
      this.guardrails?.events.push(`fail:${id}`);
    }
    return orphaned.length;
  }

  // mirrors TasksService.reofferQueuedOnStartup
  async reofferQueuedOnStartup() {
    if (!this.guardrails) {
      return 0;
    }
    const queued = await this.prisma.task.findMany({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, deadlineMs: true, idleTimeoutMs: true },
    });
    let reoffered = 0;
    for (const task of queued) {
      try {
        await this.guardrails.admit(task.id, {
          deadlineMs: task.deadlineMs ?? undefined,
          idleTimeoutMs: task.idleTimeoutMs ?? undefined,
        });
        reoffered += 1;
      } catch {
        // best-effort per task
      }
    }
    return reoffered;
  }
}

const queuedRow = (id, createdAt, extra = {}) => ({
  id,
  status: 'queued',
  createdAt,
  deadlineMs: null,
  idleTimeoutMs: null,
  ...extra,
});

// --- tests -------------------------------------------------------------------

test('restart with K queued, ceiling M: oldest min(K, M) admitted, rest queued in order — none stranded', async () => {
  // Rows deliberately out of createdAt order to prove the `createdAt asc` sort.
  const prisma = new FakePrisma([
    queuedRow('t3', 3),
    queuedRow('t1', 1),
    queuedRow('t5', 5),
    queuedRow('t2', 2),
    queuedRow('t4', 4),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 2 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  // Oldest min(5, 2) = 2 begin admission, in FIFO order.
  assert.deepEqual(guardrails.running, ['t1', 't2'], 'the 2 oldest are admitted FIFO');
  // The remaining 3 stay queued IN ORDER rather than being lost.
  assert.deepEqual(guardrails.queue, ['t3', 't4', 't5'], 'remainder queued in createdAt order');
  // No stranding: every one of the K queued tasks was re-offered.
  const offered = guardrails.events.filter((e) => e.startsWith('admit:'));
  assert.deepEqual(
    offered,
    ['admit:t1', 'admit:t2', 'admit:t3', 'admit:t4', 'admit:t5'],
    'all K queued tasks are re-offered, oldest first',
  );
});

test('ceiling-first: persisted 2 with env 5 and 3 queued admits exactly 2 (DB override before re-offer)', async () => {
  const prisma = new FakePrisma([queuedRow('a', 1), queuedRow('b', 2), queuedRow('c', 3)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5, persistedCeiling: 2 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  assert.deepEqual(guardrails.running, ['a', 'b'], 'exactly the persisted ceiling (2) admitted, not env (5)');
  assert.deepEqual(guardrails.queue, ['c'], 'the third task stays queued');
  // The override load PRECEDES every re-offer in the event order.
  const loadIndex = guardrails.events.indexOf('loadPersistedCeiling');
  const firstAdmit = guardrails.events.findIndex((e) => e.startsWith('admit:'));
  assert.ok(loadIndex !== -1, 'persisted ceiling load happens');
  assert.ok(loadIndex < firstAdmit, 'ceiling loaded BEFORE Phase 2 re-offer');
});

test('no persisted ceiling: env seed stays effective for the re-offer', async () => {
  const prisma = new FakePrisma([queuedRow('a', 1), queuedRow('b', 2), queuedRow('c', 3)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5, persistedCeiling: null });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  assert.deepEqual(guardrails.running, ['a', 'b', 'c'], 'all 3 fit under the env ceiling of 5');
  assert.deepEqual(guardrails.queue, [], 'nothing left queued');
});

test('re-offered tasks restore persisted deadlineMs/idleTimeoutMs from the task row', async () => {
  const prisma = new FakePrisma([
    queuedRow('with-params', 1, { deadlineMs: 60000, idleTimeoutMs: 30000 }),
    queuedRow('without-params', 2), // persisted as null/null (omitted at create)
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  // Watchers arm with the persisted values, identical to pre-restart admission.
  assert.deepEqual(
    guardrails.armed.get('with-params'),
    { deadlineMs: 60000, idleTimeoutMs: 30000 },
    'persisted guardrail params are handed to admit()',
  );
  // Persisted null coalesces back to undefined: no deadline, idle left to the
  // operator-level default — never a fabricated 0/null watcher value.
  assert.deepEqual(
    guardrails.armed.get('without-params'),
    { deadlineMs: undefined, idleTimeoutMs: undefined },
    'null params read back as undefined (watchers not armed with fabricated values)',
  );
});

test('Phase 1 reclaim runs BEFORE Phase 2 re-offer; queued rows are untouched by reclaim', async () => {
  const prisma = new FakePrisma([
    { id: 'orphan-running', status: 'running', createdAt: 1, deadlineMs: null, idleTimeoutMs: null },
    { id: 'orphan-awaiting', status: 'awaiting_input', createdAt: 2, deadlineMs: null, idleTimeoutMs: null },
    queuedRow('q1', 3),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  assert.deepEqual(
    harness.failed,
    ['orphan-running', 'orphan-awaiting'],
    'both orphaned in-flight tasks are reclaimed to failed',
  );
  const lastFail = guardrails.events.map((e) => e.startsWith('fail:')).lastIndexOf(true);
  const firstAdmit = guardrails.events.findIndex((e) => e.startsWith('admit:'));
  assert.ok(lastFail < firstAdmit, 'every Phase 1 reclaim precedes the first Phase 2 re-offer');
  assert.deepEqual(guardrails.running, ['q1'], 'only the queued task is re-offered/admitted');
});

test('guardrails not wired: re-offer is a no-op returning 0 (boot never blocks)', async () => {
  const prisma = new FakePrisma([queuedRow('q1', 1)]);
  const harness = new RecoveryHarness(prisma, undefined);

  await harness.onApplicationBootstrap();
  assert.equal(await harness.reofferQueuedOnStartup(), 0, 'no guardrails -> 0 re-offered');
});
