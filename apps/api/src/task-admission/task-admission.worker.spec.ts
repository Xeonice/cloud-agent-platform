import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMINAL_TASK_STATUSES,
  type TaskProvisioningStage,
} from '@cap/contracts';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionRetryPolicy,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
  type TaskAdmissionWorkerOptions,
} from './task-admission-runtime';
import {
  TaskAdmissionCoordinationError,
  TaskAdmissionProcessingError,
  TaskAdmissionProcessorUnavailableError,
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionProcessor,
  type TaskAdmissionProcessorContext,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
  type TaskAdmissionSettlement,
} from './task-admission.types';
import {
  TaskAdmissionWorker,
  UnboundTaskAdmissionProcessor,
} from './task-admission.worker';

const STAGES = [
  'accepted',
  'sandbox_creation',
  'credential_setup',
  'remote_ref_resolution',
  'workspace_transfer',
  'checkout',
  'submodules',
  'credential_cleanup',
  'runtime_setup',
  'readiness',
  'agent_launch',
  'complete',
] as const satisfies readonly TaskProvisioningStage[];

const PENDING_TASK_FENCES = [
  { status: 'pending', lifecycleVersion: 0 },
] as const;

interface MemoryWork {
  readonly taskId: string;
  state:
    | 'accepted'
    | 'queued'
    | 'running'
    | 'retrying'
    | 'succeeded'
    | 'failed'
    | 'cancelled';
  attempt: number;
  availableAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  stage: TaskProvisioningStage;
  causeCode: TaskAdmissionClaim['causeCode'];
  taskStatus: TaskAdmissionClaim['taskStatus'];
  taskLifecycleVersion: number;
  settlement: TaskAdmissionSettlement | null;
}

class ManualClock extends TaskAdmissionClock {
  constructor(private currentMs = 0) {
    super();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  get value(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    this.currentMs += ms;
  }
}

class ManualScheduler extends TaskAdmissionScheduler {
  private nextId = 0;
  private readonly timers: Array<{
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  constructor(private readonly clock: ManualClock) {
    super();
  }

  schedule(delayMs: number, callback: () => void): TaskAdmissionTimer {
    const entry = {
      id: ++this.nextId,
      dueAt: this.clock.value + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(entry);
    return { cancel: () => (entry.cancelled = true) };
  }

  runDue(): void {
    for (;;) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= this.clock.value)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) return;
      next.cancelled = true;
      next.callback();
    }
  }

  advance(ms: number): void {
    this.clock.advance(ms);
    this.runDue();
  }
}

class SequenceLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  constructor(private readonly prefix: string) {
    super();
  }

  create(): string {
    this.sequence += 1;
    return `${this.prefix}:${this.sequence}`;
  }
}

class MemoryTaskAdmissionStore extends TaskAdmissionStore {
  readonly rows: MemoryWork[] = [];
  readonly claimTokens: string[] = [];
  settleFailures = 0;
  forceRenewLost = false;
  renewError: unknown = null;
  checkpointError: unknown = null;
  renewObserved: (() => void) | null = null;

  constructor(private readonly clock: ManualClock) {
    super();
  }

