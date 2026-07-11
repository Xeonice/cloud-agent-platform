/**
 * Unit tests for the startup recovery (configurable-task-slots 6.1–6.3 +
 * survive-api-redeploy guardrails-recovery 4.2): Phase 0 RE-ADOPTS still-running
 * survivors (kept in state, slot held, timers re-armed), Phase 1 reclaims the
 * orphaned in-flight tasks that were NOT re-adopted, the persisted slot ceiling
 * is loaded ceiling-first, then Phase 2 re-offers DB `queued` tasks plus
 * interrupted direct `pending` admissions FIFO against the REMAINING capacity.
 *
 * This inlines a FAITHFUL mirror of ONLY the seams under test — the
 * `onApplicationBootstrap` / `readoptSurvivorsOnStartup` /
 * `reclaimOrphanedOnStartup` / `reofferQueuedOnStartup` logic of
 * `tasks.service.ts` — plus a fake guardrails service whose `admit`/`readopt`
 * mirror the capacity-bounded FIFO semantics of `GuardrailsService` over
 * `ConcurrencySemaphore.offer`, matching the sibling no-transpile `.mjs` tests
 * (`task-lifecycle.test.mjs`, `guardrails-exit-roundtrip.test.mjs`). The REAL
 * modules are additionally exercised end-to-end by `test/api-e2e.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- fakes -------------------------------------------------------------------

/**
 * Minimal Prisma fake over an in-memory task table. Supports exactly the two
 * `findMany` shapes the recovery issues:
 *   { where: { status: { in: [...] } }, select: { id } }                 (Phase 1)
 *   { where: { OR: [{ status: 'queued' }, { status: 'pending',
 *     scheduleRun: { is: null } }] }, orderBy: { createdAt: 'asc' } }    (Phase 2)
 */
class FakePrisma {
  constructor(rows) {
    this.rows = rows;
  }

