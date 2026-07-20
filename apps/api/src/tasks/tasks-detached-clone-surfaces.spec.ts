import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_PROVISIONING_PROGRESS_ENABLED_ENV,
  TaskProvisioningSummarySchema,
  isTaskProvisioningProgressEmissionOpen,
  type TaskProvisioningSummary,
  type TaskStatus,
} from '@cap/contracts';
import {
  triageParkedAdmissionMarkers,
} from '../task-admission/fenced-task-admission.processor';
import type { TaskAdmissionCancellationPort } from '../task-admission/task-admission.types';
import type { PrismaService } from '../prisma/prisma.service';
import { IllegalTaskTransitionError } from './task-lifecycle';
import {
  taskProvisioningSummary,
  taskResponseFromRecord,
  type TaskResponseRecord,
} from './task-response';
import {
  TasksService,
  type IGuardrailsService,
  type TaskAdmissionParkedJobCancellation,
} from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';
const UPDATED_AT = new Date('2026-07-20T00:00:00.000Z');

/**
 * The strict shared schema only accepts the progress field once the
 * contracts-progress track has landed (D6: contracts-first). In a partial tree
 * the emission fails closed by design; the populated-shape tests then skip
 * instead of pinning a pre-contracts intermediate state.
 */
const progressFieldSupported = TaskProvisioningSummarySchema.safeParse({
  state: 'running',
  stage: 'workspace_transfer',
  attempt: 1,
  resolvedBranch: null,
  updatedAt: UPDATED_AT,
  progress: { percent: 42 },
}).success;

/** Widened read: compiles before and after the contracts-progress track. */
type SummaryWithProgress = TaskProvisioningSummary & {
  progress?: Partial<
    Record<
      'percent' | 'receivedObjects' | 'totalObjects' | 'receivedBytes' | 'throughput',
      number
    >
  > | null;
};

function readProgress(
  summary: TaskProvisioningSummary | null,
): SummaryWithProgress['progress'] {
  return (summary as SummaryWithProgress | null)?.progress;
}

function admissionWork(
  overrides: Partial<NonNullable<TaskResponseRecord['admissionWork']>> = {},
): NonNullable<TaskResponseRecord['admissionWork']> {
  return {
    state: 'running',
    stage: 'workspace_transfer',
    attempt: 1,
    resolvedBranch: 'main',
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function withProgressGate<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV];
  if (value === undefined) delete process.env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV];
  else process.env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV];
    } else {
      process.env[TASK_PROVISIONING_PROGRESS_ENABLED_ENV] = previous;
    }
  }
}

// ---------------------------------------------------------------------------
// 7.1 / 7.4 — projection shapes fanned out to Console, Public V1, and MCP
// ---------------------------------------------------------------------------

test('progress gate is closed by default and opens only on explicit 1/true', () => {
  assert.equal(isTaskProvisioningProgressEmissionOpen({}), false);
  assert.equal(
    isTaskProvisioningProgressEmissionOpen({
      [TASK_PROVISIONING_PROGRESS_ENABLED_ENV]: '0',
    }),
    false,
  );
  assert.equal(
    isTaskProvisioningProgressEmissionOpen({
      [TASK_PROVISIONING_PROGRESS_ENABLED_ENV]: 'false',
    }),
    false,
  );
  assert.equal(
    isTaskProvisioningProgressEmissionOpen({
      [TASK_PROVISIONING_PROGRESS_ENABLED_ENV]: '1',
    }),
    true,
  );
  assert.equal(
    isTaskProvisioningProgressEmissionOpen({
      [TASK_PROVISIONING_PROGRESS_ENABLED_ENV]: ' TRUE ',
    }),
    true,
  );
});

test('summary omits progress while the capability gate is closed', () => {
  const summary = withProgressGate(undefined, () =>
    taskProvisioningSummary(
      admissionWork({
        progressSnapshot: { percent: 55, receivedBytes: 1024 },
      }),
    ),
  );
  assert.ok(summary);
  assert.equal(summary.state, 'running');
  assert.equal(summary.stage, 'workspace_transfer');
  assert.equal('progress' in (summary as object), false);
});