  add(
    taskId: string,
    overrides: Partial<Omit<MemoryWork, 'taskId'>> = {},
  ): MemoryWork {
    const row: MemoryWork = {
      taskId,
      state: 'accepted',
      attempt: 0,
      availableAt: this.clock.value,
      leaseToken: null,
      leaseUntil: null,
      stage: 'accepted',
      causeCode: null,
      taskStatus: 'pending',
      taskLifecycleVersion: 0,
      settlement: null,
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    const row = this.rows.find(
      (candidate) =>
        ((candidate.state === 'accepted' ||
          candidate.state === 'queued' ||
          candidate.state === 'retrying' ||
          (candidate.state === 'succeeded' &&
            (TERMINAL_TASK_STATUSES as readonly string[]).includes(
              candidate.taskStatus,
            ))) &&
          candidate.availableAt <= this.clock.value) ||
        (candidate.state === 'running' &&
          candidate.leaseUntil !== null &&
          candidate.leaseUntil <= this.clock.value),
    );
    if (!row) return null;

    const sourceState = row.state as TaskAdmissionClaim['sourceState'];
    row.attempt = (TERMINAL_TASK_STATUSES as readonly string[]).includes(
      row.taskStatus,
    )
      ? Math.max(row.attempt, 1)
      : sourceState === 'queued'
        ? row.attempt
        : row.attempt + 1;
    row.state = 'running';
    row.leaseToken = request.leaseToken;
    row.leaseUntil = this.clock.value + request.leaseDurationMs;
    row.settlement = null;
    this.claimTokens.push(request.leaseToken);
    return Object.freeze({
      taskId: row.taskId,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(row.leaseUntil),
      sourceState,
      attempt: row.attempt,
      stage: row.stage,
      causeCode: row.causeCode,
      resolvedBranch: 'master',
      resourceSnapshot: Object.freeze({ diskSizeGb: 12 }),
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: row.taskStatus,
      taskLifecycleVersion: row.taskLifecycleVersion,
    });
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    this.renewObserved?.();
    if (this.renewError !== null) throw this.renewError;
    if (this.forceRenewLost) return false;
    const row = this.authorizedRow(request);
    if (!row) return false;
    row.leaseUntil = this.clock.value + request.leaseDurationMs;
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    if (this.checkpointError !== null) throw this.checkpointError;
    const row = this.authorizedRow(request);
    if (!row || stageIndex(request.stage) < stageIndex(row.stage)) return false;
    row.stage = request.stage;
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (this.settleFailures > 0) {
      this.settleFailures -= 1;
      throw new Error('settlement unavailable');
    }
    const row = this.authorizedRow(request);
    if (!row) return false;
    row.state = request.settlement.state;
    row.stage = request.settlement.stage;
    row.causeCode =
      request.settlement.state === 'failed' ||
      request.settlement.state === 'retrying'
        ? request.settlement.causeCode
        : null;
    row.availableAt =
      request.settlement.state === 'queued' ||
      request.settlement.state === 'retrying'
        ? this.clock.value + request.settlement.availableAfterMs
        : this.clock.value;
    row.leaseToken = null;
    row.leaseUntil = null;
    row.settlement = request.settlement;
    return true;
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.authorizedRow(request) !== null;
  }

  private authorizedRow(request: TaskAdmissionAuthorityRequest): MemoryWork | null {
    const row = this.owned(request.taskId, request.leaseToken);
    if (!row) return null;
    return request.taskFences.some(
      (fence) =>
        fence.status === row.taskStatus &&
        fence.lifecycleVersion === row.taskLifecycleVersion,
    )
      ? row
      : null;
  }

  private owned(taskId: string, leaseToken: string): MemoryWork | null {
    return (
      this.rows.find(
        (row) =>
          row.taskId === taskId &&
          row.state === 'running' &&
          row.leaseToken === leaseToken &&
          row.leaseUntil !== null &&
          row.leaseUntil > this.clock.value,
      ) ?? null
    );
  }
}

class FirstClaimBarrierStore extends TaskAdmissionStore {
  private first = true;

  constructor(
    private readonly inner: MemoryTaskAdmissionStore,
    private readonly entered: Deferred<void>,
    private readonly release: Deferred<void>,
  ) {
    super();
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    if (this.first) {
      this.first = false;
      this.entered.resolve();
      await this.release.promise;
      return null;
    }
    return this.inner.claim(request);
  }

  renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    return this.inner.renew(request);
  }

  authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.inner.authorize(request);
  }

  checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    return this.inner.checkpoint(request);
  }

  settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    return this.inner.settle(request);
  }
}

class FirstClaimReturnBarrierStore extends TaskAdmissionStore {
  private first = true;

  constructor(
    private readonly inner: MemoryTaskAdmissionStore,
    private readonly entered: Deferred<void>,
    private readonly release: Deferred<void>,
  ) {
    super();
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    const claim = await this.inner.claim(request);
    if (!this.first) return claim;

    this.first = false;
    this.entered.resolve();
    await this.release.promise;
    return claim;
  }

  renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    return this.inner.renew(request);
  }

  authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.inner.authorize(request);
  }

  checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    return this.inner.checkpoint(request);
  }

  settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    return this.inner.settle(request);
  }
}

class FunctionProcessor implements TaskAdmissionProcessor {
  constructor(
    private readonly implementation: (
      context: TaskAdmissionProcessorContext,
    ) => ReturnType<TaskAdmissionProcessor['process']>,
  ) {}

