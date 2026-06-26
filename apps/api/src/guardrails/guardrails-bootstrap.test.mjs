/**
 * Minimal test for the bootstrap ceiling-load seam (configurable-task-slots):
 *
 *   "The effective ceiling SHALL resolve as
 *    `persisted system setting ?? env MAX_CONCURRENT_TASKS ?? 5`"
 *
 * Seams under test (guardrails.service.ts + guardrails.module.ts):
 *   1. seed — `readGuardrailsConfig()` reads env `MAX_CONCURRENT_TASKS` at
 *      module construction (fallback 5) and the semaphore is built with it.
 *   2. load — `loadPersistedCeiling()` reads the single `SystemSettings` row
 *      (when prisma is wired and a row exists) and pushes a VALID value into
 *      the live semaphore via `setMaxConcurrentTasks`, AFTER the env seed —
 *      so the persisted value wins across restarts. No row / no prisma /
 *      invalid stored value / failed read all degrade to the seeded ceiling
 *      and NEVER throw out of bootstrap.
 *   3. pass-through — `GuardrailsService.setMaxConcurrentTasks(n)` delegates
 *      to the semaphore setter, so a bootstrap raise back-fills any queued
 *      backlog in FIFO order (same promoting path as a settings-save push).
 *
 * This inlines a FAITHFUL re-creation of ONLY the seams under test — the env
 * seed resolution, the runtime-mutable semaphore ceiling, and the persisted
 * load — mirroring `guardrails.module.ts` / `guardrails.service.ts` /
 * `semaphore.ts` so it stays a no-transpile `.mjs` script like its siblings
 * while pinning the documented contract.
 */

// ---- inline the seed resolution (mirrors guardrails.module.ts) --------------

const DEFAULT_MAX_CONCURRENT_TASKS = 5;

function readPositiveInt(raw, fallback) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Mirrors the `maxConcurrentTasks` seed in `readGuardrailsConfig()`. */
function seedMaxConcurrentTasks(envRaw) {
  return readPositiveInt(envRaw, DEFAULT_MAX_CONCURRENT_TASKS);
}

// ---- inline the runtime-mutable semaphore (mirrors semaphore.ts) ------------

class ConcurrencySemaphore {
  constructor(options) {
    if (!Number.isInteger(options.maxConcurrentTasks) || options.maxConcurrentTasks < 1) {
      throw new Error(
        `MAX_CONCURRENT_TASKS must be a positive integer, received: ${String(options.maxConcurrentTasks)}`,
      );
    }
    this._maxConcurrentTasks = options.maxConcurrentTasks;
    this.onAdmit = options.onAdmit;
    this.running = new Set();
    this.queue = [];
  }

  get maxConcurrentTasks() { return this._maxConcurrentTasks; }
  get runningCount() { return this.running.size; }
  get queuedCount() { return this.queue.length; }
  get hasCapacity() { return this.running.size < this._maxConcurrentTasks; }

  setMaxConcurrentTasks(maxConcurrentTasks) {
    if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1) {
      throw new Error(
        `maxConcurrentTasks must be a positive integer, received: ${String(maxConcurrentTasks)}`,
      );
    }
    this._maxConcurrentTasks = maxConcurrentTasks;
    // On a raise, back-fill the freed capacity from the FIFO backlog right away.
    while (this._admitNext() !== null) { /* promotes one queued task per pass */ }
  }

  offer(taskId) {
    if (this.running.has(taskId)) return 'running';
    if (this.queue.includes(taskId)) return 'queued';
    if (this.hasCapacity) {
      this.running.add(taskId);
      return 'running';
    }
    this.queue.push(taskId);
    return 'queued';
  }

  _admitNext() {
    if (!this.hasCapacity || this.queue.length === 0) return null;
    const next = this.queue.shift();
    if (next === undefined) return null;
    this.running.add(next);
    this.onAdmit?.(next);
    return next;
  }
}

// ---- inline the service bootstrap seam (mirrors guardrails.service.ts) ------