test('legacy work rows without a progress snapshot still project unchanged', () => {
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(admissionWork()),
  );
  assert.ok(summary);
  assert.deepEqual(
    {
      state: summary.state,
      stage: summary.stage,
      attempt: summary.attempt,
      resolvedBranch: summary.resolvedBranch,
    },
    {
      state: 'running',
      stage: 'workspace_transfer',
      attempt: 1,
      resolvedBranch: 'main',
    },
  );
  assert.ok(!readProgress(summary));
});

test('absent admission work projects a null summary', () => {
  assert.equal(taskProvisioningSummary(null), null);
  assert.equal(taskProvisioningSummary(undefined), null);
});

test('internal parked state projects through the stable running vocabulary', () => {
  const summary = withProgressGate(undefined, () =>
    taskProvisioningSummary(admissionWork({ state: 'parked' })),
  );
  assert.ok(summary);
  assert.equal(summary.state, 'running');
  assert.equal(summary.stage, 'workspace_transfer');
  // Parking never burns attempts; the projected count is the persisted one.
  assert.equal(summary.attempt, 1);
});

test('gate open + parsed snapshot emits the numeric-only progress object', (t) => {
  if (!progressFieldSupported) {
    t.skip('requires the contracts-progress track (strict schema lacks progress)');
    return;
  }
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(
      admissionWork({
        progressSnapshot: {
          percent: 42,
          receivedObjects: 1200,
          totalObjects: 2800,
          receivedBytes: 52_428_800,
          throughput: 1_048_576,
        },
      }),
    ),
  );
  assert.ok(summary);
  assert.deepEqual(readProgress(summary), {
    percent: 42,
    receivedObjects: 1200,
    totalObjects: 2800,
    receivedBytes: 52_428_800,
    throughput: 1_048_576,
  });
});

test('indeterminate phases never report percent as zero', (t) => {
  if (!progressFieldSupported) {
    t.skip('requires the contracts-progress track (strict schema lacks progress)');
    return;
  }
  // Pre-"Receiving objects" phase: bytes may flow while percent is unknown.
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(
      admissionWork({
        progressSnapshot: { receivedBytes: 4096 },
      }),
    ),
  );
  assert.ok(summary);
  const progress = readProgress(summary);
  assert.ok(progress);
  assert.equal(progress.receivedBytes, 4096);
  // Unknown percent is absent — a consumer can distinguish it from real 0%.
  assert.equal(progress.percent, undefined);
  assert.equal('percent' in progress, false);
});

test('progress projection strips non-numeric, negative, and unknown fields', (t) => {
  if (!progressFieldSupported) {
    t.skip('requires the contracts-progress track (strict schema lacks progress)');
    return;
  }
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(
      admissionWork({
        progressSnapshot: {
          percent: 10,
          receivedObjects: 'Receiving objects: 10% (1/10)',
          totalObjects: Number.NaN,
          receivedBytes: -1,
          throughput: Number.POSITIVE_INFINITY,
          remoteUrl: 'https://forge.example/secret',
          command: 'git clone --progress',
        },
      }),
    ),
  );
  assert.ok(summary);
  assert.deepEqual(readProgress(summary), { percent: 10 });
});

test('prisma discrete progress columns project into the same progress object', (t) => {
  if (!progressFieldSupported) {
    t.skip('requires the contracts-progress track (strict schema lacks progress)');
    return;
  }
  // The shape a real admission-work row carries: no assembled snapshot, only
  // the discrete admission-parking 5.1 columns (BigInt for the byte counters).
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(
      admissionWork({
        progressPercent: 42,
        progressReceivedObjects: 1200n,
        progressTotalObjects: 2800n,
        progressReceivedBytes: 52_428_800n,
        progressThroughputBytesPerSecond: 1_048_576n,
      }),
    ),
  );
  assert.ok(summary);
  assert.deepEqual(readProgress(summary), {
    percent: 42,
    receivedObjects: 1200,
    totalObjects: 2800,
    receivedBytes: 52_428_800,
    throughput: 1_048_576,
  });
});

