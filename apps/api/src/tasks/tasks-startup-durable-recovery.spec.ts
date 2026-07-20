import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskProvisioningStage } from '@cap/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type { SandboxConnection, SelectedSandboxRun } from '../sandbox/sandbox-provider.port';
import {
  DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
  TaskAdmissionClock,
  TaskAdmissionLeaseTokenFactory,
  TaskAdmissionScheduler,
  type TaskAdmissionTimer,
} from '../task-admission/task-admission-runtime';
import {
  TaskAdmissionStore,
  type TaskAdmissionAuthorityRequest,
  type TaskAdmissionCheckpointRequest,
  type TaskAdmissionClaim,
  type TaskAdmissionClaimRequest,
  type TaskAdmissionProcessor,
  type TaskAdmissionRenewRequest,
  type TaskAdmissionSettleRequest,
} from '../task-admission/task-admission.types';
import { TaskAdmissionWorker } from '../task-admission/task-admission.worker';
import {
  TasksService,
  type IGuardrailsService,
  type ISandboxReadoption,
} from './tasks.service';
import type { TaskAdmissionWakePort } from './task-admission-gate';

const LEGACY_TASK_ID = '11111111-1111-4111-8111-111111111111';
const DURABLE_TASK_ID = '22222222-2222-4222-8222-222222222222';
const LATE_DURABLE_TASK_ID = '33333333-3333-4333-8333-333333333333';
const DELETED_TASK_ID = '44444444-4444-4444-8444-444444444444';
const ACCEPTED_TASK_ID = '55555555-5555-4555-8555-555555555555';
const EXPIRED_RUNNING_TASK_ID = '66666666-6666-4666-8666-666666666666';
const TERMINAL_CLEANUP_TASK_ID = '77777777-7777-4777-8777-777777777777';
const TERMINAL_WITHOUT_LIVE_SANDBOX_TASK_ID =
  '88888888-8888-4888-8888-888888888888';

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class RecoveryClock extends TaskAdmissionClock {
  constructor(private currentMs = 10_000) {
    super();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  get value(): number {
    return this.currentMs;
  }
}

class RecoveryScheduler extends TaskAdmissionScheduler {
  private nextId = 0;
  private readonly timers: Array<{
    readonly id: number;
    readonly dueAt: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  constructor(private readonly clock: RecoveryClock) {
    super();
  }

  schedule(delayMs: number, callback: () => void): TaskAdmissionTimer {
    const timer = {
      id: ++this.nextId,
      dueAt: this.clock.value + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return { cancel: () => (timer.cancelled = true) };
  }

  runDue(): void {
    for (;;) {
      const timer = this.timers
        .filter(({ cancelled, dueAt }) => !cancelled && dueAt <= this.clock.value)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!timer) return;
      timer.cancelled = true;
      timer.callback();
    }
  }
}

class RecoveryLeaseTokens extends TaskAdmissionLeaseTokenFactory {
  private sequence = 0;

  create(): string {
    this.sequence += 1;
    return `startup-recovery:${this.sequence}`;
  }
}

type RecoveryWorkState =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'retrying'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

interface RecoveryWork {
  readonly taskId: string;
  state: RecoveryWorkState;
  attempt: number;
  leaseToken: string | null;
  leaseUntilMs: number | null;
  stage: TaskProvisioningStage;
}

class RecoveryAdmissionStore extends TaskAdmissionStore {
  readonly claims: string[] = [];

  constructor(
    private readonly clock: RecoveryClock,
    readonly rows: RecoveryWork[],
  ) {
    super();
  }

  async claim(request: TaskAdmissionClaimRequest): Promise<TaskAdmissionClaim | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.state === 'accepted' ||
        (candidate.state === 'running' &&
          candidate.leaseUntilMs !== null &&
          candidate.leaseUntilMs <= this.clock.value),
    );
    if (!row) return null;
    if (row.state !== 'accepted' && row.state !== 'running') {
      throw new Error('selected recovery work is not claimable');
    }

    const sourceState = row.state;
    row.state = 'running';
    row.attempt += 1;
    row.leaseToken = request.leaseToken;
    row.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    this.claims.push(row.taskId);
    return {
      taskId: row.taskId,
      leaseToken: request.leaseToken,
      leaseUntil: new Date(row.leaseUntilMs),
      sourceState,
      attempt: row.attempt,
      stage: row.stage,
      causeCode: null,
      resolvedBranch: 'main',
      resourceSnapshot: { diskSizeGb: 12 },
      workspaceMaterializationDeadlineMs: 900_000,
      taskStatus: 'pending',
      taskLifecycleVersion: 0,
    };
  }

  async authorize(request: TaskAdmissionAuthorityRequest): Promise<boolean> {
    return this.owns(request);
  }

  async renew(request: TaskAdmissionRenewRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const row = this.rows.find(({ taskId }) => taskId === request.taskId);
    assert.ok(row);
    row.leaseUntilMs = this.clock.value + request.leaseDurationMs;
    return true;
  }

  async checkpoint(request: TaskAdmissionCheckpointRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const row = this.rows.find(({ taskId }) => taskId === request.taskId);
    assert.ok(row);
    row.stage = request.stage;
    return true;
  }

  async settle(request: TaskAdmissionSettleRequest): Promise<boolean> {
    if (!this.owns(request)) return false;
    const row = this.rows.find(({ taskId }) => taskId === request.taskId);
    assert.ok(row);
    row.state = request.settlement.state;
    row.stage = request.settlement.stage;
    row.leaseToken = null;
    row.leaseUntilMs = null;
    return true;
  }

  private owns(request: TaskAdmissionAuthorityRequest): boolean {
    const row = this.rows.find(({ taskId }) => taskId === request.taskId);
    return Boolean(
      row &&
        row.state === 'running' &&
        row.leaseToken === request.leaseToken &&
        row.leaseUntilMs !== null &&
        row.leaseUntilMs > this.clock.value &&
        request.taskFences.some(
          ({ status, lifecycleVersion }) =>
            status === 'pending' && lifecycleVersion === 0,
        ),
    );
  }
}