  get task() {
    const rows = this.rows;
    return {
      async findMany({ where, orderBy, select }) {
        let matched = rows.filter((row) => {
          if (where.OR) {
            return where.OR.some((part) => {
              if (row.status !== part.status) return false;
              return part.scheduleRun?.is === null ? row.scheduleRun == null : true;
            });
          }
          return typeof where.status === 'string'
            ? row.status === where.status
            : where.status.in.includes(row.status);
        });
        if (orderBy?.createdAt === 'asc') {
          matched = [...matched].sort((a, b) => a.createdAt - b.createdAt);
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
  } = {}) {
    this.readoptable = readoptable;
    this.goneOnReattach = new Set(goneOnReattach);
    this.reattached = [];
    this.selectedRunLookups = [];
    this.selectedRuns = selectedRuns;
    this.throwOnSelectedRun = new Set(throwOnSelectedRun);
    this.capabilities = capabilities;
  }
  getSandboxMode() {
    return 'test';
  }
  getProviderCapabilities() {
    return this.capabilities ?? undefined;
  }
  async listReadoptable() {
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
    return this.selectedRuns[taskId] ?? null;
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
  constructor({ envCeiling, persistedCeiling = null }) {
    this.ceiling = envCeiling;
    this.persistedCeiling = persistedCeiling;
    this.running = [];
    this.queue = [];
    this.armed = new Map(); // taskId -> params handed to admit (watcher arming)
    this.selectedRuns = new Map(); // taskId -> selected-run metadata handed to readopt
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

  /**
   * Mirrors `GuardrailsService.readopt` (4.1): re-account the slot in the
   * running set and re-arm the watchers from the persisted params, WITHOUT a
   * lifecycle transition. A re-adopted slot reduces the capacity later `admit`s
   * see (running.length is checked against the ceiling), which is exactly the
   * slot-accounting Phase 2's re-offer relies on.
   */
  readopt(taskId, _connection, params = {}, selectedRun = null) {
    this.events.push(`readopt:${taskId}`);
    if (!this.running.includes(taskId)) {
      this.running.push(taskId);
    }
    this.armed.set(taskId, params);
    this.selectedRuns.set(taskId, selectedRun);
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
  constructor(prisma, guardrails, sandbox, sandboxOwners) {
    this.prisma = prisma;
    this.guardrails = guardrails;
    this.sandbox = sandbox;
    this.sandboxOwners = sandboxOwners;
    this.failed = []; // taskIds reclaimed -> failed (Phase 1)
  }

  // mirrors TasksService.onApplicationBootstrap (three-phase, ceiling-first)
  async onApplicationBootstrap() {
    const readopted = await this.readoptSurvivorsOnStartup();
    await this.reclaimOrphanedOnStartup(readopted);
    if (this.guardrails?.loadPersistedCeiling) {
      try {
        await this.guardrails.loadPersistedCeiling();
      } catch {
        // best-effort: env seed stays effective
      }
    }
    await this.reofferQueuedOnStartup();
  }

  // mirrors TasksService.readoptSurvivorsOnStartup (Phase 0)
  async readoptSurvivorsOnStartup() {
    const readopted = new Set();
    const sandbox = this.sandbox;
    if (!sandbox?.reattach || !this.guardrails?.readopt) {
      return readopted;
    }
    let selected;
    try {
      selected = selectSandboxProvider(sandbox, ['lifecycle.readopt']).provider;
    } catch {
      return readopted;
    }
    const candidates = new Set();
    try {
      const ownerRows = await this.sandboxOwners?.listActiveSandboxRunOwners?.() ?? [];
      for (const owner of ownerRows) candidates.add(owner.taskId);
    } catch {
      // best-effort: fall back to provider listing
    }
    try {
      const providerCandidates = await selected.listReadoptable?.() ?? [];
      for (const taskId of providerCandidates) candidates.add(taskId);
    } catch {
      if (candidates.size === 0) return readopted;
    }
    for (const taskId of candidates) {
      try {
        const row = await this.prisma.task.findUnique({
          where: { id: taskId },
          select: { status: true, deadlineMs: true, idleTimeoutMs: true },
        });
        if (!row || (row.status !== 'running' && row.status !== 'awaiting_input')) {
          continue;
        }
        const connection = await selected.reattach?.(taskId);
        if (!connection) continue; // raced to gone -> let Phase 1 fail it
        let selectedRun = null;
        try {
          selectedRun = (await selected.getSelectedSandboxRun?.(taskId)) ?? null;
        } catch {
          selectedRun = null;
        }
        this.guardrails.readopt(
          taskId,
          connection,
          {
            deadlineMs: row?.deadlineMs ?? undefined,
            idleTimeoutMs: row?.idleTimeoutMs ?? undefined,
          },
          selectedRun,
        );
        readopted.add(taskId); // KEEP current state — no transition
      } catch {
        // best-effort per task: a re-adopt failure falls through to Phase 1
      }
    }
    return readopted;
  }

  // mirrors TasksService.reclaimOrphanedOnStartup (transition spied as `failed`)
  // — Phase 0 re-adopted survivors are SKIPPED, only the truly-dead are failed.
  async reclaimOrphanedOnStartup(readopted = new Set()) {
    const orphaned = await this.prisma.task.findMany({
      where: { status: { in: ['running', 'awaiting_input'] } },
      select: { id: true },
    });
    for (const { id } of orphaned) {
      if (readopted.has(id)) continue; // kept in its current state
      this.failed.push(id);
      this.guardrails?.events.push(`fail:${id}`);
    }
    return orphaned.length - [...readopted].filter((id) => orphaned.some((o) => o.id === id)).length;
  }

  // mirrors TasksService.reofferQueuedOnStartup
  async reofferQueuedOnStartup() {
    if (!this.guardrails) {
      return 0;
    }
    const queued = await this.prisma.task.findMany({
      where: {
        OR: [
          { status: 'queued' },
          { status: 'pending', scheduleRun: { is: null } },
        ],
      },
      orderBy: { createdAt: 'asc' },
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
  ...extra,
});

const pendingRow = (id, createdAt, extra = {}) => ({
  ...queuedRow(id, createdAt, extra),
  status: 'pending',
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
  createdAt,
  deadlineMs: null,
  idleTimeoutMs: null,
  ...extra,
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

test('a declared provider missing lifecycle.readopt is not used for startup re-adoption', async () => {
  const prisma = new FakePrisma([runningRow('alive', 1)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({
    readoptable: ['alive'],
    capabilities: ['terminal.websocket'],
  });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(sandbox.reattached, [], 'reattach is not attempted without lifecycle.readopt');
  assert.deepEqual(guardrails.running, [], 'no running slot is held for a provider that cannot re-adopt');
  assert.deepEqual(harness.failed, ['alive'], 'the in-flight task falls through to Phase 1 reclaim');
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

test('startup re-adoption falls back to connection-only when selected-run metadata fails', async () => {
  const prisma = new FakePrisma([runningRow('alive', 1)]);
  const guardrails = new FakeGuardrails({ envCeiling: 5 });
  const sandbox = new FakeSandbox({
    readoptable: ['alive'],
    capabilities: ['lifecycle.readopt'],
    throwOnSelectedRun: ['alive'],
  });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(sandbox.selectedRunLookups, ['alive'], 'selected-run metadata is attempted after reattach');
  assert.deepEqual(guardrails.running, ['alive'], 'the task is still re-adopted when metadata lookup fails');
  assert.equal(guardrails.selectedRuns.get('alive'), null, 'guardrails receives a null selected-run fallback');
  assert.deepEqual(harness.failed, [], 'metadata failure does not force-fail the live survivor');
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

test('queued re-offer capacity accounts for re-adopted slots (ceiling minus re-adopted)', async () => {
  const prisma = new FakePrisma([
    runningRow('survivor', 1),
    queuedRow('q1', 2),
    queuedRow('q2', 3),
  ]);
  // Persisted ceiling 2; one re-adopted survivor leaves capacity for exactly one
  // queued task — proving Phase 2 admits against the REMAINING capacity.
  const guardrails = new FakeGuardrails({ envCeiling: 5, persistedCeiling: 2 });
  const sandbox = new FakeSandbox({ readoptable: ['survivor'] });
  const harness = new RecoveryHarness(prisma, guardrails, sandbox);

  await harness.onApplicationBootstrap();

  assert.deepEqual(guardrails.running, ['survivor', 'q1'], 'ceiling 2 = 1 re-adopted + 1 admitted from the queue');
  assert.deepEqual(guardrails.queue, ['q2'], 'the remaining queued task stays queued behind the re-adopted slot');
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