  process(context: TaskAdmissionProcessorContext) {
    return this.implementation(context);
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workerOptions(
  overrides: Partial<TaskAdmissionWorkerOptions> = {},
): TaskAdmissionWorkerOptions {
  return {
    ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
    leaseDurationMs: 100,
    renewIntervalMs: 25,
    pollIntervalMs: 50,
    queuedRetryAfterMs: 10,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    retryJitterRatio: 0.2,
    maxAttempts: 3,
    maxInFlight: 2,
    ...overrides,
  };
}

function createWorker(args: {
  readonly store: TaskAdmissionStore;
  readonly processor: TaskAdmissionProcessor;
  readonly clock: ManualClock;
  readonly scheduler?: ManualScheduler;
  readonly tokenPrefix?: string;
  readonly options?: Partial<TaskAdmissionWorkerOptions>;
  readonly audit?: AuditRecorderPort;
}): { worker: TaskAdmissionWorker; scheduler: ManualScheduler } {
  const scheduler = args.scheduler ?? new ManualScheduler(args.clock);
  return {
    scheduler,
    worker: new TaskAdmissionWorker(
      args.store,
      args.processor,
      scheduler,
      args.clock,
      new SequenceLeaseTokens(args.tokenPrefix ?? 'worker'),
      workerOptions(args.options),
      undefined,
      args.audit,
    ),
  };
}

function stageIndex(stage: TaskProvisioningStage): number {
  return STAGES.indexOf(stage);
}

test('two workers contending for one row produce one valid owner and one processor call', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('task-1');
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const processor = new FunctionProcessor(async () => {
    calls += 1;
    entered.resolve();
    await release.promise;
    return { kind: 'succeeded' };
  });
  const first = createWorker({ store, processor, clock, tokenPrefix: 'first' });
  const second = createWorker({ store, processor, clock, tokenPrefix: 'second' });

  const firstRun = first.worker.runOnce();
  await entered.promise;
  assert.deepEqual(await second.worker.runOnce(), { kind: 'idle' });
  assert.equal(calls, 1);
  assert.equal(new Set(store.claimTokens).size, store.claimTokens.length);

  release.resolve();
  assert.equal((await firstRun).kind, 'succeeded');
  assert.equal(store.rows[0]?.state, 'succeeded');
});

test('generation wake closes the empty-query parking race without a fixed sleep', async () => {
  const clock = new ManualClock();
  const inner = new MemoryTaskAdmissionStore(clock);
  const firstClaimEntered = deferred<void>();
  const releaseEmptyClaim = deferred<void>();
  const store = new FirstClaimBarrierStore(
    inner,
    firstClaimEntered,
    releaseEmptyClaim,
  );
  let processed = 0;
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      processed += 1;
      return { kind: 'succeeded' };
    }),
  });

  worker.start();
  scheduler.runDue();
  await firstClaimEntered.promise;
  inner.add('arrived-between-query-and-park');
  worker.wake('arrived-between-query-and-park');
  releaseEmptyClaim.resolve();
  await worker.waitForBackgroundIdle();

  assert.equal(processed, 1);
  assert.equal(inner.rows[0]?.state, 'succeeded');
  await worker.stop();
});

test('database polling remains authoritative when no local wake is delivered', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => ({ kind: 'succeeded' })),
  });

  worker.start();
  scheduler.runDue();
  await worker.waitForBackgroundIdle();
  store.add('poll-only');
  scheduler.advance(50);
  await worker.waitForBackgroundIdle();

  assert.equal(store.rows[0]?.state, 'succeeded');
  await worker.stop();
});

test('background shutdown does not dispatch a claim returned after its generation stopped', async () => {
  const clock = new ManualClock();
  const inner = new MemoryTaskAdmissionStore(clock);
  const row = inner.add('claimed-during-shutdown');
  const claimEntered = deferred<void>();
  const releaseClaim = deferred<void>();
  const store = new FirstClaimReturnBarrierStore(
    inner,
    claimEntered,
    releaseClaim,
  );
  let processorCalls = 0;
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      processorCalls += 1;
      return { kind: 'succeeded' };
    }),
  });

  worker.start();
  scheduler.runDue();
  await claimEntered.promise;
  assert.equal(row.state, 'running', 'the database lease is already acquired');

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false, 'stop waits for the pending background claim');

  releaseClaim.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(processorCalls, 0);
  assert.equal(row.state, 'running');
  assert.equal(row.leaseToken, 'worker:1');

  clock.advance(101);
  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.equal(processorCalls, 1, 'manual runOnce remains usable while stopped');
});

