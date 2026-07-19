import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticEventSchema,
} from '@cap/contracts';

import type { PrismaService } from '../prisma/prisma.service';
import { TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT } from './task-provisioning-diagnostic-log';
import type { TaskProvisioningDiagnosticAttemptContext } from './task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsMetricsService } from './task-provisioning-diagnostics-metrics.service';
import { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const OWNER_ID = '10000000-0000-4000-8000-000000000002';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000003';
const UNKNOWN_TASK_ID = '10000000-0000-4000-8000-000000000004';
const OPERATION_ID = '20000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-07-17T02:00:00.000Z');

// The fake implements Prisma's dynamic delegate argument/result bags; keeping
// that test-only adapter open avoids coupling it to generated internal types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

class InMemoryDiagnosticPrisma {
  task = {
    id: TASK_ID,
    ownerUserId: OWNER_ID as string | null,
    status: 'running',
    provisioningDiagnosticSchemaVersion:
      TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    provisioningDiagnosticNextAttempt: 1,
    admissionWork: { state: 'running' },
  };
  attempts: Row[] = [];
  events: Row[] = [];
  compaction: Row | null = null;
  compactionDeleteEnabled = false;
  transactionFailure = false;
  transactionActive = false;
  transactionCommitCount = 0;
  attemptReadFailure = false;
  attemptCreateFailure = false;
  taskLockAvailable = true;
  writeCount = 0;
  taskFindUniqueCount = 0;
  taskFindFirstCount = 0;
  evidenceReadCount = 0;

  readonly taskDelegate = {
    findUnique: async ({ where }: Row) => {
      this.taskFindUniqueCount += 1;
      return where.id === this.task.id ? { ...this.task } : null;
    },
    findFirst: async ({ where }: Row) => {
      this.taskFindFirstCount += 1;
      return where.id === this.task.id &&
        where.ownerUserId === this.task.ownerUserId
        ? { ...this.task }
        : null;
    },
    updateMany: async ({ where, data }: Row) => {
      if (
        where.id !== this.task.id ||
        (where.provisioningDiagnosticNextAttempt !== undefined &&
          where.provisioningDiagnosticNextAttempt !==
            this.task.provisioningDiagnosticNextAttempt)
      ) {
        return { count: 0 };
      }
      this.writeCount += 1;
      this.applyData(this.task, data);
      return { count: 1 };
    },
    update: async ({ where, data }: Row) => {
      assert.equal(where.id, this.task.id);
      this.writeCount += 1;
      this.applyData(this.task, data);
      return { ...this.task };
    },
  };

  readonly attemptDelegate = {
    findFirst: async ({ where, orderBy }: Row) => {
      if (this.attemptReadFailure) {
        throw new Error('secret diagnostic attempt read detail');
      }
      const rows = this.attempts.filter((row) => this.matches(row, where));
      this.sortRows(rows, orderBy);
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where, orderBy, take }: Row) => {
      this.evidenceReadCount += 1;
      const rows = this.attempts
        .filter((row) => this.matches(row, where))
        .map((row) => ({ ...row }));
      this.sortRows(rows, orderBy);
      return take === undefined ? rows : rows.slice(0, take);
    },
    create: async ({ data }: Row) => {
      if (this.attemptCreateFailure) {
        throw new Error('secret diagnostic attempt create detail');
      }
      this.writeCount += 1;
      const row = this.attemptRow(data);
      this.attempts.push(row);
      return { ...row };
    },
    update: async ({ where, data }: Row) => {
      const row = this.attempts.find((candidate) => candidate.id === where.id);
      assert.ok(row);
      this.writeCount += 1;
      this.applyData(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = this.attempts.filter((row) => this.matches(row, where));
      this.writeCount += rows.length;
      rows.forEach((row) => this.applyData(row, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: Row) => {
      assert.equal(this.compactionDeleteEnabled, true);
      const ids = new Set(where.id.in);
      const before = this.attempts.length;
      this.attempts = this.attempts.filter((row) => !ids.has(row.id));
      this.events = this.events.filter((row) => !ids.has(row.attemptId));
      this.writeCount += before - this.attempts.length;
      return { count: before - this.attempts.length };
    },
    count: async ({ where }: Row) =>
      this.attempts.filter((row) => this.matches(row, where)).length,
  };

  readonly eventDelegate = {
    findFirst: async ({ where, orderBy }: Row) => {
      const rows = this.events.filter((row) => this.matches(row, where));
      this.sortRows(rows, orderBy);
      return rows[0] ? { ...rows[0] } : null;
    },
    findMany: async ({ where, orderBy, take }: Row) => {
      this.evidenceReadCount += 1;
      const rows = this.events
        .filter((row) => this.matches(row, where))
        .map((row) => ({
          ...row,
          attempt: {
            attempt:
              this.attempts.find((attempt) => attempt.id === row.attemptId)
                ?.attempt ?? 0,
          },
        }));
      this.sortRows(rows, orderBy);
      return take === undefined ? rows : rows.slice(0, take);
    },
    create: async ({ data }: Row) => {
      this.writeCount += 1;
      this.events.push({ ...data });
      return { ...data };
    },
  };

  readonly compactionDelegate = {
    findUnique: async ({ where }: Row) => {
      this.evidenceReadCount += 1;
      return this.compaction?.taskId === where.taskId
        ? { ...this.compaction }
        : null;
    },
    upsert: async ({ create, update }: Row) => {
      this.writeCount += 1;
      this.compaction = this.compaction ? { ...this.compaction, ...update } : create;
      return { ...this.compaction };
    },
  };

  readonly client = {
    task: this.taskDelegate,
    taskProvisioningDiagnosticAttempt: this.attemptDelegate,
    taskProvisioningDiagnosticEvent: this.eventDelegate,
    taskProvisioningDiagnosticCompaction: this.compactionDelegate,
    $queryRaw: async () => [{ acquired: this.taskLockAvailable }],
    $executeRaw: async () => {
      this.writeCount += 1;
      this.compactionDeleteEnabled = true;
      return 0;
    },
  };

  prisma(): PrismaService {
    return {
      ...this.client,
      $transaction: async (operation: (tx: unknown) => unknown) => {
        if (this.transactionFailure) throw new Error('secret database detail');
        this.transactionActive = true;
        try {
          const result = await operation(this.client);
          this.transactionCommitCount += 1;
          return result;
        } finally {
          this.transactionActive = false;
        }
      },
    } as unknown as PrismaService;
  }

  settledAttempt(attempt: number): Row {
    return this.attemptRow({
      id: `30000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`,
      taskId: TASK_ID,
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      attempt,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      state: 'failed',
      stage: 'runtime_setup',
      coverage: 'partial',
      primaryOutcome: 'failed',
      primaryCause: 'command_failed',
      primaryRetryable: false,
      primaryExitCode: 9,
      primaryObservedAt: NOW,
      cleanupState: 'succeeded',
      cleanupCause: null,
      cleanupAttemptCount: 1,
      cleanupLastAttemptOutcome: 'succeeded',
      cleanupObservedAt: NOW,
      finishedAt: NOW,
    });
  }

  private attemptRow(data: Row): Row {
    return {
      id: data.id,
      taskId: data.taskId,
      schemaVersion: data.schemaVersion,
      attempt: data.attempt,
      admissionMode: data.admissionMode,
      providerFamily: data.providerFamily ?? null,
      state: data.state,
      stage: data.stage,
      coverage: data.coverage,
      primaryOutcome: data.primaryOutcome ?? null,
      primaryCause: data.primaryCause ?? null,
      primaryRetryable: data.primaryRetryable ?? null,
      primaryExitCode: data.primaryExitCode ?? null,
      primaryObservedAt: data.primaryObservedAt ?? null,
      cleanupState: data.cleanupState ?? 'not_required',
      cleanupCause: data.cleanupCause ?? null,
      cleanupAttemptCount: data.cleanupAttemptCount ?? 0,
      cleanupLastAttemptOutcome: data.cleanupLastAttemptOutcome ?? null,
      cleanupObservedAt: data.cleanupObservedAt ?? null,
      eventCount: data.eventCount ?? 0,
      truncated: data.truncated ?? false,
      startedAt: data.startedAt ?? NOW,
      finishedAt: data.finishedAt ?? null,
      completenessMarkedAt: data.completenessMarkedAt ?? null,
    };
  }

  private applyData(row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        typeof value === 'object' && value !== null && 'increment' in value
          ? row[key] + value.increment
          : value;
    }
  }

  private matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected && typeof expected === 'object') {
        if ('not' in expected) return actual !== expected.not;
        if ('in' in expected) return expected.in.includes(actual);
      }
      return actual === expected;
    });
  }

  private sortRows(rows: Row[], orderBy: Row | Row[] | undefined): void {
    const entries = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    rows.sort((left, right) => {
      for (const entry of entries) {
        const [key, direction] = Object.entries(entry)[0]!;
        if (left[key] === right[key]) continue;
        const comparison = left[key] < right[key] ? -1 : 1;
        return direction === 'desc' ? -comparison : comparison;
      }
      return 0;
    });
  }
}

