/**
 * Unit tests for startup recovery (configurable-task-slots 6.1–6.3 +
 * survive-api-redeploy guardrails-recovery 4.2 +
 * fix-large-repo-task-provisioning 5.4): unfinished durable admission work is
 * protected first, legacy survivors are re-adopted only from complete provider
 * + terminal evidence, legacy orphans are reclaimed only after a definitive
 * absence, the persisted slot ceiling is restored, provider inventory is
 * reconciled, and only then is legacy queued work re-offered by the stable
 * `(createdAt, id)` FIFO before durable-worker polling begins.
 *
 * This inlines a FAITHFUL mirror of ONLY the seams under test — the
 * `onApplicationBootstrap` / `readoptSurvivorsOnStartup` /
 * `reclaimOrphanedOnStartup` / `reofferQueuedOnStartup` logic of
 * `tasks.service.ts` — plus a fake guardrails service whose `admit`/`readopt`
 * mirror `ConcurrencySemaphore.offer` / `restoreRunning`. The production
 * classes are covered separately by `tasks-startup-durable-recovery.spec.ts`;
 * this file remains the fast no-transpile historical model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- fakes -------------------------------------------------------------------

/**
 * Minimal Prisma fake over an in-memory task table. It deliberately supports
 * only the startup-recovery predicates used below, including relation filters
 * that keep unfinished durable admission work out of legacy recovery.
 */
class FakePrisma {
  constructor(rows) {
    this.rows = rows;
  }

  get task() {
    const rows = this.rows;
    return {
      async findMany({ where, orderBy, select }) {
        let matched = rows.filter((row) => matchesTaskWhere(row, where));
        const ordering = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        if (ordering.length > 0) {
          matched = [...matched].sort((a, b) => {
            for (const clause of ordering) {
              const [field, direction] = Object.entries(clause)[0];
              const compared = a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0;
              if (compared !== 0) return direction === 'desc' ? -compared : compared;
            }
            return 0;
          });
        }
        return matched.map((row) =>
          Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])),
        );
      },
      // Phase 0 reads each survivor's persisted guardrail params to re-arm timers.
      async findUnique({ where, select }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return null;
        return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
      },
    };
  }

  get taskAdmissionWork() {
    const rows = this.rows;
    return {
      async findMany({ where, select }) {
        return rows
          .filter((row) => where.state.in.includes(row.admissionWork?.state))
          .map((row) => {
            const work = { taskId: row.admissionWork?.taskId ?? row.id };
            return Object.fromEntries(
              Object.keys(select).map((key) => [key, work[key]]),
            );
          });
      },
    };
  }
}

function matchesTaskWhere(row, where) {
  if (where.status) {
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.status.in && !where.status.in.includes(row.status)) return false;
  }
  if (where.scheduleRun?.is === null && row.scheduleRun != null) return false;
  if (where.admissionWork?.is === null && row.admissionWork != null) return false;
  const workStateFilter = where.admissionWork?.is?.state;
  if (workStateFilter?.notIn) {
    if (row.admissionWork == null) return false;
    if (workStateFilter.notIn.includes(row.admissionWork.state)) return false;
  }
  if (where.OR && !where.OR.some((part) => matchesTaskWhere(row, part))) return false;
  return true;
}

const UNFINISHED_ADMISSION_STATES = ['accepted', 'queued', 'running', 'retrying'];
const TERMINAL_TASK_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'agent_failed_to_start',
];

function isUnfinishedAdmissionState(state) {
  return UNFINISHED_ADMISSION_STATES.includes(state);
}

function isLegacyReadoptionWorkState(state) {
  return state == null || state === 'succeeded';
}

function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(status);
}

function sandboxRun(taskId) {
  return {
    taskId,
    providerId: 'startup-test',
    connection: {
      taskId,
      baseUrl: `http://cap-aio-${taskId}:8080`,
      wsUrl: `ws://cap-aio-${taskId}:8080/v1/shell/ws`,
    },
    terminal: {
      protocol: 'aio-json-v1',
      wsUrl: `ws://cap-aio-${taskId}:8080/v1/shell/ws`,
    },
  };
}