function connection(taskId: string): SandboxConnection {
  return {
    taskId,
    baseUrl: `http://sandbox/${taskId}`,
    wsUrl: `ws://sandbox/${taskId}`,
  };
}

function selectedRun(taskId: string): SelectedSandboxRun {
  const runConnection = connection(taskId);
  return {
    taskId,
    providerId: 'startup-test',
    provider: {} as SelectedSandboxRun['provider'],
    capabilities: ['lifecycle.readopt'],
    connection: runConnection,
    terminal: {
      protocol: 'aio-json-v1',
      wsUrl: runConnection.wsUrl,
    },
  };
}

function makeService(args: {
  readonly prisma: PrismaService;
  readonly guardrails?: IGuardrailsService;
  readonly sandbox?: ISandboxReadoption;
  readonly worker?: TaskAdmissionWakePort;
}): TasksService {
  return new TasksService(
    args.prisma,
    args.guardrails,
    undefined,
    args.sandbox,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    args.worker,
  );
}

function noOpGuardrails(overrides: Partial<IGuardrailsService> = {}): IGuardrailsService {
  return {
    async admit() {
      return 'running';
    },
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
    ...overrides,
  };
}

test('bootstrap protects unfinished durable work, restores legacy survivors, reconciles, then starts polling', async () => {
  const events: string[] = [];
  let durableReads = 0;
  let legacyReads = 0;
  const prisma = {
    taskAdmissionWork: {
      async findMany(args: {
        where: unknown;
        orderBy?: unknown;
        select: { taskId: true };
      }) {
        if (args.orderBy) {
          events.push('durable-running-slots');
          assert.deepEqual(args, {
            where: {
              OR: [
                {
                  // Deliberately WITHOUT `parked`: a parked claim released its
                  // slot before the restart, so restoring one would leak
                  // capacity (detach-workspace-clone D9).
                  state: { in: ['accepted', 'queued', 'running', 'retrying'] },
                  task: {
                    OR: [
                      { status: { in: ['running', 'awaiting_input'] } },
                      {
                        sandboxRuns: {
                          some: {
                            status: {
                              in: ['provisioning', 'running', 'deleting'],
                            },
                          },
                        },
                      },
                    ],
                  },
                },
                {
                  state: 'succeeded',
                  task: {
                    status: {
                      in: [
                        'completed',
                        'failed',
                        'cancelled',
                        'agent_failed_to_start',
                      ],
                    },
                    sandboxRuns: {
                      some: {
                        status: {
                          in: ['provisioning', 'running', 'deleting'],
                        },
                        ownerGeneration: { not: null },
                        resourceGeneration: { not: null },
                      },
                    },
                  },
                },
              ],
            },
            orderBy: [{ createdAt: 'asc' }, { taskId: 'asc' }],
            select: { taskId: true },
          });
          // Prisma applies the OR above: the terminal task with a deleting
          // sandbox remains occupied; a terminal task with no live owner does
          // not appear and therefore must not regain a local slot.
          return [
            { taskId: DURABLE_TASK_ID },
            { taskId: TERMINAL_CLEANUP_TASK_ID },
          ];
        }
        events.push(`durable:${++durableReads}`);
        assert.deepEqual(args, {
          where: {
            OR: [
              // Includes `parked` (detach-workspace-clone D9): a parked
              // detached transfer is unfinished durable work and must be
              // protected from legacy re-adoption/reclaim, while its recovery
              // is owned by the claim/processor marker probe.
              {
                state: {
                  in: ['accepted', 'queued', 'running', 'retrying', 'parked'],
                },
              },
              {
                state: 'succeeded',
                task: {
                  status: {
                    in: [
                      'completed',
                      'failed',
                      'cancelled',
                      'agent_failed_to_start',
                    ],
                  },
                  sandboxRuns: {
                    some: {
                      status: {
                        in: ['provisioning', 'running', 'deleting'],
                      },
                      ownerGeneration: { not: null },
                      resourceGeneration: { not: null },
                    },
                  },
                },
              },
            ],
          },
          select: { taskId: true },
        });
        return [
          { taskId: DURABLE_TASK_ID },
          { taskId: TERMINAL_CLEANUP_TASK_ID },
        ];
      },
    },
    task: {
      async findUnique(args: {
        where: { id: string };
        select?: { id?: boolean };
      }) {
        if (args.where.id === LATE_DURABLE_TASK_ID) {
          assert.deepEqual(args.select, { id: true });
          // Simulates another replica committing durable work after this
          // bootstrap process captured its protection snapshots.
          return { id: LATE_DURABLE_TASK_ID };
        }
        if (args.where.id === DELETED_TASK_ID) {
          assert.deepEqual(args.select, { id: true });
          return null;
        }
        assert.equal(args.where.id, LEGACY_TASK_ID);
        legacyReads += 1;
        events.push(`task-read:${legacyReads}`);
        return {
          status: 'running',
          lifecycleVersion: 7,
          deadlineMs: 90_000,
          idleTimeoutMs: 30_000,
          admissionWork: null,
        };
      },
      async findMany(args: {
        where: unknown;
        orderBy?: unknown;
      }) {
        if (args.orderBy) {
          events.push('legacy-reoffer');
          assert.deepEqual(args.orderBy, [
            { createdAt: 'asc' },
            { id: 'asc' },
          ]);
        } else {
          events.push('legacy-reclaim');
          assert.deepEqual(args.where, {
            status: { in: ['running', 'awaiting_input'] },
            OR: [
              { admissionWork: { is: null } },
              {
                admissionWork: {
                  is: {
                    state: {
                      // `parked` counts as unfinished: a parked task is never
                      // reclaimed as a startup orphan.
                      notIn: [
                        'accepted',
                        'queued',
                        'running',
                        'retrying',
                        'parked',
                      ],
                    },
                  },
                },
              },
            ],
          });
        }
        return [];
      },
    },
  } as unknown as PrismaService;

  const reattached: string[] = [];
  const sandbox: ISandboxReadoption = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['lifecycle.readopt'],
    async listReadoptable() {
      events.push('provider-inventory');
      return [DURABLE_TASK_ID, LEGACY_TASK_ID];
    },
    async reattach(taskId) {
      reattached.push(taskId);
      return connection(taskId);
    },
    async getSelectedSandboxRun(taskId) {
      return selectedRun(taskId);
    },
    async reconcileSandboxInventory({ protectedTaskIds, canReap }) {
      events.push('provider-reconcile');
      assert.deepEqual(
        new Set(protectedTaskIds),
        new Set([
          DURABLE_TASK_ID,
          TERMINAL_CLEANUP_TASK_ID,
          LEGACY_TASK_ID,
        ]),
      );
      assert.equal(
        await canReap({
          taskId: LATE_DURABLE_TASK_ID,
          providerSandboxId: 'sandbox-late-durable',
        }),
        false,
        'a task committed after the snapshots is still protected by the live DB check',
      );
      assert.equal(
        await canReap({
          taskId: DELETED_TASK_ID,
          providerSandboxId: 'sandbox-deleted-task',
        }),
        true,
        'only a resource whose logical task no longer exists is reapable',
      );
      return { inspected: 2, reaped: 0 };
    },
  };
  const guardrails = noOpGuardrails({
    async readopt(taskId, _connection, params, _run, options) {
      events.push('legacy-attach');
      assert.equal(taskId, LEGACY_TASK_ID);
      assert.deepEqual(params, {
        deadlineMs: 90_000,
        idleTimeoutMs: 30_000,
      });
      assert.equal(await options?.beforeCommit?.(), true);
      return 'attached';
    },
    async loadPersistedCeiling() {
      events.push('ceiling');
    },
    restoreDurableAdmissionSlot(taskId) {
      events.push(`durable-slot:${taskId}`);
    },
  });
  const worker: TaskAdmissionWakePort = {
    wake() {},
    start() {
      events.push('worker-start');
    },
  };

  await makeService({ prisma, guardrails, sandbox, worker }).onApplicationBootstrap();

  assert.deepEqual(reattached, [LEGACY_TASK_ID]);
  assert.deepEqual(events, [
    'durable:1',
    'provider-inventory',
    'task-read:1',
    'legacy-attach',
    'task-read:2',
    'legacy-reclaim',
    'ceiling',
    'durable:2',
    'provider-reconcile',
    'durable-running-slots',
    `durable-slot:${DURABLE_TASK_ID}`,
    `durable-slot:${TERMINAL_CLEANUP_TASK_ID}`,
    'legacy-reoffer',
    'worker-start',
  ]);
  assert.equal(
    events.includes(`durable-slot:${TERMINAL_WITHOUT_LIVE_SANDBOX_TASK_ID}`),
    false,
  );
});