function fullEvent(input: {
  attemptId: string;
  attempt: number;
  sequence: number;
  outcome: 'started' | 'failed';
  eventId: string;
  cause?: 'command_failed' | 'transport_failed';
}) {
  const common = {
    schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    eventId: input.eventId,
    idempotencyKey: `runtime_setup:${input.outcome === 'started' ? 'start' : 'terminal'}`,
    taskId: TASK_ID,
    attemptId: input.attemptId,
    attempt: input.attempt,
    sequence: input.sequence,
    operationId: OPERATION_ID,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    stage: 'runtime_setup',
    operation: 'runtime_setup',
    channel: 'primary',
    commandKind: 'runtime_setup',
    observedAt: NOW,
  } as const;
  return TaskProvisioningDiagnosticEventSchema.parse(
    input.outcome === 'started'
      ? { ...common, outcome: 'started' }
      : {
          ...common,
          outcome: 'failed',
          durationMs: 10,
          cause: input.cause ?? 'command_failed',
          retryable: false,
          httpStatusClass: null,
          nativeState: 'failed',
          anomaly: 'missing_exit_code',
          exitCode: 9,
          timeoutMs: null,
        },
  );
}

interface TestDiagnosticLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface TestDiagnosticMetrics {
  observeEvent(input: unknown): void;
  observeAttemptOutcome(input: unknown): void;
  observeCleanupTransition(input: unknown): void;
  observeRetry(input: unknown): void;
}

function testDiagnosticMetrics(
  overrides: Partial<TestDiagnosticMetrics>,
): TaskProvisioningDiagnosticsMetricsService {
  return {
    observeEvent() {},
    observeAttemptOutcome() {},
    observeCleanupTransition() {},
    observeRetry() {},
    ...overrides,
  } as unknown as TaskProvisioningDiagnosticsMetricsService;
}

function replaceDiagnosticLogger(
  service: TaskProvisioningDiagnosticsService,
  overrides: Partial<TestDiagnosticLogger>,
): void {
  Object.assign(service as unknown as { logger: TestDiagnosticLogger }, {
    logger: {
      log() {},
      warn() {},
      ...overrides,
    },
  });
}