test('a restarted generation is handed off after an old deferred claim without dispatching the old lease', async () => {
  const clock = new ManualClock();
  const inner = new MemoryTaskAdmissionStore(clock);
  const row = inner.add('claimed-before-restart');
  const claimEntered = deferred<void>();
  const releaseClaim = deferred<void>();
  const store = new FirstClaimReturnBarrierStore(
    inner,
    claimEntered,
    releaseClaim,
  );
  let processorCalls = 0;
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      processorCalls += 1;
      return { kind: 'succeeded' };
    }),
  });

  worker.start();
  scheduler.runDue();
  await claimEntered.promise;
  const stopping = worker.stop();
  worker.start();

  releaseClaim.resolve();
  await stopping;
  assert.equal(processorCalls, 0);
  assert.equal(row.state, 'running');

  clock.advance(101);
  scheduler.runDue();
  await worker.waitForBackgroundIdle();
  assert.equal(processorCalls, 1);
  assert.equal(row.state, 'succeeded');
  await worker.stop();
});

test('lease renewal is DB-time fenced and an expired previous owner cannot renew, checkpoint, or settle', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('leased');
  const first = await store.claim({ leaseToken: 'owner:first', leaseDurationMs: 100 });
  assert.ok(first);
  clock.advance(75);
  assert.equal(
    await store.renew({
      taskId: 'leased',
      leaseToken: 'owner:first',
      leaseDurationMs: 100,
      taskFences: PENDING_TASK_FENCES,
    }),
    true,
  );
  clock.advance(50);
  assert.equal(
    await store.checkpoint({
      taskId: 'leased',
      leaseToken: 'owner:first',
      stage: 'workspace_transfer',
      taskFences: PENDING_TASK_FENCES,
    }),
    true,
  );
  assert.equal(
    await store.checkpoint({
      taskId: 'leased',
      leaseToken: 'owner:first',
      stage: 'accepted',
      taskFences: PENDING_TASK_FENCES,
    }),
    false,
    'durable stages cannot regress',
  );

  clock.advance(51);
  const replay = await store.claim({
    leaseToken: 'owner:replay',
    leaseDurationMs: 100,
  });
  assert.equal(replay?.attempt, 2);
  assert.equal(
    await store.renew({
      taskId: 'leased',
      leaseToken: 'owner:first',
      leaseDurationMs: 100,
      taskFences: PENDING_TASK_FENCES,
    }),
    false,
  );
  assert.equal(
    await store.checkpoint({
      taskId: 'leased',
      leaseToken: 'owner:first',
      stage: 'runtime_setup',
      taskFences: PENDING_TASK_FENCES,
    }),
    false,
  );
  assert.equal(
    await store.settle({
      taskId: 'leased',
      leaseToken: 'owner:first',
      taskFences: PENDING_TASK_FENCES,
      settlement: { state: 'succeeded', stage: 'complete' },
    }),
    false,
  );
});

test('queued replay preserves its already claimed attempt number', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('queued', { state: 'queued', attempt: 2 });
  const claim = await store.claim({ leaseToken: 'queued:owner', leaseDurationMs: 100 });
  assert.equal(claim?.sourceState, 'queued');
  assert.equal(claim?.attempt, 2);
});

test('only typed transient infrastructure errors retry and retry exhaustion is terminal', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('retryable');
  let calls = 0;
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      calls += 1;
      throw new TaskAdmissionProcessingError(
        'provisioning_tls_network_failed',
        'remote_ref_resolution',
        true,
      );
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'retrying');
  assert.equal(row.settlement?.state, 'retrying');
  if (row.settlement?.state === 'retrying') {
    assert.equal(row.settlement.stage, 'remote_ref_resolution');
    assert.equal(
      row.settlement.causeCode,
      'provisioning_tls_network_failed',
    );
    assert.ok(row.settlement.availableAfterMs > 0);
  }
  assert.equal(row.causeCode, 'provisioning_tls_network_failed');
  clock.advance(100);
  assert.equal((await worker.runOnce()).kind, 'retrying');
  assert.equal(row.causeCode, 'provisioning_tls_network_failed');
  clock.advance(100);
  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.equal(calls, 3);
  assert.equal(row.attempt, 3);
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'remote_ref_resolution',
    causeCode: 'provisioning_tls_network_failed',
  });
});