class GuardrailsBootstrapHarness {
  /**
   * @param config  `{ maxConcurrentTasks, defaultIdleTimeoutMs?, onAdmit? }` —
   *                the env-resolved construction seed (+ optional operator idle
   *                default, mirroring `GuardrailsService`).
   * @param prisma  optional `{ systemSettings: { findFirst() } }` slice, or
   *                undefined for a guardrails-only context without a database.
   */
  constructor(config, prisma) {
    this.semaphore = new ConcurrencySemaphore({
      maxConcurrentTasks: config.maxConcurrentTasks,
      onAdmit: config.onAdmit,
    });
    this.prisma = prisma;
    this.warnings = []; // mirrors logger.warn on a failed read (swallowed)
    // Mirror the operator-level idle default + the in-memory maps/recorders the
    // real `readopt` touches, so the re-adoption seam is exercised faithfully.
    this.defaultIdleTimeoutMs = config.defaultIdleTimeoutMs ?? null;
    this.connections = new Map(); // taskId -> connection handle (captured)
    this.attached = []; // taskId — gateway.openSession (attach-to-live) calls
    this.attachedRuns = new Map(); // taskId -> selected-run metadata passed to openSession
    this.armedIdle = new Map(); // taskId -> idle ceiling armed
    this.armedDeadline = new Map(); // taskId -> deadline armed
    this.runnerStarted = []; // taskId — runner-minutes interval opened
  }

  /** Mirrors `GuardrailsService.setMaxConcurrentTasks` (pass-through). */
  setMaxConcurrentTasks(maxConcurrentTasks) {
    this.semaphore.setMaxConcurrentTasks(maxConcurrentTasks);
  }

  /**
   * Mirrors `GuardrailsService.readopt` (survive-api-redeploy 4.1): re-account
   * the slot via `offer()`, capture the connection handle, re-attach the
   * terminal (gateway.openSession), and re-arm the idle/deadline watchers from
   * the persisted params — with NO lifecycle transition and NO fresh provision.
   */
  readopt(taskId, connection, params = {}, selectedRun = null) {
    this.semaphore.offer(taskId);
    this.connections.set(taskId, connection);
    this.attached.push(taskId);
    this.attachedRuns.set(taskId, selectedRun);
    const idleMs = params.idleTimeoutMs ?? this.defaultIdleTimeoutMs ?? undefined;
    if (idleMs !== undefined) {
      this.armedIdle.set(taskId, idleMs);
    }
    if (params.deadlineMs !== undefined) {
      this.armedDeadline.set(taskId, params.deadlineMs);
    }
    this.runnerStarted.push(taskId);
  }

  /** Mirrors `GuardrailsService.loadPersistedCeiling`. */
  async loadPersistedCeiling() {
    if (!this.prisma) {
      return this.semaphore.maxConcurrentTasks;
    }
    try {
      const row = await this.prisma.systemSettings.findFirst();
      const persisted = row?.maxConcurrentTasks;
      if (persisted !== undefined && Number.isInteger(persisted) && persisted >= 1) {
        this.semaphore.setMaxConcurrentTasks(persisted);
      }
    } catch (err) {
      this.warnings.push(err instanceof Error ? err.message : String(err));
    }
    return this.semaphore.maxConcurrentTasks;
  }
}

/** A prisma slice whose single `SystemSettings` row is `row` (or null). */
function prismaWithRow(row) {
  return { systemSettings: { findFirst: async () => row } };
}

// ---- assertion helpers ----

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ---- tests ----

console.log('\n=== Guardrails bootstrap: persisted ceiling load ===\n');

// T1: persisted N with env M boots to effective ceiling N (persisted wins)
{
  const seed = seedMaxConcurrentTasks('5'); // env MAX_CONCURRENT_TASKS=5
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seed },
    prismaWithRow({ id: 'system', maxConcurrentTasks: 3 }),
  );

  assert(svc.semaphore.maxConcurrentTasks === 5, 'T1a: construction seeds the env value (5)');
  const effective = await svc.loadPersistedCeiling();
  assert(effective === 3, 'T1b: load returns the persisted ceiling (3), not env (5)');
  assert(svc.semaphore.maxConcurrentTasks === 3, 'T1c: live semaphore ceiling is the persisted 3');
}