async function completeAttempt(
  service: TaskProvisioningDiagnosticsService,
  context: TaskProvisioningDiagnosticAttemptContext,
): Promise<void> {
  const started = fullEvent({
    attemptId: context.attemptId,
    attempt: context.attempt,
    sequence: 1,
    outcome: 'started',
    eventId: '40000000-0000-4000-8000-000000000001',
  });
  const terminal = fullEvent({
    attemptId: context.attemptId,
    attempt: context.attempt,
    sequence: 2,
    outcome: 'failed',
    eventId: '50000000-0000-4000-8000-000000000001',
  });
  assert.equal((await service.appendEvent(context, started)).ok, true);
  assert.equal((await service.appendEvent(context, terminal)).ok, true);
  assert.equal(
    (
      await service.recordPrimary(context, {
        state: 'failed',
        stage: 'runtime_setup',
        primary: {
          outcome: 'failed',
          cause: 'command_failed',
          retryable: false,
          exitCode: 9,
          observedAt: NOW,
        },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await service.recordCleanup(context, {
        state: 'succeeded',
        cause: null,
        attemptCount: 1,
        lastAttemptOutcome: 'succeeded',
        observedAt: NOW,
      })
    ).ok,
    true,
  );
  const completed = await service.markComplete(context);
  assert.equal(completed.ok, true);
  assert.equal(completed.ok && completed.value.coverage, 'complete');
}

describe('TaskProvisioningDiagnosticsService', () => {
  it('allocates only the task-local attempt number fenced by durable admission', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.task.provisioningDiagnosticNextAttempt = 4;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 4,
    });

    assert.equal(opened.ok, true);
    assert.equal(opened.ok && opened.value.attempt, 4);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 5);
    assert.equal(db.attempts.length, 1);
    assert.equal(db.attempts[0]?.attempt, 4);
  });

  it('resumes active, terminal-partial, and terminal-complete attempts without mutating the ledger', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const active = db.settledAttempt(1);
    Object.assign(active, {
      providerFamily: null,
      state: 'active',
      stage: 'provider_selection',
      coverage: 'partial',
      primaryOutcome: null,
      primaryCause: null,
      primaryRetryable: null,
      primaryExitCode: null,
      primaryObservedAt: null,
      cleanupState: 'not_required',
      cleanupCause: null,
      cleanupAttemptCount: 0,
      cleanupLastAttemptOutcome: null,
      cleanupObservedAt: null,
      eventCount: 0,
      finishedAt: null,
      completenessMarkedAt: null,
    });
    const terminalPartial = db.settledAttempt(2);
    Object.assign(terminalPartial, { eventCount: 2 });
    const terminalComplete = db.settledAttempt(3);
    Object.assign(terminalComplete, {
      admissionMode: 'legacy',
      providerFamily: 'cloud-http',
      coverage: 'complete',
      eventCount: 4,
      completenessMarkedAt: NOW,
    });
    db.attempts = [active, terminalPartial, terminalComplete];
    db.task.provisioningDiagnosticNextAttempt = 4;
    const rowsBefore = db.attempts.map((row) => ({ ...row }));
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const cases = [
      {
        admissionMode: 'durable' as const,
        attempt: 1,
        attemptId: active.id,
        state: 'active',
        providerFamily: null,
        initialSequence: 0,
        primaryPersisted: false,
        cleanup: {
          state: 'not_required',
          cause: null,
          attemptCount: 0,
          lastAttemptOutcome: null,
          observedAt: null,
        },
      },
      {
        admissionMode: 'durable' as const,
        attempt: 2,
        attemptId: terminalPartial.id,
        state: 'failed',
        providerFamily: 'boxlite',
        initialSequence: 2,
        primaryPersisted: true,
        cleanup: {
          state: 'succeeded',
          cause: null,
          attemptCount: 1,
          lastAttemptOutcome: 'succeeded',
          observedAt: NOW,
        },
      },
      {
        admissionMode: 'legacy' as const,
        attempt: 3,
        attemptId: terminalComplete.id,
        state: 'failed',
        providerFamily: 'cloud-http',
        initialSequence: 4,
        primaryPersisted: true,
        cleanup: {
          state: 'succeeded',
          cause: null,
          attemptCount: 1,
          lastAttemptOutcome: 'succeeded',
          observedAt: NOW,
        },
      },
    ];
    for (const expected of cases) {
      const resumed = await service.resumeAttempt({
        taskId: TASK_ID,
        admissionMode: expected.admissionMode,
        attempt: expected.attempt,
      });
      assert.deepEqual(resumed, {
        ok: true,
        value: {
          context: {
            taskId: TASK_ID,
            attemptId: expected.attemptId,
            attempt: expected.attempt,
            admissionMode: expected.admissionMode,
          },
          state: expected.state,
          providerFamily: expected.providerFamily,
          initialSequence: expected.initialSequence,
          primaryPersisted: expected.primaryPersisted,
          cleanup: expected.cleanup,
        },
      });
    }

    assert.equal(db.task.provisioningDiagnosticNextAttempt, 4);
    assert.equal(db.writeCount, 0);
    assert.deepEqual(db.attempts, rowsBefore);
    assert.equal(db.events.length, 0);
    assert.equal(db.compaction, null);
  });

  it('rejects invalid or absent resume coordinates without creating evidence', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.attempts = [db.settledAttempt(1)];
    db.task.provisioningDiagnosticNextAttempt = 2;
    const rowsBefore = db.attempts.map((row) => ({ ...row }));
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const invalidInputs = [
      { taskId: 'not-a-task-id', admissionMode: 'durable', attempt: 1 },
      { taskId: TASK_ID, admissionMode: 'other', attempt: 1 },
      { taskId: TASK_ID, admissionMode: 'durable', attempt: 0 },
      {
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 1,
        unexpected: true,
      },
    ];
    for (const input of invalidInputs) {
      assert.deepEqual(await service.resumeAttempt(input as never), {
        ok: false,
        code: 'invalid_evidence',
        safeCause: 'coordination_failed',
      });
    }

    for (const input of [
      { taskId: TASK_ID, admissionMode: 'durable' as const, attempt: 99 },
      { taskId: TASK_ID, admissionMode: 'legacy' as const, attempt: 1 },
    ]) {
      assert.deepEqual(await service.resumeAttempt(input), {
        ok: false,
        code: 'attempt_not_found',
        safeCause: 'coordination_failed',
      });
    }

    assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);
    assert.equal(db.writeCount, 0);
    assert.deepEqual(db.attempts, rowsBefore);
  });

  it('fails resume safely for malformed retained data or a storage read failure', async () => {
    for (const malformed of [
      { providerFamily: 'provider-private' },
      { state: 'unknown' },
      { eventCount: -1 },
    ]) {
      const db = new InMemoryDiagnosticPrisma();
      const row = db.settledAttempt(1);
      Object.assign(row, malformed);
      db.attempts = [row];
      db.task.provisioningDiagnosticNextAttempt = 2;
      const rowsBefore = db.attempts.map((attempt) => ({ ...attempt }));
      const service = new TaskProvisioningDiagnosticsService(db.prisma());

      assert.deepEqual(
        await service.resumeAttempt({
          taskId: TASK_ID,
          admissionMode: 'durable',
          attempt: 1,
        }),
        {
          ok: false,
          code: 'diagnostic_write_failed',
          safeCause: 'diagnostic_write_failed',
        },
      );
      assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);
      assert.equal(db.writeCount, 0);
      assert.deepEqual(db.attempts, rowsBefore);
    }

    const db = new InMemoryDiagnosticPrisma();
    db.attemptReadFailure = true;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    assert.deepEqual(
      await service.resumeAttempt({
        taskId: TASK_ID,
        admissionMode: 'durable',
        attempt: 1,
      }),
      {
        ok: false,
        code: 'diagnostic_write_failed',
        safeCause: 'diagnostic_write_failed',
      },
    );
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 1);
    assert.equal(db.writeCount, 0);
    assert.equal(db.attempts.length, 0);
  });

  it('rejects a stale expected attempt before interrupting or writing any evidence', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const active = db.settledAttempt(1);
    Object.assign(active, {
      state: 'active',
      primaryOutcome: null,
      primaryCause: null,
      primaryRetryable: null,
      primaryObservedAt: null,
      finishedAt: null,
    });
    db.attempts = [active];
    db.task.provisioningDiagnosticNextAttempt = 2;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 1,
      activeDisposition: 'interrupt',
    });

    assert.deepEqual(opened, {
      ok: false,
      code: 'attempt_number_conflict',
      safeCause: 'coordination_failed',
    });
    assert.equal(db.writeCount, 0);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);
    assert.equal(db.attempts.length, 1);
    assert.equal(db.attempts[0]?.state, 'active');
  });

  it('allows a future durable claim to jump monotonically while honoring the old active disposition', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const active = db.settledAttempt(1);
    Object.assign(active, {
      state: 'active',
      stage: 'provider_selection',
      coverage: 'partial',
      primaryOutcome: null,
      primaryCause: null,
      primaryRetryable: null,
      primaryExitCode: null,
      primaryObservedAt: null,
      cleanupState: 'not_required',
      cleanupCause: null,
      cleanupAttemptCount: 0,
      cleanupLastAttemptOutcome: null,
      cleanupObservedAt: null,
      eventCount: 0,
      finishedAt: null,
      completenessMarkedAt: null,
    });
    db.attempts = [active];
    db.task.provisioningDiagnosticNextAttempt = 2;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    assert.deepEqual(
      await service.beginAttempt({
        taskId: TASK_ID,
        admissionMode: 'durable',
        expectedAttempt: 4,
      }),
      {
        ok: false,
        code: 'active_attempt_conflict',
        safeCause: 'coordination_failed',
      },
    );
    assert.equal(db.writeCount, 0);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);
    assert.equal(db.attempts[0]?.state, 'active');

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 4,
      activeDisposition: 'interrupt',
    });

    assert.equal(opened.ok, true);
    assert.equal(opened.ok && opened.value.attempt, 4);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 5);
    assert.deepEqual(
      db.attempts.map((attempt) => attempt.attempt),
      [1, 4],
    );
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 2), false);
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 3), false);
    assert.deepEqual(
      {
        state: db.attempts[0]?.state,
        coverage: db.attempts[0]?.coverage,
        primaryOutcome: db.attempts[0]?.primaryOutcome,
        primaryCause: db.attempts[0]?.primaryCause,
        completenessMarkedAt: db.attempts[0]?.completenessMarkedAt,
      },
      {
        state: 'interrupted',
        coverage: 'partial',
        primaryOutcome: 'indeterminate',
        primaryCause: 'settlement_unknown',
        completenessMarkedAt: null,
      },
    );
    assert.deepEqual(
      {
        state: db.attempts[1]?.state,
        coverage: db.attempts[1]?.coverage,
        eventCount: db.attempts[1]?.eventCount,
        completenessMarkedAt: db.attempts[1]?.completenessMarkedAt,
      },
      {
        state: 'active',
        coverage: 'partial',
        eventCount: 0,
        completenessMarkedAt: null,
      },
    );
  });

  it('keeps overall coverage partial when a future claim leaves an unrepresented attempt gap', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 3,
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    await completeAttempt(service, opened.value);

    const projection = await service.readTaskDiagnostics(TASK_ID);

    assert.equal(db.task.provisioningDiagnosticNextAttempt, 4);
    assert.deepEqual(
      db.attempts.map((attempt) => attempt.attempt),
      [3],
    );
    assert.equal(projection.ok, true);
    assert.equal(projection.ok && projection.value.attempts[0]?.coverage, 'complete');
    assert.equal(projection.ok && projection.value.coverage, 'partial');
  });

  it('reads owner diagnostics through one combined task ownership predicate', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const projection = await service.readOwnedTaskDiagnostics(
      OWNER_ID,
      TASK_ID,
    );

    assert.equal(projection.ok, true);
    assert.equal(projection.ok && projection.value.taskId, TASK_ID);
    assert.equal(db.taskFindFirstCount, 1);
    assert.equal(db.taskFindUniqueCount, 0);
    assert.ok(db.evidenceReadCount > 0);
  });

  it('makes cross-owner, ownerless, and unknown tasks identical before evidence reads', async () => {
    const cases = [
      {
        name: 'cross-owner',
        ownerUserId: OTHER_OWNER_ID,
        taskId: TASK_ID,
        taskOwnerUserId: OWNER_ID,
      },
      {
        name: 'ownerless',
        ownerUserId: OWNER_ID,
        taskId: TASK_ID,
        taskOwnerUserId: null,
      },
      {
        name: 'unknown',
        ownerUserId: OWNER_ID,
        taskId: UNKNOWN_TASK_ID,
        taskOwnerUserId: OWNER_ID,
      },
    ] as const;

    for (const testCase of cases) {
      const db = new InMemoryDiagnosticPrisma();
      db.task.ownerUserId = testCase.taskOwnerUserId;
      const service = new TaskProvisioningDiagnosticsService(db.prisma());

      const projection = await service.readOwnedTaskDiagnostics(
        testCase.ownerUserId,
        testCase.taskId,
      );

      assert.deepEqual(
        projection,
        {
          ok: false,
          code: 'task_not_found',
          safeCause: 'coordination_failed',
        },
        testCase.name,
      );
      assert.equal(db.taskFindFirstCount, 1, testCase.name);
      assert.equal(db.taskFindUniqueCount, 0, testCase.name);
      assert.equal(db.evidenceReadCount, 0, testCase.name);
    }
  });

  it('preserves complete coverage for continuous allocation and degrades counter mismatch or invalid next', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 1,
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    await completeAttempt(service, opened.value);

    const continuous = await service.readTaskDiagnostics(TASK_ID);
    assert.equal(continuous.ok && continuous.value.coverage, 'complete');

    db.task.provisioningDiagnosticNextAttempt = 3;
    const mismatched = await service.readTaskDiagnostics(TASK_ID);
    assert.equal(mismatched.ok && mismatched.value.coverage, 'partial');

    db.task.provisioningDiagnosticNextAttempt = 0;
    const invalid = await service.readTaskDiagnostics(TASK_ID);
    assert.equal(invalid.ok && invalid.value.coverage, 'partial');
  });

  it('fails safely without entering the operation when the task lock is busy', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.taskLockAvailable = false;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 1,
    });

    assert.deepEqual(opened, {
      ok: false,
      code: 'diagnostic_write_failed',
      safeCause: 'diagnostic_write_failed',
    });
    assert.equal(db.writeCount, 0);
    assert.equal(db.task.status, 'running');
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 1);
    assert.equal(db.attempts.length, 0);
  });

  it('keeps the single-process path available for recorders without transactions', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(
      db.client as unknown as PrismaService,
    );

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'legacy',
    });

    assert.equal(opened.ok, true);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);
    assert.equal(db.attempts.length, 1);
  });

  it('allocates monotonically, retains emitter identity, deduplicates and marks complete', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;
    assert.equal(opened.value.attempt, 1);
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 2);

    const replayedAttempt = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      replayAttemptId: opened.value.attemptId,
    });
    assert.deepEqual(replayedAttempt, opened);

    const start = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: 1,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000001',
    });
    const recordedStart = await service.appendEvent(opened.value, start);
    assert.equal(recordedStart.ok && recordedStart.value.replayed, false);
    assert.equal(
      recordedStart.ok && recordedStart.value.event.eventId,
      start.eventId,
    );

    const replayCandidate = {
      ...start,
      eventId: '40000000-0000-4000-8000-000000000002',
      sequence: 2,
      observedAt: new Date(NOW.getTime() + 1_000),
    };
    const replayedStart = await service.appendEvent(
      opened.value,
      replayCandidate,
    );
    assert.equal(replayedStart.ok && replayedStart.value.replayed, true);
    assert.equal(
      replayedStart.ok && replayedStart.value.event.eventId,
      start.eventId,
    );

    const driftedReplay = await service.appendEvent(opened.value, {
      ...replayCandidate,
      channel: 'cleanup',
    });
    assert.equal(driftedReplay.ok, false);
    assert.equal(!driftedReplay.ok && driftedReplay.code, 'immutable_evidence_conflict');

    const terminal = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: 1,
      sequence: 2,
      outcome: 'failed',
      eventId: '50000000-0000-4000-8000-000000000001',
    });
    assert.equal((await service.appendEvent(opened.value, terminal)).ok, true);
    assert.equal(
      (
        await service.recordPrimary(opened.value, {
          state: 'failed',
          stage: 'runtime_setup',
          primary: {
            outcome: 'failed',
            cause: 'command_failed',
            retryable: false,
            exitCode: 9,
            observedAt: NOW,
          },
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await service.recordCleanup(opened.value, {
          state: 'succeeded',
          cause: null,
          attemptCount: 1,
          lastAttemptOutcome: 'succeeded',
          observedAt: NOW,
        })
      ).ok,
      true,
    );
    const complete = await service.markComplete(opened.value);
    assert.equal(complete.ok, true);
    assert.equal(complete.ok && complete.value.coverage, 'complete');
    assert.ok(complete.ok && complete.value.completenessMarkedAt);

    const replayedComplete = await service.markComplete(opened.value);
    assert.deepEqual(replayedComplete, complete);
    const recoveredComplete = await service.upsertPartialAttempt(opened.value);
    assert.deepEqual(recoveredComplete, complete);
  });

  it('mirrors a newly committed canonical event once, survives log rotation, and never mirrors replays', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const logCalls: unknown[][] = [];
    const warnCalls: unknown[][] = [];
    const logObservations: Array<{
      readonly transactionActive: boolean;
      readonly transactionCommitCount: number;
      readonly persistedEventCount: number;
    }> = [];
    replaceDiagnosticLogger(service, {
      log(...args) {
        logCalls.push(args);
        logObservations.push({
          transactionActive: db.transactionActive,
          transactionCommitCount: db.transactionCommitCount,
          persistedEventCount: db.events.length,
        });
      },
      warn(...args) {
        warnCalls.push(args);
      },
    });

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const commitsBeforeAppend = db.transactionCommitCount;
    const started = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000011',
    });

    const recorded = await service.appendEvent(opened.value, started);
    assert.equal(recorded.ok && recorded.value.replayed, false);
    assert.deepEqual(logObservations, [
      {
        transactionActive: false,
        transactionCommitCount: commitsBeforeAppend + 1,
        persistedEventCount: 1,
      },
    ]);
    assert.deepEqual(logCalls, [
      [
        {
          event: TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT,
          schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
          eventId: started.eventId,
          idempotencyKey: started.idempotencyKey,
          taskId: started.taskId,
          attemptId: started.attemptId,
          attempt: started.attempt,
          sequence: started.sequence,
          operationId: started.operationId,
          admissionMode: started.admissionMode,
          providerFamily: started.providerFamily,
          stage: started.stage,
          operation: started.operation,
          channel: started.channel,
          commandKind: started.commandKind,
          observedAt: started.observedAt.toISOString(),
          outcome: started.outcome,
        },
      ],
    ]);

    const idempotentReplay = await service.appendEvent(opened.value, {
      ...started,
      eventId: '40000000-0000-4000-8000-000000000012',
      sequence: 2,
      observedAt: new Date(NOW.getTime() + 1_000),
    });
    assert.equal(idempotentReplay.ok && idempotentReplay.value.replayed, true);
    assert.equal(
      idempotentReplay.ok && idempotentReplay.value.event.eventId,
      started.eventId,
    );
    assert.equal(logCalls.length, 1);

    const logicalReplay = await service.appendEvent(opened.value, {
      ...started,
      eventId: '40000000-0000-4000-8000-000000000013',
      idempotencyKey: 'runtime_setup:logical_start',
      sequence: 2,
      observedAt: new Date(NOW.getTime() + 2_000),
    });
    assert.equal(logicalReplay.ok, false);
    assert.equal(
      !logicalReplay.ok && logicalReplay.code,
      'immutable_evidence_conflict',
    );
    assert.equal(db.events.length, 1);
    assert.equal(logCalls.length, 1);
    assert.deepEqual(warnCalls, []);

    // Model Docker/Loki retention independently from the task-owned ledger:
    // discarding the entire operational-log window cannot discard the durable
    // event or force the read path to infer evidence from log prose.
    logCalls.splice(0, logCalls.length);
    assert.equal(logCalls.length, 0);
    const afterLogRotation = await service.readTaskDiagnostics(TASK_ID);
    assert.equal(afterLogRotation.ok, true);
    assert.equal(
      afterLogRotation.ok && afterLogRotation.value.coverage,
      'partial',
    );
    assert.deepEqual(
      afterLogRotation.ok
        ? afterLogRotation.value.events.map(({ eventId }) => eventId)
        : [],
      [started.eventId],
    );
  });

  it('rejects an event with an unsafe extra field before persistence or logging', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const logCalls: unknown[][] = [];
    const warnCalls: unknown[][] = [];
    replaceDiagnosticLogger(service, {
      log(...args) {
        logCalls.push(args);
      },
      warn(...args) {
        warnCalls.push(args);
      },
    });
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const secretCanary = 'diagnostic-log-invalid-event-secret-canary';
    const started = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000021',
    });

    const rejected = await service.appendEvent(opened.value, {
      ...started,
      providerResourceId: secretCanary,
    });

    assert.deepEqual(rejected, {
      ok: false,
      code: 'invalid_evidence',
      safeCause: 'coordination_failed',
    });
    assert.equal(db.events.length, 0);
    assert.deepEqual(logCalls, []);
    assert.deepEqual(warnCalls, []);
    assert.equal(
      JSON.stringify({ logCalls, warnCalls }).includes(secretCanary),
      false,
    );
  });

  it('keeps a committed event successful when the structured logger throws', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const logCalls: unknown[][] = [];
    const warnCalls: unknown[][] = [];
    const secretCanary = 'diagnostic-log-sink-failure-secret-canary';
    replaceDiagnosticLogger(service, {
      log(...args) {
        logCalls.push(args);
        throw new Error(secretCanary);
      },
      warn(...args) {
        warnCalls.push(args);
      },
    });
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const started = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000031',
    });

    const recorded = await service.appendEvent(opened.value, started);

    assert.equal(recorded.ok && recorded.value.replayed, false);
    assert.equal(db.events.length, 1);
    assert.equal(db.events[0]?.id, started.eventId);
    assert.equal(logCalls.length, 1);
    assert.deepEqual(warnCalls, []);
    assert.equal(
      JSON.stringify({ logCalls, warnCalls }).includes(secretCanary),
      false,
    );
  });

  it('observes only newly committed identifier-free event, primary, and physical cleanup projections', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const eventCalls: unknown[] = [];
    const attemptCalls: unknown[] = [];
    const cleanupCalls: unknown[] = [];
    const observations: Array<{
      readonly kind: 'event' | 'attempt' | 'cleanup';
      readonly transactionActive: boolean;
      readonly transactionCommitCount: number;
    }> = [];
    const capture = (
      kind: 'event' | 'attempt' | 'cleanup',
      input: unknown,
    ) => {
      observations.push({
        kind,
        transactionActive: db.transactionActive,
        transactionCommitCount: db.transactionCommitCount,
      });
      if (kind === 'event') eventCalls.push(input);
      if (kind === 'attempt') attemptCalls.push(input);
      if (kind === 'cleanup') cleanupCalls.push(input);
    };
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeEvent(input) {
          capture('event', input);
        },
        observeAttemptOutcome(input) {
          capture('attempt', input);
        },
        observeCleanupTransition(input) {
          capture('cleanup', input);
        },
      }),
    );
    replaceDiagnosticLogger(service, {});

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    db.attempts[0]!.startedAt = new Date(NOW.getTime() - 25);

    const started = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000041',
    });
    assert.equal((await service.appendEvent(opened.value, started)).ok, true);
    assert.equal(
      (
        await service.appendEvent(opened.value, {
          ...started,
          eventId: '40000000-0000-4000-8000-000000000042',
          sequence: 2,
          observedAt: new Date(NOW.getTime() + 1),
        })
      ).ok,
      true,
    );

    const terminal = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 2,
      outcome: 'failed',
      eventId: '50000000-0000-4000-8000-000000000041',
    });
    assert.equal((await service.appendEvent(opened.value, terminal)).ok, true);

    const primary = {
      state: 'failed' as const,
      stage: 'runtime_setup' as const,
      primary: {
        outcome: 'failed' as const,
        cause: 'command_failed' as const,
        retryable: false,
        exitCode: 9,
        observedAt: NOW,
      },
    };
    assert.equal((await service.recordPrimary(opened.value, primary)).ok, true);
    assert.equal((await service.recordPrimary(opened.value, primary)).ok, true);

    assert.equal(
      (
        await service.recordCleanup(opened.value, {
          state: 'pending',
          cause: null,
          attemptCount: 0,
          lastAttemptOutcome: null,
          observedAt: null,
        })
      ).ok,
      true,
    );
    const physicalCleanup = {
      state: 'pending' as const,
      cause: 'cleanup_unconfirmed' as const,
      attemptCount: 1,
      lastAttemptOutcome: 'indeterminate' as const,
      observedAt: NOW,
    };
    assert.equal(
      (await service.recordCleanup(opened.value, physicalCleanup)).ok,
      true,
    );
    assert.equal(
      (await service.recordCleanup(opened.value, physicalCleanup)).ok,
      true,
    );
    assert.equal(
      (
        await service.recordCleanup(opened.value, {
          ...physicalCleanup,
          state: 'failed',
          cause: 'cleanup_failed',
        })
      ).ok,
      true,
    );

    assert.deepEqual(eventCalls, [
      {
        providerFamily: 'boxlite',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        outcome: 'started',
        durationMs: null,
        anomaly: null,
      },
      {
        providerFamily: 'boxlite',
        stage: 'runtime_setup',
        operation: 'runtime_setup',
        outcome: 'failed',
        durationMs: 10,
        anomaly: 'missing_exit_code',
      },
    ]);
    assert.deepEqual(attemptCalls, [
      {
        providerFamily: 'boxlite',
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
        durationMs: 25,
      },
    ]);
    assert.deepEqual(cleanupCalls, [
      {
        providerFamily: 'boxlite',
        cleanupState: 'pending',
        cause: 'cleanup_unconfirmed',
      },
    ]);
    assert.deepEqual(
      observations.map((observation) => observation.kind),
      ['event', 'event', 'attempt', 'cleanup'],
    );
    assert.equal(
      observations.every((observation) => !observation.transactionActive),
      true,
    );
    assert.deepEqual(
      observations.map((observation) => observation.transactionCommitCount),
      [2, 4, 5, 8],
    );

    const serializedMetrics = JSON.stringify({
      eventCalls,
      attemptCalls,
      cleanupCalls,
    });
    for (const identifier of [
      TASK_ID,
      opened.value.attemptId,
      OPERATION_ID,
      started.eventId,
    ]) {
      assert.equal(serializedMetrics.includes(identifier), false);
    }
  });

  it('keeps committed recorder results successful when every metrics observer throws', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const secretCanary = 'diagnostic-metrics-sink-secret-canary';
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeEvent() {
          throw new Error(secretCanary);
        },
        observeAttemptOutcome() {
          throw new Error(secretCanary);
        },
        observeCleanupTransition() {
          throw new Error(secretCanary);
        },
        observeRetry() {
          throw new Error(secretCanary);
        },
      }),
    );
    const warnCalls: unknown[][] = [];
    replaceDiagnosticLogger(service, {
      warn(...args) {
        warnCalls.push(args);
      },
    });

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;
    const started = fullEvent({
      attemptId: opened.value.attemptId,
      attempt: opened.value.attempt,
      sequence: 1,
      outcome: 'started',
      eventId: '40000000-0000-4000-8000-000000000051',
    });
    const recorded = await service.appendEvent(opened.value, started);
    const primary = await service.recordPrimary(opened.value, {
      state: 'failed',
      stage: 'runtime_setup',
      primary: {
        outcome: 'failed',
        cause: 'command_failed',
        retryable: false,
        exitCode: 9,
        observedAt: NOW,
      },
    });
    const cleanup = await service.recordCleanup(opened.value, {
      state: 'pending',
      cause: 'cleanup_unconfirmed',
      attemptCount: 1,
      lastAttemptOutcome: 'indeterminate',
      observedAt: NOW,
    });

    assert.equal(recorded.ok, true);
    assert.equal(primary.ok, true);
    assert.equal(cleanup.ok, true);
    assert.equal(db.events.length, 1);
    assert.equal(db.attempts[0]?.primaryOutcome, 'failed');
    assert.equal(db.attempts[0]?.cleanupAttemptCount, 1);
    assert.deepEqual(warnCalls, []);
  });

  it('observes one committed retry from the prior validated provider and retryable primary evidence', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const prior = db.settledAttempt(1);
    Object.assign(prior, {
      providerFamily: 'boxlite',
      stage: 'workspace_transfer',
      primaryCause: 'tls_network_failed',
      primaryRetryable: true,
    });
    db.attempts = [prior];
    db.task.provisioningDiagnosticNextAttempt = 2;
    const retryCalls: unknown[] = [];
    const observations: Array<{
      readonly transactionActive: boolean;
      readonly transactionCommitCount: number;
    }> = [];
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeRetry(input) {
          retryCalls.push(input);
          observations.push({
            transactionActive: db.transactionActive,
            transactionCommitCount: db.transactionCommitCount,
          });
        },
      }),
    );
    replaceDiagnosticLogger(service, {});

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 2,
      activeDisposition: 'interrupt',
      retry: {
        stage: 'sandbox_creation',
        cause: 'transport_failed',
      },
    });

    assert.ok(opened.ok);
    if (!opened.ok) return;
    assert.deepEqual(retryCalls, [
      {
        kind: 'retry',
        providerFamily: 'boxlite',
        stage: 'workspace_transfer',
        cause: 'tls_network_failed',
      },
    ]);
    assert.deepEqual(observations, [
      { transactionActive: false, transactionCommitCount: 1 },
    ]);
    assert.equal(JSON.stringify(retryCalls).includes(TASK_ID), false);
    assert.equal(JSON.stringify(retryCalls).includes(opened.value.attemptId), false);

    const replay = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      replayAttemptId: opened.value.attemptId,
    });
    assert.deepEqual(replay, opened);
    assert.equal(retryCalls.length, 1, 'an attempt replay is not another retry');
  });

  it('falls back to admission-proven retry evidence when the prior attempt is unavailable', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.task.provisioningDiagnosticNextAttempt = 2;
    const retryCalls: unknown[] = [];
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeRetry(input) {
          retryCalls.push(input);
        },
      }),
    );
    replaceDiagnosticLogger(service, {});

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 2,
      activeDisposition: 'interrupt',
      retry: {
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    });

    assert.ok(opened.ok);
    assert.deepEqual(retryCalls, [
      {
        kind: 'retry',
        providerFamily: 'unknown',
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    ]);
  });

  it('observes a committed interrupted attempt even when opening the replacement returns a business failure', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const blockingOldest = db.settledAttempt(1);
    Object.assign(blockingOldest, {
      cleanupState: 'pending',
      cleanupCause: 'cleanup_unconfirmed',
      cleanupAttemptCount: 1,
      cleanupLastAttemptOutcome: 'indeterminate',
      cleanupObservedAt: NOW,
    });
    const active = db.settledAttempt(8);
    Object.assign(active, {
      providerFamily: null,
      state: 'active',
      stage: 'provider_selection',
      coverage: 'partial',
      primaryOutcome: null,
      primaryCause: null,
      primaryRetryable: null,
      primaryExitCode: null,
      primaryObservedAt: null,
      cleanupState: 'not_required',
      cleanupCause: null,
      cleanupAttemptCount: 0,
      cleanupLastAttemptOutcome: null,
      cleanupObservedAt: null,
      eventCount: 0,
      finishedAt: null,
      completenessMarkedAt: null,
    });
    db.attempts = [
      blockingOldest,
      ...Array.from({ length: 6 }, (_, index) =>
        db.settledAttempt(index + 2),
      ),
      active,
    ];
    db.task.provisioningDiagnosticNextAttempt = 9;
    const attemptCalls: unknown[] = [];
    const retryCalls: unknown[] = [];
    const observations: Array<{
      readonly transactionActive: boolean;
      readonly transactionCommitCount: number;
    }> = [];
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeAttemptOutcome(input) {
          attemptCalls.push(input);
          observations.push({
            transactionActive: db.transactionActive,
            transactionCommitCount: db.transactionCommitCount,
          });
        },
        observeRetry(input) {
          retryCalls.push(input);
        },
      }),
    );
    replaceDiagnosticLogger(service, {});

    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 9,
      activeDisposition: 'interrupt',
      retry: {
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    });

    assert.deepEqual(opened, {
      ok: false,
      code: 'attempt_limit_reached',
      safeCause: 'coordination_failed',
    });
    assert.equal(db.transactionCommitCount, 1);
    assert.equal(db.attempts.length, 8);
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 9), false);
    assert.equal(db.attempts.at(-1)?.state, 'interrupted');
    assert.equal(attemptCalls.length, 1);
    const observation = attemptCalls[0] as {
      readonly providerFamily: unknown;
      readonly outcome: unknown;
      readonly cause: unknown;
      readonly retryable: unknown;
      readonly durationMs: unknown;
    };
    assert.deepEqual(
      {
        providerFamily: observation.providerFamily,
        outcome: observation.outcome,
        cause: observation.cause,
        retryable: observation.retryable,
      },
      {
        providerFamily: 'unknown',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
      },
    );
    assert.equal(
      typeof observation.durationMs === 'number' &&
        Number.isSafeInteger(observation.durationMs) &&
        observation.durationMs >= 0,
      true,
    );
    assert.deepEqual(observations, [
      { transactionActive: false, transactionCommitCount: 1 },
    ]);
    assert.deepEqual(
      retryCalls,
      [],
      'a retry is counted only when its replacement attempt is committed',
    );
    assert.equal(JSON.stringify(attemptCalls).includes(active.id), false);
  });

  it('does not observe an interrupted attempt when a later write rolls the transaction back', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const attemptCalls: unknown[] = [];
    const retryCalls: unknown[] = [];
    const service = new TaskProvisioningDiagnosticsService(
      db.prisma(),
      testDiagnosticMetrics({
        observeAttemptOutcome(input) {
          attemptCalls.push(input);
        },
        observeRetry(input) {
          retryCalls.push(input);
        },
      }),
    );
    replaceDiagnosticLogger(service, {});
    const active = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(active.ok);
    if (!active.ok) return;
    db.attemptCreateFailure = true;

    const replacement = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
      expectedAttempt: 2,
      activeDisposition: 'interrupt',
      retry: {
        stage: 'sandbox_creation',
        cause: 'tls_network_failed',
      },
    });

    assert.deepEqual(replacement, {
      ok: false,
      code: 'diagnostic_write_failed',
      safeCause: 'diagnostic_write_failed',
    });
    assert.equal(db.transactionCommitCount, 1);
    assert.deepEqual(attemptCalls, []);
    assert.deepEqual(retryCalls, []);
  });

  it('partial recovery cannot create a second active attempt', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);

    const conflicting = await service.upsertPartialAttempt({
      taskId: TASK_ID,
      attemptId: '60000000-0000-4000-8000-000000000002',
      attempt: 2,
      admissionMode: 'durable',
    });
    assert.equal(conflicting.ok, false);
    assert.equal(
      !conflicting.ok && conflicting.code,
      'active_attempt_conflict',
    );
    assert.equal(db.attempts.length, 1);
  });

  it('keeps cleanup monotonic while allowing pending evidence to become authoritatively failed', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const initial = await service.recordCleanup(opened.value, {
      state: 'pending',
      cause: null,
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    });
    assert.equal(initial.ok, true);
    const changedSameCount = await service.recordCleanup(opened.value, {
      state: 'pending',
      cause: 'cleanup_unconfirmed',
      attemptCount: 0,
      lastAttemptOutcome: null,
      observedAt: null,
    });
    assert.equal(changedSameCount.ok, false);

    const firstPhysicalAttempt = await service.recordCleanup(opened.value, {
      state: 'pending',
      cause: 'cleanup_unconfirmed',
      attemptCount: 1,
      lastAttemptOutcome: 'indeterminate',
      observedAt: NOW,
    });
    assert.equal(firstPhysicalAttempt.ok, true);

    const changedOutcome = await service.recordCleanup(opened.value, {
      state: 'failed',
      cause: 'cleanup_failed',
      attemptCount: 1,
      lastAttemptOutcome: 'failed',
      observedAt: NOW,
    });
    assert.equal(changedOutcome.ok, false);
    const changedObservation = await service.recordCleanup(opened.value, {
      state: 'failed',
      cause: 'cleanup_failed',
      attemptCount: 1,
      lastAttemptOutcome: 'indeterminate',
      observedAt: new Date(NOW.getTime() + 1),
    });
    assert.equal(changedObservation.ok, false);

    const terminal = await service.recordCleanup(opened.value, {
      state: 'failed',
      cause: 'cleanup_failed',
      attemptCount: 1,
      lastAttemptOutcome: 'indeterminate',
      observedAt: NOW,
    });
    assert.equal(terminal.ok, true);
    assert.equal(terminal.ok && terminal.value.cleanup.state, 'failed');
    assert.equal(
      terminal.ok && terminal.value.cleanup.lastAttemptOutcome,
      'indeterminate',
    );
    assert.equal(
      terminal.ok && terminal.value.cleanup.observedAt?.getTime(),
      NOW.getTime(),
    );
  });

  it('allows a pending successful cleanup observation to terminalize at the same count', async () => {
    const db = new InMemoryDiagnosticPrisma();
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const opened = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.ok(opened.ok);
    if (!opened.ok) return;

    const pending = await service.recordCleanup(opened.value, {
      state: 'pending',
      cause: 'cleanup_unconfirmed',
      attemptCount: 1,
      lastAttemptOutcome: 'succeeded',
      observedAt: NOW,
    });
    assert.equal(pending.ok, true);

    const succeededCleanup = {
      state: 'succeeded' as const,
      cause: null,
      attemptCount: 1,
      lastAttemptOutcome: 'succeeded' as const,
      observedAt: NOW,
    };
    const terminal = await service.recordCleanup(
      opened.value,
      succeededCleanup,
    );
    assert.equal(terminal.ok, true);
    assert.equal(terminal.ok && terminal.value.cleanup.state, 'succeeded');

    const replay = await service.recordCleanup(opened.value, succeededCleanup);
    assert.deepEqual(replay, terminal);
  });

  it('compacts only before a ninth attempt and enables the transaction-local delete guard', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.attempts = Array.from({ length: 8 }, (_, index) =>
      db.settledAttempt(index + 1),
    );
    db.task.provisioningDiagnosticNextAttempt = 9;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());

    const standalone = await service.compactTask(TASK_ID);
    assert.deepEqual(standalone, { ok: true, value: 0 });
    assert.equal(db.attempts.length, 8);
    assert.equal(db.compactionDeleteEnabled, false);

    const ninth = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.equal(ninth.ok, true);
    assert.equal(db.attempts.length, 8);
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 1), false);
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 8), true);
    assert.equal(db.attempts.some((attempt) => attempt.attempt === 9), true);
    assert.equal(db.compactionDeleteEnabled, true);
    assert.equal(db.compaction?.compactedAttemptCount, 1);
    assert.equal(db.compaction?.primaryFailedCount, 1);
    assert.equal(db.compaction?.cleanupSucceededCount, 1);
  });

  it('returns a safe persistence result without leaking or changing admission authority', async () => {
    const db = new InMemoryDiagnosticPrisma();
    db.transactionFailure = true;
    const service = new TaskProvisioningDiagnosticsService(db.prisma());
    const result = await service.beginAttempt({
      taskId: TASK_ID,
      admissionMode: 'durable',
    });
    assert.deepEqual(result, {
      ok: false,
      code: 'diagnostic_write_failed',
      safeCause: 'diagnostic_write_failed',
    });
    assert.equal(db.task.status, 'running');
    assert.equal(db.task.provisioningDiagnosticNextAttempt, 1);
  });
});