test('bootstrap releases durable polling only after reconciliation and recovers accepted plus expired running work without a local wake', async () => {
  const events: string[] = [];
  const reconcileEntered = deferred();
  const releaseReconcile = deferred();
  const processedBoth = deferred();
  const clock = new RecoveryClock();
  const scheduler = new RecoveryScheduler(clock);
  const rows: RecoveryWork[] = [
    {
      taskId: ACCEPTED_TASK_ID,
      state: 'accepted',
      attempt: 0,
      leaseToken: null,
      leaseUntilMs: null,
      stage: 'accepted',
    },
    {
      taskId: EXPIRED_RUNNING_TASK_ID,
      state: 'running',
      attempt: 3,
      leaseToken: 'crashed-replica',
      leaseUntilMs: clock.value - 1,
      stage: 'workspace_transfer',
    },
  ];
  const store = new RecoveryAdmissionStore(clock, rows);
  const processed: string[] = [];
  const processor: TaskAdmissionProcessor = {
    async process(context) {
      await context.lease.authorize();
      processed.push(context.claim.taskId);
      events.push(`process:${context.claim.taskId}`);
      if (processed.length === rows.length) processedBoth.resolve();
      return { kind: 'succeeded' };
    },
  };
  const worker = new TaskAdmissionWorker(
    store,
    processor,
    scheduler,
    clock,
    new RecoveryLeaseTokens(),
    {
      ...DEFAULT_TASK_ADMISSION_WORKER_OPTIONS,
      leaseDurationMs: 100,
      renewIntervalMs: 25,
      pollIntervalMs: 50,
      maxInFlight: 2,
    },
  );
  const prisma = {
    taskAdmissionWork: {
      async findMany() {
        events.push('durable-snapshot');
        return rows.map(({ taskId }) => ({ taskId }));
      },
    },
    task: {
      async findMany(args: { orderBy?: unknown }) {
        events.push(args.orderBy ? 'legacy-reoffer' : 'legacy-reclaim');
        return [];
      },
    },
  } as unknown as PrismaService;
  const sandbox: ISandboxReadoption = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => [],
    async reconcileSandboxInventory({ protectedTaskIds }) {
      assert.deepEqual(
        new Set(protectedTaskIds),
        new Set([ACCEPTED_TASK_ID, EXPIRED_RUNNING_TASK_ID]),
      );
      events.push('reconcile-enter');
      reconcileEntered.resolve();
      await releaseReconcile.promise;
      events.push('reconcile-exit');
      return { inspected: 0, reaped: 0 };
    },
  };
  const service = makeService({
    prisma,
    guardrails: noOpGuardrails(),
    sandbox,
    worker,
  });

  const bootstrap = service.onApplicationBootstrap();
  await reconcileEntered.promise;
  assert.equal(store.claims.length, 0);
  assert.equal(processed.length, 0);
  assert.deepEqual(events, [
    'durable-snapshot',
    'legacy-reclaim',
    'durable-snapshot',
    'reconcile-enter',
  ]);

  releaseReconcile.resolve();
  await bootstrap;
  assert.equal(store.claims.length, 0, 'start only arms the 0ms scheduler');
  assert.deepEqual(events, [
    'durable-snapshot',
    'legacy-reclaim',
    'durable-snapshot',
    'reconcile-enter',
    'reconcile-exit',
    'legacy-reoffer',
  ]);

  scheduler.runDue();
  await processedBoth.promise;
  await worker.waitForBackgroundIdle();

  assert.deepEqual(store.claims, [ACCEPTED_TASK_ID, EXPIRED_RUNNING_TASK_ID]);
  assert.deepEqual(new Set(processed), new Set(store.claims));
  assert.deepEqual(
    rows.map(({ state }) => state),
    ['succeeded', 'succeeded'],
  );
  assert.equal(rows[0]?.attempt, 1);
  assert.equal(rows[1]?.attempt, 4);

  await service.beforeApplicationShutdown();
  await service.onApplicationShutdown();
});