/**
 * Fake sandbox re-adoption surface (Track 3.3). `listReadoptable` returns the
 * taskIds whose container + detached session survived; `reattach` hands back
 * the still-valid connection handle (or `undefined` to simulate a survivor that
 * raced to gone between the list and the reattach). Mirrors `ISandboxReadoption`.
 */
class FakeSandbox {
  constructor({
    readoptable = [],
    goneOnReattach = [],
    capabilities = null,
    selectedRuns = {},
    throwOnSelectedRun = [],
    throwOnList = false,
    eventSink = null,
  } = {}) {
    this.readoptable = readoptable;
    this.goneOnReattach = new Set(goneOnReattach);
    this.reattached = [];
    this.selectedRunLookups = [];
    this.selectedRuns = selectedRuns;
    this.throwOnSelectedRun = new Set(throwOnSelectedRun);
    this.throwOnList = throwOnList;
    this.capabilities = capabilities;
    this.eventSink = eventSink;
    this.reconciliations = [];
  }
  getSandboxMode() {
    return 'test';
  }
  getProviderCapabilities() {
    return this.capabilities ?? undefined;
  }
  async listReadoptable() {
    if (this.throwOnList) throw new Error('provider inventory unavailable');
    return [...this.readoptable];
  }
  async reattach(taskId) {
    this.reattached.push(taskId);
    if (this.goneOnReattach.has(taskId)) return undefined;
    return {
      taskId,
      baseUrl: `http://cap-aio-${taskId}:8080`,
      wsUrl: `ws://cap-aio-${taskId}:8080/v1/shell/ws`,
    };
  }
  async getSelectedSandboxRun(taskId) {
    this.selectedRunLookups.push(taskId);
    if (this.throwOnSelectedRun.has(taskId)) throw new Error(`metadata down for ${taskId}`);
    if (Object.hasOwn(this.selectedRuns, taskId)) return this.selectedRuns[taskId];
    return sandboxRun(taskId);
  }
  async reconcileSandboxInventory({ protectedTaskIds, canReap }) {
    this.eventSink?.push('provider-reconcile');
    this.reconciliations.push({
      protectedTaskIds: [...protectedTaskIds],
      canReap,
    });
    return { inspected: this.readoptable.length, reaped: 0 };
  }
}

function selectSandboxProvider(provider, required) {
  if (!provider) throw new Error('No sandbox provider is configured');
  const declaredCapabilities = provider.getProviderCapabilities?.();
  if (!declaredCapabilities) return { provider, capabilities: [], compatibility: 'legacy-assumed' };
  const missing = required.filter((capability) => !hasCapability(declaredCapabilities, capability));
  if (missing.length > 0) {
    throw new Error(
      `Sandbox provider "${provider.getSandboxMode()}" missing required capabilities: ${missing.join(', ')}`,
    );
  }
  return { provider, capabilities: declaredCapabilities, compatibility: 'declared' };
}