test('all-null discrete progress columns emit no progress object', () => {
  const summary = withProgressGate('1', () =>
    taskProvisioningSummary(
      admissionWork({
        progressPercent: null,
        progressReceivedObjects: null,
        progressTotalObjects: null,
        progressReceivedBytes: null,
        progressThroughputBytesPerSecond: null,
      }),
    ),
  );
  assert.ok(summary);
  assert.ok(!readProgress(summary));
});

test('unusable snapshots emit no progress object at all', () => {
  for (const snapshot of [null, undefined, 'raw text', 42, [], {}, { note: 'x' }]) {
    const summary = withProgressGate('1', () =>
      taskProvisioningSummary(admissionWork({ progressSnapshot: snapshot })),
    );
    assert.ok(summary, `summary must stay projectable for ${String(snapshot)}`);
    assert.ok(!readProgress(summary));
  }
});

test('the single projection point feeds the full task response shape', () => {
  const work = admissionWork({ state: 'parked' });
  const record: TaskResponseRecord = {
    id: TASK_ID,
    repoId: REPO_ID,
    prompt: 'clone a big repo',
    status: 'queued',
    createdAt: UPDATED_AT,
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    admissionWork: work,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  };
  const response = withProgressGate(undefined, () => taskResponseFromRecord(record));
  // Console REST, Public V1, and MCP all read through taskResponseFromRecord;
  // the provisioning summary they observe is exactly taskProvisioningSummary's.
  assert.deepEqual(
    response.provisioning,
    withProgressGate(undefined, () => taskProvisioningSummary(work)),
  );
  assert.equal(response.provisioning?.state, 'running');
});

// ---------------------------------------------------------------------------
// 7.2 / 7.4 — boot marker-probe triage three-way (claim/processor ownership)
// ---------------------------------------------------------------------------

test('exit marker settles even when the wrapper pid still looks alive', () => {
  assert.equal(
    triageParkedAdmissionMarkers({ pidAlive: true, exitMarker: { exitCode: 0 } }),
    'settle_from_exit',
  );
  assert.equal(
    triageParkedAdmissionMarkers({ pidAlive: false, exitMarker: { exitCode: 128 } }),
    'settle_from_exit',
  );
});

test('a provably alive job stays parked', () => {
  assert.equal(
    triageParkedAdmissionMarkers({ pidAlive: true, exitMarker: null }),
    'keep_parked',
  );
});

test('an unprovable job fails the attempt', () => {
  assert.equal(
    triageParkedAdmissionMarkers({ pidAlive: false, exitMarker: null }),
    'fail_attempt',
  );
});

test('progress observation never substitutes for an exit marker', () => {
  // The progress file is an output stream, not a settlement source: neither
  // its presence nor its silence may be read as success.
  assert.equal(
    triageParkedAdmissionMarkers({
      pidAlive: false,
      exitMarker: null,
      progressObserved: true,
    }),
    'fail_attempt',
  );
  assert.equal(
    triageParkedAdmissionMarkers({
      pidAlive: true,
      exitMarker: null,
      progressObserved: false,
    }),
    'keep_parked',
  );
});

// ---------------------------------------------------------------------------
// 7.3 / 7.4 — stop-vs-exit-vs-resume race at the tasks layer
// ---------------------------------------------------------------------------

function taskRow(status: TaskStatus, lifecycleVersion: number) {
  return {
    id: TASK_ID,
    repoId: REPO_ID,
    ownerUserId: null,
    prompt: 'stop a parked transfer',
    status,
    lifecycleVersion,
    failureCode: null as string | null,
    failureAt: null as Date | null,
    failureExitCode: null as number | null,
    createdAt: UPDATED_AT,
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: null as string | null,
    sandboxEnvironmentId: null,
    executionMode: null,
    deliver: null,
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    queuedAdmissionToken: null as string | null,
    runningAdmissionToken: null as string | null,
    admissionWork: admissionWork({ state: 'parked' }),
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  };
}