test('provider and terminal readoption uncertainty aborts bootstrap instead of reclaiming a running task', async () => {
  let reclaimQueries = 0;
  let workerStarts = 0;
  const prisma = {
    taskAdmissionWork: { async findMany() { return []; } },
    task: {
      async findUnique() {
        return {
          status: 'running',
          lifecycleVersion: 1,
          deadlineMs: null,
          idleTimeoutMs: null,
          admissionWork: null,
        };
      },
      async findMany() {
        reclaimQueries += 1;
        return [];
      },
    },
  } as unknown as PrismaService;
  const sandbox: ISandboxReadoption = {
    getSandboxMode: () => 'workspace-write',
    getProviderCapabilities: () => ['lifecycle.readopt'],
    async listReadoptable() {
      return [LEGACY_TASK_ID];
    },
    async reattach() {
      throw new Error('cloud 503');
    },
    async getSelectedSandboxRun() {
      return null;
    },
  };
  const worker: TaskAdmissionWakePort = {
    wake() {},
    start() {
      workerStarts += 1;
    },
  };

  await assert.rejects(
    makeService({
      prisma,
      guardrails: noOpGuardrails({
        async readopt() {
          return 'attached';
        },
      }),
      sandbox,
      worker,
    }).onApplicationBootstrap(),
    /startup sandbox reattach .* indeterminate/,
  );
  assert.equal(reclaimQueries, 0);
  assert.equal(workerStarts, 0);
});

test('before-shutdown waits for the admission worker barrier and the later hook is idempotent', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stopped = false;
  let stopCalls = 0;
  const service = makeService({
    prisma: {} as PrismaService,
    worker: {
      wake() {},
      async stop() {
        stopCalls += 1;
        await barrier;
        stopped = true;
      },
    },
  });

  const shutdown = service.beforeApplicationShutdown();
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await shutdown;
  assert.equal(stopped, true);
  await service.onApplicationShutdown();
  assert.equal(stopCalls, 1);
});