function hasCapability(declaredCapabilities, required) {
  return declaredCapabilities.includes(required) ||
    (required === 'lifecycle.readopt' && declaredCapabilities.includes('lifecycle.readoption')) ||
    (required === 'lifecycle.readoption' && declaredCapabilities.includes('lifecycle.readopt'));
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
  constructor({ envCeiling, persistedCeiling = null, eventSink = null }) {
    this.ceiling = envCeiling;
    this.persistedCeiling = persistedCeiling;
    this.running = [];
    this.queue = [];
    this.armed = new Map(); // taskId -> params handed to admit (watcher arming)
    this.selectedRuns = new Map(); // taskId -> selected-run metadata handed to readopt
    this.events = []; // ordered log proving phase/ceiling ordering
    this.eventSink = eventSink;
  }

  async loadPersistedCeiling() {
    this.events.push('loadPersistedCeiling');
    this.eventSink?.push('loadPersistedCeiling');
    if (this.persistedCeiling !== null) {
      this.ceiling = this.persistedCeiling;
    }
  }

  async admit(taskId, params = {}) {
    this.events.push(`admit:${taskId}`);
    this.eventSink?.push(`admit:${taskId}`);
    if (this.running.length < this.ceiling) {
      this.running.push(taskId);
      this.armed.set(taskId, params);
      return 'running';
    }
    this.queue.push(taskId);
    return 'queued';
  }

  /**
   * Mirrors `GuardrailsService.readopt` (4.1): re-account the slot in the
   * running set and re-arm the watchers from the persisted params, WITHOUT a
   * lifecycle transition. A re-adopted slot reduces the capacity later `admit`s
   * see (running.length is checked against the ceiling), which is exactly the
   * slot-accounting Phase 2's re-offer relies on.
   */
  async readopt(taskId, _connection, params = {}, selectedRun = null, options = {}) {
    this.events.push(`readopt:${taskId}`);
    this.eventSink?.push(`readopt:${taskId}`);
    if (!(await options.beforeCommit?.() ?? true)) return 'superseded';
    if (!this.running.includes(taskId)) {
      // Mirrors `restoreRunning`: survivors remain accounted even when their
      // count is already above a newly persisted/lowered ceiling.
      this.running.push(taskId);
    }
    this.armed.set(taskId, params);
    this.selectedRuns.set(taskId, selectedRun);
    return 'attached';
  }

  /**
   * Mirrors `GuardrailsService.onTerminal` exactly-once slot release: a
   * re-adopted task that later dies frees its slot. Idempotent — a double call
   * (e.g. a liveness poller racing a teardown) releases the slot only once.
   */
  async onTerminal(taskId) {
    this.events.push(`onTerminal:${taskId}`);
    const idx = this.running.indexOf(taskId);
    if (idx !== -1) {
      this.running.splice(idx, 1);
      this.terminated = (this.terminated ?? 0) + 1;
    }
  }
}

// --- inline mirror of tasks.service.ts startup recovery ----------------------

class RecoveryHarness {
  constructor(prisma, guardrails, sandbox, sandboxOwners, worker) {
    this.prisma = prisma;
    this.guardrails = guardrails;
    this.sandbox = sandbox;
    this.sandboxOwners = sandboxOwners;
    this.worker = worker;
    this.failed = []; // taskIds reclaimed -> failed (Phase 1)
  }