interface ParkedStopHarness {
  readonly service: TasksService;
  readonly events: string[];
  status(): TaskStatus;
}

function parkedStopHarness(options?: {
  killImplementation?: (taskId: string) => Promise<boolean>;
}): ParkedStopHarness {
  let status: TaskStatus = 'queued';
  let lifecycleVersion = 3;
  const events: string[] = [];
  const prisma = {
    task: {
      findUnique() {
        return Promise.resolve(taskRow(status, lifecycleVersion));
      },
      async updateMany({
        where,
        data,
      }: {
        where: { status: TaskStatus; lifecycleVersion?: number };
        data: { status?: TaskStatus };
      }) {
        if (where.status !== status) return { count: 0 };
        if (
          where.lifecycleVersion !== undefined &&
          where.lifecycleVersion !== lifecycleVersion
        ) {
          return { count: 0 };
        }
        if (data.status) {
          status = data.status;
          lifecycleVersion += 1;
          events.push(`terminal-cas:${data.status}`);
        }
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const guardrails = {
    fenceTerminal() {
      events.push('fence');
    },
    async onTerminal() {
      events.push('teardown');
    },
  } as unknown as IGuardrailsService;
  const cancellation: TaskAdmissionParkedJobCancellation = {
    abortTask(taskId: string) {
      events.push(`abort:${taskId}`);
    },
    killParkedTask(taskId: string) {
      events.push(`kill:${taskId}`);
      return options?.killImplementation?.(taskId) ?? Promise.resolve(true);
    },
  };
  const service = new TasksService(
    prisma,
    guardrails,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    cancellation satisfies TaskAdmissionCancellationPort,
  );
  return { service, events, status: () => status };
}

test('stopping a parked task persists the fence before killing the detached job', async () => {
  const { service, events, status } = parkedStopHarness();
  const stopped = await service.stop(TASK_ID);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(status(), 'cancelled');
  const casIndex = events.indexOf('terminal-cas:cancelled');
  const killIndex = events.indexOf(`kill:${TASK_ID}`);
  const teardownIndex = events.indexOf('teardown');
  assert.ok(casIndex >= 0, 'terminal CAS must run');
  assert.ok(killIndex > casIndex, 'pid-marker kill only after the durable fence');
  assert.ok(teardownIndex > casIndex, 'fence/cleanup chain still runs');
  // No in-process claim run exists while parked; stop must not error for that.
  assert.ok(events.includes(`abort:${TASK_ID}`));
});

test('a failing detached-job kill never replaces the stop outcome', async () => {
  const { service, events, status } = parkedStopHarness({
    killImplementation: () => Promise.reject(new Error('pid marker gone')),
  });
  const stopped = await service.stop(TASK_ID);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(status(), 'cancelled');
  assert.ok(events.includes(`kill:${TASK_ID}`));
  assert.ok(events.includes('teardown'));
});

test('late exit or resume cannot resurrect a stopped task', async () => {
  const { service, events, status } = parkedStopHarness();
  await service.stop(TASK_ID);
  assert.equal(status(), 'cancelled');
  const killsAfterStop = events.filter((event) => event.startsWith('kill:')).length;

  // A resumed claim waking after the stop won: the admission transition is
  // reported superseded and performs no write.
  assert.equal(
    await service.transitionForAdmission(TASK_ID, 'running'),
    'superseded',
  );
  assert.equal(status(), 'cancelled');

  // A late "clone finished" actor trying to move the task forward is rejected
  // by the lifecycle machine rather than resurrecting the task.
  await assert.rejects(
    service.transition(TASK_ID, 'running'),
    IllegalTaskTransitionError,
  );
  assert.equal(status(), 'cancelled');

  // Stop stays idempotent: no second terminal settlement, no second kill.
  const again = await service.stop(TASK_ID);
  assert.equal(again.status, 'cancelled');
  assert.equal(
    events.filter((event) => event.startsWith('kill:')).length,
    killsAfterStop,
  );
  assert.equal(
    events.filter((event) => event === 'terminal-cas:cancelled').length,
    1,
  );
});