// T2: persisted value also wins when it is HIGHER than env, and the raise
//     back-fills a queued backlog in FIFO order (load goes through the
//     promoting setter, not a raw assignment)
{
  const admitted = [];
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seedMaxConcurrentTasks('1'), onAdmit: (id) => admitted.push(id) },
    prismaWithRow({ id: 'system', maxConcurrentTasks: 2 }),
  );
  svc.semaphore.offer('r1'); // takes the single seeded slot
  svc.semaphore.offer('q1'); // queued behind the env seed of 1
  svc.semaphore.offer('q2');

  const effective = await svc.loadPersistedCeiling();
  assert(effective === 2, 'T2a: persisted 2 overrides env 1');
  assert(admitted.length === 1 && admitted[0] === 'q1', 'T2b: raise promotes the oldest queued task (FIFO)');
  assert(svc.semaphore.runningCount === 2 && svc.semaphore.queuedCount === 1, 'T2c: q2 stays queued at the new cap');
}

// T3: no persisted row boots to the env value
{
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seedMaxConcurrentTasks('7') },
    prismaWithRow(null),
  );
  const effective = await svc.loadPersistedCeiling();
  assert(effective === 7, 'T3a: absent row leaves the env seed (7) effective');
}

// T4: no persisted row AND env unset boots to the default 5
{
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seedMaxConcurrentTasks(undefined) },
    prismaWithRow(null),
  );
  const effective = await svc.loadPersistedCeiling();
  assert(effective === 5, 'T4a: dbSetting ?? envDefault ?? 5 bottoms out at 5');
}

// T5: no prisma wired (guardrails-only unit context) degrades to the seed
{
  const svc = new GuardrailsBootstrapHarness({ maxConcurrentTasks: seedMaxConcurrentTasks('4') }, undefined);
  const effective = await svc.loadPersistedCeiling();
  assert(effective === 4, 'T5a: missing prisma keeps the env seed (4)');
}

// T6: a failed read is swallowed (bootstrap never crashes) and keeps the seed
{
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seedMaxConcurrentTasks('5') },
    { systemSettings: { findFirst: async () => { throw new Error('relation "system_settings" does not exist'); } } },
  );
  let threw = false;
  let effective;
  try {
    effective = await svc.loadPersistedCeiling();
  } catch {
    threw = true;
  }
  assert(!threw, 'T6a: loadPersistedCeiling never throws on a failed read');
  assert(effective === 5, 'T6b: failed read keeps the env seed (5)');
  assert(svc.warnings.length === 1, 'T6c: the failure is surfaced as a warning, not an error');
}

// T7: an invalid stored value (0 / non-integer) is ignored, ceiling unchanged
{
  for (const bad of [0, -1, 2.5]) {
    const svc = new GuardrailsBootstrapHarness(
      { maxConcurrentTasks: seedMaxConcurrentTasks('5') },
      prismaWithRow({ id: 'system', maxConcurrentTasks: bad }),
    );
    const effective = await svc.loadPersistedCeiling();
    assert(effective === 5, `T7-${String(bad)}: invalid persisted value ${String(bad)} is ignored (seed 5 kept)`);
  }
}

// T8: the load is idempotent — the double call (service hook + ceiling-first
//     startup recovery) is harmless
{
  const svc = new GuardrailsBootstrapHarness(
    { maxConcurrentTasks: seedMaxConcurrentTasks('5') },
    prismaWithRow({ id: 'system', maxConcurrentTasks: 2 }),
  );
  const first = await svc.loadPersistedCeiling();
  const second = await svc.loadPersistedCeiling();
  assert(first === 2 && second === 2, 'T8a: repeated loads converge on the persisted ceiling (2)');
  assert(svc.semaphore.runningCount === 0 && svc.semaphore.queuedCount === 0, 'T8b: repeated loads mutate no admission state');
}

// ---- re-adoption (survive-api-redeploy guardrails-recovery 4.1) ----

console.log('\n=== Guardrails re-adoption: readopt holds a slot + re-arms timers ===\n');

const conn = (taskId) => ({
  taskId,
  baseUrl: `http://cap-aio-${taskId}:8080`,
  wsUrl: `ws://cap-aio-${taskId}:8080/v1/shell/ws`,
});