test('deterministic auth failure stays terminal even when a processor marks it retryable', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('auth');
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      throw new TaskAdmissionProcessingError(
        'provisioning_forge_auth_failed',
        'remote_ref_resolution',
        true,
      );
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.equal(row.attempt, 1);
  assert.equal(row.settlement?.state, 'failed');
});

test('platform dependency failure is terminal even when a processor marks it retryable', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('missing-platform-dependency');
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      throw new TaskAdmissionProcessingError(
        'provisioning_platform_dependency_unavailable',
        'remote_ref_resolution',
        true,
      );
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.equal(row.attempt, 1);
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'remote_ref_resolution',
    causeCode: 'provisioning_platform_dependency_unavailable',
  });
});

test('unknown exceptions terminalize with only the safe provisioning_unknown code', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('unknown');
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      throw new Error('raw provider secret-bearing diagnostic');
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'accepted',
    causeCode: 'provisioning_unknown',
  });
});

test('unknown failures retain the latest durable checkpoint as their safe stage', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('unknown-after-checkpoint');
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async (context) => {
      await context.lease.checkpoint('agent_launch');
      throw new Error('raw provider secret-bearing diagnostic');
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'failed');
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'agent_launch',
    causeCode: 'provisioning_unknown',
  });
});

test('provisioning audit follows durable checkpoints and never blocks controlled work', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('audit-best-effort');
  const progress: Array<{
    readonly taskId: string;
    readonly stage: TaskProvisioningStage;
    readonly attempt: number;
  }> = [];
  const audit = {
    async recordProvisioningProgress(
      taskId: string,
      stage: TaskProvisioningStage,
      attempt: number,
    ) {
      progress.push({ taskId, stage, attempt });
      if (stage === 'accepted') {
        return new Promise<void>(() => undefined);
      }
      if (stage === 'workspace_transfer') {
        throw new Error('secret-canary raw git diagnostic');
      }
    },
  } as unknown as AuditRecorderPort;
  const { worker } = createWorker({
    store,
    clock,
    audit,
    processor: new FunctionProcessor(async (context) => {
      await context.lease.checkpoint('workspace_transfer');
      await context.lease.checkpoint('checkout');
      await context.lease.checkpoint('complete');
      return { kind: 'succeeded' };
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.equal(row.state, 'succeeded');
  assert.equal(row.stage, 'complete');
  assert.deepEqual(progress, [
    { taskId: 'audit-best-effort', stage: 'accepted', attempt: 1 },
    { taskId: 'audit-best-effort', stage: 'workspace_transfer', attempt: 1 },
    { taskId: 'audit-best-effort', stage: 'checkout', attempt: 1 },
    { taskId: 'audit-best-effort', stage: 'complete', attempt: 1 },
  ]);
});

test('terminal task claims are cancelled without invoking the processor', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal', { taskStatus: 'cancelled' });
  let calls = 0;
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => {
      calls += 1;
      return { kind: 'succeeded' };
    }),
  });

  assert.equal((await worker.runOnce()).kind, 'cancelled');
  assert.equal(calls, 0);
  assert.equal(row.state, 'cancelled');
});

test('expired terminal work preserves the original attempt while repairing audit detail and strict cleanup', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-cleanup-recovery', {
    state: 'running',
    attempt: 1,
    leaseToken: 'crashed-owner',
    leaseUntil: 0,
    taskStatus: 'failed',
    taskLifecycleVersion: 8,
    stage: 'runtime_setup',
    causeCode: 'provisioning_unknown',
  });
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  let processCalls = 0;
  let recoveryCalls = 0;
  // Phase 1 already persisted the central task.failed audit. Its paired detail
  // write is the operation recovery must repair with the same attempt number.
  const centralAuditAlreadyWritten = true;
  let repairedDetailAttempt: number | null = null;
  const processor: TaskAdmissionProcessor = {
    async process() {
      processCalls += 1;
      return { kind: 'succeeded' };
    },
    async recoverTerminal(context) {
      recoveryCalls += 1;
      assert.equal(centralAuditAlreadyWritten, true);
      repairedDetailAttempt = context.claim.attempt;
      await context.lease.authorize();
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      await context.lease.authorize();
      return {
        state: 'failed',
        stage: context.claim.stage,
        causeCode: context.claim.causeCode ?? 'provisioning_unknown',
      };
    },
  };
  const { worker } = createWorker({ store, clock, processor });

  const recovering = worker.runOnce();
  await cleanupEntered.promise;
  assert.equal(row.state, 'running');
  assert.equal(row.leaseToken, 'worker:1');
  releaseCleanup.resolve();

  assert.equal((await recovering).kind, 'failed');
  assert.equal(processCalls, 0);
  assert.equal(recoveryCalls, 1);
  assert.equal(row.attempt, 1);
  assert.equal(
    repairedDetailAttempt,
    1,
    'detail audit recovery must retain the terminal phase-one attempt',
  );
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'runtime_setup',
    causeCode: 'provisioning_unknown',
  });
});