  // Mirrors TasksService.onApplicationBootstrap, including durable ownership
  // fences and the reconcile-before-worker-start boundary.
  async onApplicationBootstrap() {
    const durableProtected = await this.listUnfinishedDurableAdmissionTaskIds();
    const readopted = await this.readoptSurvivorsOnStartup(durableProtected);
    await this.reclaimOrphanedOnStartup(readopted, durableProtected);
    if (this.guardrails?.loadPersistedCeiling) {
      try {
        await this.guardrails.loadPersistedCeiling();
      } catch {
        // best-effort: env seed stays effective
      }
    }
    // Reconcile before legacy re-offer: a re-offer may provision a fresh
    // sandbox, which must never be classified as pre-bootstrap orphan inventory.
    for (const taskId of await this.listUnfinishedDurableAdmissionTaskIds()) {
      durableProtected.add(taskId);
    }
    await this.sandbox?.reconcileSandboxInventory?.({
      protectedTaskIds: [...durableProtected, ...readopted],
      canReap: async ({ taskId }) => {
        const task = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { id: true },
        });
        return task === null;
      },
    });
    await this.reofferQueuedOnStartup();
    this.worker?.start?.();
  }

  async listUnfinishedDurableAdmissionTaskIds() {
    const rows = await this.prisma.taskAdmissionWork.findMany({
      where: { state: { in: [...UNFINISHED_ADMISSION_STATES] } },
      select: { taskId: true },
    });
    return new Set(rows.map(({ taskId }) => taskId));
  }

  // mirrors TasksService.readoptSurvivorsOnStartup (Phase 0)
  async readoptSurvivorsOnStartup(durableProtected = new Set()) {
    const readopted = new Set();
    const sandbox = this.sandbox;
    if (!sandbox?.reattach || !this.guardrails?.readopt) {
      return readopted;
    }
    let selected;
    try {
      selected = selectSandboxProvider(sandbox, ['lifecycle.readopt']).provider;
    } catch {
      throw new Error('startup re-adopt provider selection is indeterminate');
    }
    if (
      typeof selected.reattach !== 'function' ||
      typeof selected.getSelectedSandboxRun !== 'function'
    ) {
      throw new Error('startup re-adopt provider surface is incomplete');
    }
    const candidates = new Set();
    try {
      const ownerRows = await this.sandboxOwners?.listActiveSandboxRunOwners?.() ?? [];
      for (const owner of ownerRows) candidates.add(owner.taskId);
    } catch {
      throw new Error('startup persisted sandbox owner inventory is indeterminate');
    }
    try {
      const providerCandidates = await selected.listReadoptable?.() ?? [];
      for (const taskId of providerCandidates) candidates.add(taskId);
    } catch {
      throw new Error('startup provider sandbox inventory is indeterminate');
    }
    for (const taskId of candidates) {
      if (durableProtected.has(taskId)) continue;
      const row = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: {
          status: true,
          lifecycleVersion: true,
          deadlineMs: true,
          idleTimeoutMs: true,
          admissionWork: { select: { state: true } },
        },
      });
      if (!row || (row.status !== 'running' && row.status !== 'awaiting_input')) {
        continue;
      }
      const admissionState = row.admissionWork?.state;
      if (isUnfinishedAdmissionState(admissionState)) {
        durableProtected.add(taskId);
        continue;
      }
      if (!isLegacyReadoptionWorkState(admissionState)) continue;

      let connection;
      try {
        connection = await selected.reattach(taskId);
      } catch {
        throw new Error(`startup sandbox reattach for task ${taskId} is indeterminate`);
      }
      if (!connection) continue; // definitive absence -> Phase 1 may reclaim

      let selectedRun;
      try {
        selectedRun = (await selected.getSelectedSandboxRun(taskId)) ?? null;
      } catch {
        throw new Error(`startup selected-run lookup for task ${taskId} is indeterminate`);
      }
      if (
        !selectedRun ||
        selectedRun.taskId !== taskId ||
        connection.taskId !== taskId ||
        (!selectedRun.terminal && !connection.terminal)
      ) {
        throw new Error(`startup selected-run metadata for task ${taskId} is incomplete`);
      }

      let result;
      try {
        result = await this.guardrails.readopt(
          taskId,
          connection,
          {
            deadlineMs: row?.deadlineMs ?? undefined,
            idleTimeoutMs: row?.idleTimeoutMs ?? undefined,
          },
          selectedRun,
          {
            beforeCommit: async () => {
              const current = await this.prisma.task.findUnique({
                where: { id: taskId },
                select: {
                  status: true,
                  lifecycleVersion: true,
                  admissionWork: { select: { state: true } },
                },
              });
              return (
                current?.status === row.status &&
                current.lifecycleVersion === row.lifecycleVersion &&
                isLegacyReadoptionWorkState(current.admissionWork?.state)
              );
            },
          },
        );
      } catch {
        throw new Error(`startup terminal attach for task ${taskId} is indeterminate`);
      }
      if (result === 'attached') {
        readopted.add(taskId); // KEEP current state — no transition
        continue;
      }
      if (result === 'superseded') {
        const current = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: {
            status: true,
            lifecycleVersion: true,
            admissionWork: { select: { state: true } },
          },
        });
        if (!current) continue;
        if (isTerminalTaskStatus(current.status)) {
          durableProtected.add(taskId);
          continue;
        }
        if (isUnfinishedAdmissionState(current.admissionWork?.state)) {
          durableProtected.add(taskId);
          continue;
        }
        throw new Error(`startup readoption fence for task ${taskId} changed indeterminately`);
      }
    }
    return readopted;
  }

  // mirrors TasksService.reclaimOrphanedOnStartup (transition spied as `failed`)
  // — Phase 0 re-adopted survivors are SKIPPED, only the truly-dead are failed.
  async reclaimOrphanedOnStartup(readopted = new Set(), durableProtected = new Set()) {
    const orphaned = await this.prisma.task.findMany({
      where: {
        status: { in: ['running', 'awaiting_input'] },
        OR: [
          { admissionWork: { is: null } },
          {
            admissionWork: {
              is: { state: { notIn: [...UNFINISHED_ADMISSION_STATES] } },
            },
          },
        ],
      },
      select: { id: true },
    });
    let reclaimed = 0;
    for (const { id } of orphaned) {
      if (readopted.has(id) || durableProtected.has(id)) continue;
      this.failed.push(id);
      this.guardrails?.events.push(`fail:${id}`);
      reclaimed += 1;
    }
    return reclaimed;
  }

  // mirrors TasksService.reofferQueuedOnStartup
  async reofferQueuedOnStartup() {
    if (!this.guardrails) {
      return 0;
    }
    const queued = await this.prisma.task.findMany({
      where: {
        admissionWork: { is: null },
        OR: [
          { status: 'queued' },
          { status: 'pending', scheduleRun: { is: null } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        ownerUserId: true,
        deadlineMs: true,
        idleTimeoutMs: true,
        auditEvents: true,
      },
    });
    let reoffered = 0;
    for (const task of queued) {
      try {
        await this.guardrails.admit(task.id, {
          deadlineMs: task.deadlineMs ?? undefined,
          idleTimeoutMs: task.idleTimeoutMs ?? undefined,
          userId: task.ownerUserId ?? task.auditEvents?.[0]?.userId ?? undefined,
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
  ownerUserId: null,
  auditEvents: [],
  scheduleRun: null,
  admissionWork: null,
  ...extra,
});

const pendingRow = (id, createdAt, extra = {}) => ({
  ...queuedRow(id, createdAt, extra),
  status: 'pending',
});

// --- tests -------------------------------------------------------------------

test('restart with K queued, ceiling M: stable createdAt/id FIFO admits oldest and strands none', async () => {
  // Equal timestamps and shuffled rows prove `id asc` is the deterministic
  // tie-break rather than incidental database return order.
  const prisma = new FakePrisma([
    queuedRow('t4', 2),
    queuedRow('t2', 1),
    queuedRow('t3', 2),
    queuedRow('t1', 1),
    queuedRow('t5', 3),
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
    'all K queued tasks are re-offered by (createdAt, id)',
  );
});

test('restart re-offers direct pending admissions with the durable owner but leaves scheduled pending to schedule recovery', async () => {
  const prisma = new FakePrisma([
    pendingRow('direct', 1, { ownerUserId: 'owner-a' }),
    pendingRow('scheduled', 2, {
      ownerUserId: 'owner-a',
      scheduleRun: { id: 'run-1' },
    }),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 2 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  assert.deepEqual(guardrails.running, ['direct']);
  assert.equal(guardrails.armed.get('direct')?.userId, 'owner-a');
  assert.equal(
    guardrails.events.includes('admit:scheduled'),
    false,
    'scheduled pending tasks remain behind the occurrence-level recovery lease',
  );
});

test('restart leaves queued and pending tasks with durable admission work exclusively to the worker', async () => {
  const prisma = new FakePrisma([
    pendingRow('durable-pending', 1, {
      admissionWork: { taskId: 'durable-pending', state: 'accepted' },
    }),
    queuedRow('durable-queued', 2, {
      admissionWork: { taskId: 'durable-queued', state: 'queued' },
    }),
    pendingRow('legacy-pending', 3),
    queuedRow('legacy-queued', 4),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 4 });
  const harness = new RecoveryHarness(prisma, guardrails);

  await harness.onApplicationBootstrap();

  assert.deepEqual(guardrails.running, ['legacy-pending', 'legacy-queued']);
  assert.equal(guardrails.events.includes('admit:durable-pending'), false);
  assert.equal(guardrails.events.includes('admit:durable-queued'), false);
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
    { deadlineMs: 60000, idleTimeoutMs: 30000, userId: undefined },
    'persisted guardrail params are handed to admit()',
  );
  // Persisted null coalesces back to undefined: no deadline, idle left to the
  // operator-level default — never a fabricated 0/null watcher value.
  assert.deepEqual(
    guardrails.armed.get('without-params'),
    { deadlineMs: undefined, idleTimeoutMs: undefined, userId: undefined },
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

// --- Phase 0 re-adoption (survive-api-redeploy guardrails-recovery 4.2/4.4) ---

const runningRow = (id, createdAt, extra = {}) => ({
  id,
  status: 'running',
  lifecycleVersion: 1,
  createdAt,
  deadlineMs: null,
  idleTimeoutMs: null,
  admissionWork: null,
  ...extra,
});

test('unfinished durable work is protected; async readopt and reconcile finish before legacy re-offer and worker start', async () => {
  const events = [];
  const prisma = new FakePrisma([
    runningRow('durable-running', 1, {
      admissionWork: { taskId: 'durable-running', state: 'retrying' },
    }),
    runningRow('legacy-running', 2),
    queuedRow('legacy-queued', 3),
  ]);
  const guardrails = new FakeGuardrails({
    envCeiling: 5,
    persistedCeiling: 2,
    eventSink: events,
  });
  const sandbox = new FakeSandbox({
    readoptable: ['durable-running', 'legacy-running'],
    eventSink: events,
  });

  let releaseReadopt;
  const readoptGate = new Promise((resolve) => {
    releaseReadopt = resolve;
  });
  let signalReadoptStarted;
  const readoptStarted = new Promise((resolve) => {
    signalReadoptStarted = resolve;
  });
  const baseReadopt = guardrails.readopt.bind(guardrails);
  guardrails.readopt = async (...args) => {
    events.push('terminal-attach-start');
    signalReadoptStarted();
    await readoptGate;
    const result = await baseReadopt(...args);
    events.push('terminal-attach-done');
    return result;
  };

  const worker = {
    start() {
      events.push('worker-start');
    },
  };
  const harness = new RecoveryHarness(
    prisma,
    guardrails,
    sandbox,
    undefined,
    worker,
  );

  const bootstrap = harness.onApplicationBootstrap();
  await readoptStarted;
  assert.equal(events.includes('provider-reconcile'), false, 'bootstrap awaits terminal attach');
  assert.equal(events.includes('admit:legacy-queued'), false, 'legacy re-offer has not started');
  assert.equal(events.includes('worker-start'), false, 'worker polling has not started');
  releaseReadopt();
  await bootstrap;

  assert.deepEqual(
    sandbox.reattached,
    ['legacy-running'],
    'unfinished durable work stays exclusively owned by the durable worker',
  );
  assert.deepEqual(harness.failed, [], 'durable work and the legacy survivor are not reclaimed');
  assert.deepEqual(
    new Set(sandbox.reconciliations[0].protectedTaskIds),
    new Set(['durable-running', 'legacy-running']),
    'reconciliation protects unfinished durable work plus attached legacy survivors',
  );
  assert.equal(
    await sandbox.reconciliations[0].canReap({
      taskId: 'durable-running',
      providerSandboxId: 'late-sandbox',
    }),
    false,
    'the live DB check protects a task even outside a stale snapshot',
  );
  assert.equal(
    await sandbox.reconciliations[0].canReap({
      taskId: 'deleted-task',
      providerSandboxId: 'orphan-sandbox',
    }),
    true,
    'only a deleted task is eligible for physical orphan cleanup',
  );
  const index = (event) => events.indexOf(event);
  assert.ok(index('terminal-attach-done') < index('loadPersistedCeiling'));
  assert.ok(index('loadPersistedCeiling') < index('provider-reconcile'));
  assert.ok(index('provider-reconcile') < index('admit:legacy-queued'));
  assert.ok(index('admit:legacy-queued') < index('worker-start'));
});

test('a live-session task is re-adopted: kept running (not failed), slot held, timers armed from persisted params', async () => {
  const prisma = new FakePrisma([
    runningRow('alive', 1, { deadlineMs: 60000, idleTimeoutMs: 30000 }),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({ readoptable: ['alive'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(harness.failed, [], 'the live task is NOT reclaimed to failed');
  assert.deepEqual(guardrails.running, ['alive'], 're-adopted task holds a running slot');
  assert.deepEqual(
    guardrails.armed.get('alive'),
    { deadlineMs: 60000, idleTimeoutMs: 30000 },
    'deadline + idle watchers re-armed from the persisted task row',
  );
  assert.ok(guardrails.events.includes('readopt:alive'), 'readopt was driven for the survivor');
});

test('persisted owner rows drive restart re-adoption when provider listing is empty', async () => {
  const prisma = new FakePrisma([
    runningRow('boxlite-alive', 1, { deadlineMs: 45000 }),
    queuedRow('queued-owner', 2),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({
    readoptable: [],
    capabilities: ['lifecycle.readoption'],
  });
  const sandboxOwners = {
    async listActiveSandboxRunOwners() {
      return [
        { taskId: 'boxlite-alive', providerId: 'boxlite', status: 'running' },
        { taskId: 'queued-owner', providerId: 'boxlite', status: 'running' },
      ];
    },
  };
  const harness = new RecoveryHarness(prisma, guardrails, sandbox, sandboxOwners);

  await harness.onApplicationBootstrap();

  assert.deepEqual(
    sandbox.reattached,
    ['boxlite-alive'],
    'only in-flight persisted owners are reattach candidates when provider listing is empty',
  );
  assert.deepEqual(
    guardrails.running,
    ['boxlite-alive', 'queued-owner'],
    'only the live running owner is readopted before queued re-offer consumes remaining capacity',
  );
  assert.deepEqual(harness.failed, [], 'the live BoxLite survivor is not reclaimed');
  assert.deepEqual(guardrails.armed.get('boxlite-alive'), {
    deadlineMs: 45000,
    idleTimeoutMs: undefined,
  });
});

test('provider inventory uncertainty aborts bootstrap before reclaim, reconcile, or worker polling', async () => {
  const prisma = new FakePrisma([runningRow('alive', 1)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({
    readoptable: ['alive'],
    capabilities: ['lifecycle.readopt'],
    throwOnList: true,
  });
  let workerStarts = 0;
  const harness = new RecoveryHarness(prisma, guardrails, sandbox, undefined, {
    start() {
      workerStarts += 1;
    },
  });

  await assert.rejects(
    harness.onApplicationBootstrap(),
    /startup provider sandbox inventory is indeterminate/,
  );

  assert.deepEqual(harness.failed, [], 'uncertain provider evidence never becomes a death observation');
  assert.deepEqual(sandbox.reconciliations, [], 'destructive reconciliation is not reached');
  assert.equal(workerStarts, 0, 'worker polling is not started after an unsafe bootstrap');
});

test('a dead-session task is force-failed: only non-re-adopted in-flight tasks are reclaimed', async () => {
  const prisma = new FakePrisma([
    runningRow('alive', 1),
    runningRow('dead', 2),
    { id: 'dead-awaiting', status: 'awaiting_input', createdAt: 3, deadlineMs: null, idleTimeoutMs: null },
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  // Only `alive` survived; `dead`/`dead-awaiting` did not (absent from the list).
  const sandbox = new FakeSandbox({ readoptable: ['alive'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(harness.failed, ['dead', 'dead-awaiting'], 'the dead in-flight tasks are force-failed');
  assert.deepEqual(guardrails.running, ['alive'], 'only the survivor keeps its slot');
  // Every Phase 1 fail follows the Phase 0 re-adopt.
  const lastReadopt = guardrails.events.map((e) => e.startsWith('readopt:')).lastIndexOf(true);
  const firstFail = guardrails.events.findIndex((e) => e.startsWith('fail:'));
  assert.ok(lastReadopt !== -1 && lastReadopt < firstFail, 'Phase 0 re-adopt precedes Phase 1 reclaim');
});

test('startup re-adoption forwards selected-run metadata into guardrails', async () => {
  const prisma = new FakePrisma([runningRow('alive', 1)]);
  const selectedRun = {
    taskId: 'alive',
    providerId: 'boxlite-test',
    connection: {
      taskId: 'alive',
      baseUrl: 'https://boxlite/sandboxes/alive',
      wsUrl: 'wss://boxlite/sandboxes/alive/tty',
    },
    terminal: { protocol: 'boxlite-v1', wsUrl: 'wss://boxlite/sandboxes/alive/tty' },
    command: { protocol: 'boxlite-exec-v1', baseUrl: 'https://boxlite/sandboxes/alive' },
  };
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({
    readoptable: ['alive'],
    capabilities: ['lifecycle.readopt'],
    selectedRuns: { alive: selectedRun },
  });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(sandbox.selectedRunLookups, ['alive'], 'selected-run metadata is resolved after reattach');
  assert.equal(guardrails.selectedRuns.get('alive'), selectedRun, 'selected-run metadata is passed to guardrails.readopt');
});

test('selected-run uncertainty or missing terminal evidence aborts instead of connection-only recovery', async (t) => {
  const scenarios = [
    {
      name: 'metadata lookup rejected',
      options: { throwOnSelectedRun: ['alive'] },
      error: /startup selected-run lookup for task alive is indeterminate/,
    },
    {
      name: 'selected run has no terminal evidence',
      options: {
        selectedRuns: {
          alive: { ...sandboxRun('alive'), terminal: undefined },
        },
      },
      error: /startup selected-run metadata for task alive is incomplete/,
    },
    {
      name: 'selected run is absent',
      options: { selectedRuns: { alive: null } },
      error: /startup selected-run metadata for task alive is incomplete/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const prisma = new FakePrisma([runningRow('alive', 1)]);
      const guardrails = new FakeGuardrails({ envCeiling: 5 });
      const sandbox = new FakeSandbox({
        readoptable: ['alive'],
        capabilities: ['lifecycle.readopt'],
        ...scenario.options,
      });
      let workerStarts = 0;
      const harness = new RecoveryHarness(prisma, guardrails, sandbox, undefined, {
        start() {
          workerStarts += 1;
        },
      });

      await assert.rejects(harness.onApplicationBootstrap(), scenario.error);

      assert.deepEqual(guardrails.running, [], 'no connection-only slot is restored');
      assert.deepEqual(harness.failed, [], 'uncertain metadata never flows into reclaim');
      assert.deepEqual(sandbox.reconciliations, [], 'reconciliation is not reached');
      assert.equal(workerStarts, 0, 'worker polling remains stopped');
    });
  }
});

test('a terminal winner during the final readoption fence stays protected for every non-error terminal status', async (t) => {
  for (const terminalStatus of ['completed', 'agent_failed_to_start']) {
    await t.test(terminalStatus, async () => {
      const prisma = new FakePrisma([runningRow('raced-terminal', 1)]);
      const guardrails = new FakeGuardrails({ envCeiling: 5 });
      const sandbox = new FakeSandbox({ readoptable: ['raced-terminal'] });
      guardrails.readopt = async () => {
        prisma.rows[0].status = terminalStatus;
        prisma.rows[0].lifecycleVersion += 1;
        return 'superseded';
      };
      const harness = new RecoveryHarness(prisma, guardrails, sandbox);

      await harness.onApplicationBootstrap();

      assert.deepEqual(harness.failed, []);
      assert.equal(
        sandbox.reconciliations[0].protectedTaskIds.includes('raced-terminal'),
        true,
        'the remote terminal winner remains on its ordinary terminal-retain path',
      );
    });
  }
});

test('a survivor that raced to gone between list and reattach is reclaimed, not re-adopted', async () => {
  const prisma = new FakePrisma([runningRow('raced', 1)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({ readoptable: ['raced'], goneOnReattach: ['raced'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(sandbox.reattached, ['raced'], 'reattach was attempted');
  assert.deepEqual(guardrails.running, [], 'no slot held for the gone survivor');
  assert.deepEqual(harness.failed, ['raced'], 'the gone task is force-failed by Phase 1');
});

test('restoreRunning keeps all survivors above a lowered persisted ceiling and queues new work', async () => {
  const prisma = new FakePrisma([
    runningRow('survivor-a', 1),
    runningRow('survivor-b', 2),
    queuedRow('q1', 3),
  ]);
  const guardrails = new FakeGuardrails({ envCeiling: 5, persistedCeiling: 1 });
  const sandbox = new FakeSandbox({ readoptable: ['survivor-a', 'survivor-b'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(
    guardrails.running,
    ['survivor-a', 'survivor-b'],
    'both real survivors remain restored even though the persisted ceiling is one',
  );
  assert.deepEqual(guardrails.queue, ['q1'], 'new work waits until running drops below the ceiling');
});

test('a re-adopted task that later dies terminates cleanly exactly once (slot freed once)', async () => {
  const prisma = new FakePrisma([runningRow('alive', 1)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({ readoptable: ['alive'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();
  assert.deepEqual(guardrails.running, ['alive'], 're-adopted and holding its slot');

  // Later, the detached session disappears and the liveness path drives onTerminal.
  await guardrails.onTerminal('alive');
  // A racing teardown/poller double-call must not double-release the slot.
  await guardrails.onTerminal('alive');

  assert.deepEqual(guardrails.running, [], 'the re-adopted task freed its slot on death');
  assert.equal(guardrails.terminated, 1, 'the slot is released exactly once (idempotent terminal)');
});