// R1: a live-session task is re-adopted — slot held, terminal re-attached,
//     deadline + idle watchers armed from the PERSISTED params, runner started.
{
  const svc = new GuardrailsBootstrapHarness({ maxConcurrentTasks: seedMaxConcurrentTasks('5') });
  svc.readopt('t-live', conn('t-live'), { deadlineMs: 60000, idleTimeoutMs: 30000 });

  assert(svc.semaphore.isRunning?.('t-live') ?? svc.semaphore.runningCount === 1, 'R1a: re-adopt holds a running slot');
  assert(svc.semaphore.runningCount === 1 && svc.semaphore.queuedCount === 0, 'R1b: exactly one slot accounted, none queued');
  assert(svc.connections.get('t-live')?.wsUrl === conn('t-live').wsUrl, 'R1c: the surviving connection handle is captured');
  assert(svc.attached.length === 1 && svc.attached[0] === 't-live', 'R1d: the terminal is re-attached (openSession) once');
  assert(svc.armedDeadline.get('t-live') === 60000, 'R1e: deadline re-armed from persisted deadlineMs');
  assert(svc.armedIdle.get('t-live') === 30000, 'R1f: idle re-armed from persisted idleTimeoutMs');
  assert(svc.runnerStarted.includes('t-live'), 'R1g: runner-minutes interval re-opened');
}

// R1-selected: selected-run metadata is forwarded to the terminal attach path.
{
  const svc = new GuardrailsBootstrapHarness({ maxConcurrentTasks: seedMaxConcurrentTasks('5') });
  const selectedRun = {
    taskId: 't-live',
    providerId: 'boxlite-test',
    terminal: { protocol: 'boxlite-v1', wsUrl: 'wss://boxlite/t-live/tty' },
  };
  svc.readopt('t-live', conn('t-live'), {}, selectedRun);

  assert(svc.attachedRuns.get('t-live') === selectedRun, 'R1h: selected-run metadata is forwarded to openSession');
}

// R2: re-adopt with NO persisted params — no deadline, idle left to the
//     operator-level default (off when unset): no fabricated watcher values.
{
  const svc = new GuardrailsBootstrapHarness({ maxConcurrentTasks: seedMaxConcurrentTasks('5') });
  svc.readopt('t-bare', conn('t-bare'), {});

  assert(svc.semaphore.runningCount === 1, 'R2a: slot still held without params');
  assert(!svc.armedDeadline.has('t-bare'), 'R2b: no deadline armed when none persisted');
  assert(!svc.armedIdle.has('t-bare'), 'R2c: idle NOT armed (no per-task value, operator default off)');
}

// R3: an operator-level idle default arms idle on re-adopt even with no per-task
//     idleTimeoutMs (mirrors `idleTimeoutMs ?? defaultIdleTimeoutMs`).
{
  const svc = new GuardrailsBootstrapHarness({
    maxConcurrentTasks: seedMaxConcurrentTasks('5'),
    defaultIdleTimeoutMs: 45000,
  });
  svc.readopt('t-def', conn('t-def'), { deadlineMs: undefined, idleTimeoutMs: undefined });
  assert(svc.armedIdle.get('t-def') === 45000, 'R3a: idle arms from the operator-level default on re-adopt');
}

// R4: re-adopted slots reduce the capacity the later queued re-offer admits
//     against — with ceiling 2 and one re-adopted task, only ONE queued task is
//     admitted, the rest stay queued (the slot-accounting that 4.2 relies on).
{
  const admitted = [];
  const svc = new GuardrailsBootstrapHarness({
    maxConcurrentTasks: seedMaxConcurrentTasks('2'),
    onAdmit: (id) => admitted.push(id),
  });
  // Phase 0: re-adopt one survivor (takes a slot, no admit callback).
  svc.readopt('survivor', conn('survivor'), {});
  // Phase 2: re-offer two queued tasks against the remaining capacity.
  const o1 = svc.semaphore.offer('q1');
  const o2 = svc.semaphore.offer('q2');

  assert(svc.semaphore.runningCount === 2, 'R4a: ceiling 2 = 1 re-adopted + 1 admitted from the queue');
  assert(o1 === 'running' && o2 === 'queued', 'R4b: capacity reduced by the re-adopted slot (only q1 admitted)');
  assert(svc.semaphore.queuedCount === 1, 'R4c: q2 stays queued behind the re-adopted slot');
}

// ---- summary ----

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