test('completed terminal recovery settles a proven complete admission as succeeded', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-complete-recovery', {
    state: 'running',
    attempt: 1,
    leaseToken: 'crashed-owner',
    leaseUntil: 0,
    taskStatus: 'completed',
    taskLifecycleVersion: 4,
    stage: 'complete',
  });
  const processor: TaskAdmissionProcessor = {
    async process() {
      assert.fail('terminal recovery must not re-enter normal processing');
    },
    async recoverTerminal(context) {
      await context.lease.authorize();
      return { state: 'succeeded', stage: 'complete' };
    },
  };
  const { worker } = createWorker({ store, clock, processor });

  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.deepEqual(row.settlement, {
    state: 'succeeded',
    stage: 'complete',
  });
});

test('a normally succeeded admission is reclaimed only through terminal cleanup recovery without a new attempt', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-runtime-cleanup', {
    state: 'succeeded',
    attempt: 3,
    taskStatus: 'completed',
    taskLifecycleVersion: 7,
    stage: 'complete',
  });
  let processCalls = 0;
  let recoveryCalls = 0;
  const processor: TaskAdmissionProcessor = {
    async process() {
      processCalls += 1;
      return { kind: 'succeeded' };
    },
    async recoverTerminal(context) {
      recoveryCalls += 1;
      assert.equal(context.claim.sourceState, 'succeeded');
      assert.equal(context.claim.attempt, 3);
      await context.lease.authorize();
      return { state: 'succeeded', stage: 'complete' };
    },
  };
  const { worker } = createWorker({ store, clock, processor });

  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.equal(processCalls, 0);
  assert.equal(recoveryCalls, 1);
  assert.equal(row.attempt, 3);
  assert.deepEqual(row.settlement, {
    state: 'succeeded',
    stage: 'complete',
  });
});

test('pending cancellation audit leaves terminal work leased and reclaimable', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-cancellation-audit', {
    state: 'running',
    attempt: 1,
    leaseToken: 'crashed-owner',
    leaseUntil: 0,
    taskStatus: 'cancelled',
    taskLifecycleVersion: 4,
    stage: 'workspace_transfer',
  });
  const processor: TaskAdmissionProcessor = {
    async process() {
      assert.fail('terminal recovery must not re-enter normal processing');
    },
    async recoverTerminal(context) {
      throw new TaskAdmissionCoordinationError(
        'checkpoint',
        context.claim.taskId,
        new Error('terminal cancellation audit remains pending'),
      );
    },
  };
  const { worker } = createWorker({ store, clock, processor });

  await assert.rejects(worker.runOnce(), TaskAdmissionCoordinationError);
  assert.equal(row.state, 'running');
  assert.equal(row.leaseToken, 'worker:1');
  assert.equal(row.settlement, null);
});

test('automatic renewal stays active while recovered terminal cleanup crosses the original lease expiry', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-recovery-renewal', {
    state: 'running',
    attempt: 1,
    leaseToken: 'crashed-owner',
    leaseUntil: 0,
    taskStatus: 'failed',
    taskLifecycleVersion: 8,
    stage: 'runtime_setup',
    causeCode: 'provisioning_unknown',
  });
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  const renewalObserved = deferred<void>();
  store.renewObserved = () => renewalObserved.resolve();
  const processor: TaskAdmissionProcessor = {
    async process() {
      throw new Error('terminal recovery must not re-enter normal processing');
    },
    async recoverTerminal(context) {
      await context.lease.authorize();
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      await context.lease.authorize();
      return {
        state: 'failed',
        stage: context.claim.stage,
        causeCode: context.claim.causeCode ?? 'provisioning_unknown',
      };
    },
  };
  const { worker, scheduler } = createWorker({ store, clock, processor });

  const recovering = worker.runOnce();
  await cleanupEntered.promise;
  assert.equal(row.leaseToken, 'worker:1');
  assert.equal(row.leaseUntil, 100);

  scheduler.advance(25);
  await renewalObserved.promise;
  await Promise.resolve();
  assert.equal(row.leaseUntil, 125);

  clock.advance(80);
  assert.equal(clock.value, 105);
  assert.equal(
    await store.claim({
      leaseToken: 'competing-worker',
      leaseDurationMs: 100,
    }),
    null,
    'terminal recovery keeps exclusive authority after the original lease expires',
  );

  releaseCleanup.resolve();
  assert.equal((await recovering).kind, 'failed');
  assert.equal(row.state, 'failed');
  assert.deepEqual(row.settlement, {
    state: 'failed',
    stage: 'runtime_setup',
    causeCode: 'provisioning_unknown',
  });
});

test('automatic renewal stays active while terminal failure cleanup crosses the original lease expiry', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('terminal-cleanup-renewal');
  const cleanupEntered = deferred<void>();
  const releaseCleanup = deferred<void>();
  const renewalObserved = deferred<void>();
  store.renewObserved = () => renewalObserved.resolve();
  const processor: TaskAdmissionProcessor = {
    async process() {
      throw new TaskAdmissionProcessingError(
        'provisioning_unknown',
        'runtime_setup',
        false,
      );
    },
    async settleTerminalFailure(context) {
      // Mirror TasksService phase 1 before the external exact-owner cleanup.
      row.taskStatus = 'failed';
      row.taskLifecycleVersion += 1;
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      await context.lease.authorize();
      // Mirror the real two-phase processor's successful phase 2.
      row.state = 'failed';
      row.leaseToken = null;
      row.leaseUntil = null;
      return true;
    },
  };
  const { worker, scheduler } = createWorker({ store, clock, processor });

  const run = worker.runOnce();
  await cleanupEntered.promise;
  assert.equal(row.leaseUntil, 100);
  scheduler.advance(25);
  await renewalObserved.promise;
  await Promise.resolve();
  assert.equal(row.leaseUntil, 125);

  // Cross the original t=100 expiry without firing another renewal. The first
  // renewal must keep the strict cleanup's second authority check valid.
  clock.advance(80);
  assert.equal(clock.value, 105);
  assert.equal(
    await store.claim({
      leaseToken: 'competing-worker',
      leaseDurationMs: 100,
    }),
    null,
    'the renewed phase-1 lease cannot be claimed by another worker',
  );
  releaseCleanup.resolve();

  assert.equal((await run).kind, 'failed');
  assert.equal(row.state, 'failed');
});

test('settlement write failure is observable and expiry replay recovers the running lease', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('settlement-recovery');
  store.settleFailures = 1;
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async () => ({ kind: 'succeeded' })),
  });

  await assert.rejects(() => worker.runOnce(), /settlement unavailable/);
  assert.equal(row.state, 'running');
  assert.equal(row.attempt, 1);

  clock.advance(101);
  assert.equal((await worker.runOnce()).kind, 'succeeded');
  assert.equal(row.state, 'succeeded');
  assert.equal(row.attempt, 2);
});

test('automatic lease loss aborts the processor before settlement and waits for its barrier', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('lease-loss');
  store.forceRenewLost = true;
  const renewObserved = deferred<void>();
  store.renewObserved = () => renewObserved.resolve();
  const processorEntered = deferred<void>();
  const releaseProcessor = deferred<void>();
  const signal: { current: AbortSignal | null } = { current: null };
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async (context) => {
      signal.current = context.signal;
      processorEntered.resolve();
      await releaseProcessor.promise;
      return { kind: 'succeeded' };
    }),
  });

  const run = worker.runOnce();
  await processorEntered.promise;
  scheduler.advance(25);
  await renewObserved.promise;
  await Promise.resolve();
  assert.equal(signal.current?.aborted, true);

  releaseProcessor.resolve();
  assert.equal((await run).kind, 'lease-lost');
  assert.equal(store.rows[0]?.state, 'running');
});

test('automatic renewal coordination failure aborts first, waits for the processor, and remains observable', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('renew-error');
  store.renewError = new Error('database unavailable');
  const renewObserved = deferred<void>();
  store.renewObserved = () => renewObserved.resolve();
  const processorEntered = deferred<void>();
  const releaseProcessor = deferred<void>();
  const signal: { current: AbortSignal | null } = { current: null };
  const { worker, scheduler } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async (context) => {
      signal.current = context.signal;
      processorEntered.resolve();
      await releaseProcessor.promise;
      return { kind: 'succeeded' };
    }),
  });

  const run = worker.runOnce();
  await processorEntered.promise;
  scheduler.advance(25);
  await renewObserved.promise;
  await Promise.resolve();
  assert.equal(signal.current?.aborted, true);

  releaseProcessor.resolve();
  await assert.rejects(run, TaskAdmissionCoordinationError);
  assert.equal(store.rows[0]?.state, 'running');
});

test('manual checkpoint coordination failure is not downgraded to lease-lost or swallowed', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('manual-checkpoint-error');
  store.checkpointError = new Error('database unavailable');
  const signal: { current: AbortSignal | null } = { current: null };
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async (context) => {
      signal.current = context.signal;
      await context.lease.checkpoint('sandbox_creation');
      return { kind: 'succeeded' };
    }),
  });

  await assert.rejects(() => worker.runOnce(), TaskAdmissionCoordinationError);
  assert.equal(signal.current?.aborted, true);
  assert.equal(store.rows[0]?.state, 'running');
});

test('stop aborts every active processor and does not resolve before processor settlement', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  store.add('shutdown');
  const entered = deferred<void>();
  const release = deferred<void>();
  const signal: { current: AbortSignal | null } = { current: null };
  const { worker } = createWorker({
    store,
    clock,
    processor: new FunctionProcessor(async (context) => {
      signal.current = context.signal;
      entered.resolve();
      await release.promise;
      return { kind: 'succeeded' };
    }),
  });
  const run = worker.runOnce();
  await entered.promise;

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(signal.current?.aborted, true);
  assert.equal(stopped, false);

  release.resolve();
  await stopping;
  assert.equal(stopped, true);
  assert.equal((await run).kind, 'lease-lost');
});

test('drain dispatches up to maxInFlight and backfills a released local slot', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  for (const id of ['one', 'two', 'three']) store.add(id);
  const releases = new Map<string, Deferred<void>>();
  const firstTwoEntered = deferred<void>();
  const thirdEntered = deferred<void>();
  let active = 0;
  let maximum = 0;
  let entered = 0;
  const { worker } = createWorker({
    store,
    clock,
    options: { maxInFlight: 2 },
    processor: new FunctionProcessor(async ({ claim }) => {
      const release = deferred<void>();
      releases.set(claim.taskId, release);
      active += 1;
      entered += 1;
      maximum = Math.max(maximum, active);
      if (entered === 2) firstTwoEntered.resolve();
      if (claim.taskId === 'three') thirdEntered.resolve();
      await release.promise;
      active -= 1;
      return { kind: 'succeeded' };
    }),
  });

  const draining = worker.drain();
  await firstTwoEntered.promise;
  assert.equal(maximum, 2);
  assert.equal(releases.has('three'), false);

  releases.get('one')?.resolve();
  await thirdEntered.promise;
  assert.equal(maximum, 2);
  releases.get('two')?.resolve();
  releases.get('three')?.resolve();
  assert.equal(await draining, 3);
  assert.equal(store.rows.every((row) => row.state === 'succeeded'), true);
});

test('unbound processor is a recoverable coordination outage and never terminalizes work', async () => {
  const clock = new ManualClock();
  const store = new MemoryTaskAdmissionStore(clock);
  const row = store.add('unbound');
  const { worker } = createWorker({
    store,
    clock,
    processor: new UnboundTaskAdmissionProcessor(),
  });

  await assert.rejects(
    () => worker.runOnce(),
    TaskAdmissionProcessorUnavailableError,
  );
  assert.equal(row.state, 'running');
  assert.equal(row.settlement, null);
});

test('retry jitter is deterministic, bounded, and task-attempt specific', () => {
  const policy = new TaskAdmissionRetryPolicy(workerOptions());
  const first = policy.delayMs('same-task', 1);
  assert.equal(policy.delayMs('same-task', 1), first);
  assert.ok(first >= 1 && first <= 100);
  assert.ok(policy.delayMs('same-task', 2) >= 1);
  assert.equal(policy.canRetry(2), true);
  assert.equal(policy.canRetry(3), false);
});
