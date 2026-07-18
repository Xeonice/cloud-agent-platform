import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProvisioningDiagnosticsMetricsSchema } from '@cap/contracts';

import type { PrismaService } from '../prisma/prisma.service';
import {
  TaskProvisioningDiagnosticsMetricsService,
  type TaskProvisioningDiagnosticsMetricsOptions,
} from './task-provisioning-diagnostics-metrics.service';

const STARTED_AT = new Date('2026-07-18T00:00:00.000Z');
const SAMPLED_AT = new Date('2026-07-18T00:01:00.000Z');
const SECRET_CANARY = 'metrics-secret-canary-never-retain';

class FakeMetricsPrisma {
  activeAttempts = 2;
  oldestStartedAt: Date | null = STARTED_AT;
  cleanupPendingRuns = 3;
  confirmedOrphanRuns = 1;
  fail = false;
  aggregateCalls = 0;
  countCalls = 0;
  aggregateWhere: unknown;
  countWheres: unknown[] = [];
  transactionCalls = 0;
  transactionOptions: unknown[] = [];
  transactionGate: Promise<void> | null = null;

  readonly $transaction = async <T>(
    operation: (transaction: PrismaService) => Promise<T>,
    options?: unknown,
  ): Promise<T> => {
    this.transactionCalls += 1;
    this.transactionOptions.push(options);
    if (this.transactionGate) await this.transactionGate;
    return operation(this as unknown as PrismaService);
  };

  readonly taskProvisioningDiagnosticAttempt = {
    aggregate: async (args: { where: unknown }) => {
      this.aggregateCalls += 1;
      this.aggregateWhere = args.where;
      if (this.fail) throw new Error(SECRET_CANARY);
      return {
        _count: this.activeAttempts,
        _min: { startedAt: this.oldestStartedAt },
      };
    },
  };

  readonly sandboxRun = {
    count: async (args: { where: unknown }) => {
      this.countCalls += 1;
      this.countWheres.push(args.where);
      if (this.fail) throw new Error(SECRET_CANARY);
      const where = args.where as { status?: unknown };
      return where.status === 'deleting'
        ? this.cleanupPendingRuns
        : this.confirmedOrphanRuns;
    },
  };
}

function makeService(
  prisma: FakeMetricsPrisma,
  options: TaskProvisioningDiagnosticsMetricsOptions,
): TaskProvisioningDiagnosticsMetricsService {
  return new TaskProvisioningDiagnosticsMetricsService(
    prisma as unknown as PrismaService,
    options,
  );
}

function observeRepresentativeCounters(
  service: TaskProvisioningDiagnosticsMetricsService,
): void {
  service.observeEvent({
    providerFamily: 'boxlite',
    stage: 'native_execution',
    operation: 'native_exec_settlement',
    outcome: 'failed',
    durationMs: 1_200,
    anomaly: 'missing_exit_code',
  });
  service.observeEvent({
    providerFamily: 'boxlite',
    stage: 'native_execution',
    operation: 'native_exec_attach',
    outcome: 'degraded',
    durationMs: null,
    anomaly: 'attach_degraded',
  });
  service.observeAttemptOutcome({
    providerFamily: 'boxlite',
    outcome: 'failed',
    cause: 'missing_exit_code',
    retryable: true,
    durationMs: 2_000,
  });
  service.observeRetry({
    kind: 'retry',
    providerFamily: 'boxlite',
    stage: 'native_execution',
    cause: 'missing_exit_code',
  });
  service.observeCleanupTransition({
    providerFamily: 'boxlite',
    cleanupState: 'failed',
    cause: 'cleanup_unconfirmed',
  });
}

describe('TaskProvisioningDiagnosticsMetricsService counters', () => {
  it('aggregates closed projections with bounded duration and stable order', () => {
    const service = makeService(new FakeMetricsPrisma(), {
      now: () => SAMPLED_AT.getTime(),
    });
    observeRepresentativeCounters(service);
    service.observeEvent({
      providerFamily: 'aio',
      stage: 'sandbox_start',
      operation: 'sandbox_start',
      outcome: 'succeeded',
      durationMs: 50,
      anomaly: null,
    });
    service.observeAttemptOutcome({
      providerFamily: 'aio',
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      durationMs: null,
    });

    const snapshot = ProvisioningDiagnosticsMetricsSchema.parse(
      service.currentSnapshot(SAMPLED_AT.getTime()),
    );
    assert.deepEqual(
      snapshot.attemptOutcomes.map((entry) => entry.providerFamily),
      ['aio', 'boxlite'],
    );
    assert.deepEqual(
      snapshot.stageOutcomes.map((entry) => entry.operation),
      ['sandbox_start', 'native_exec_attach', 'native_exec_settlement'],
    );
    assert.deepEqual(snapshot.attemptOutcomes[0].duration, {
      count: 0,
      sumMs: 0,
      maxMs: 0,
    });
    assert.deepEqual(snapshot.attemptOutcomes[1].duration, {
      count: 1,
      sumMs: 2_000,
      maxMs: 2_000,
    });
    assert.deepEqual(
      snapshot.anomalies.map((entry) => entry.anomaly),
      ['attach_degraded', 'missing_exit_code'],
    );
    assert.equal(snapshot.retries[0].count, 1);
    assert.equal(snapshot.cleanupOutcomes[0].cleanupState, 'failed');
  });

  it('rejects identifier-bearing, unknown, recovery, and unsafe inputs without throwing', () => {
    const service = makeService(new FakeMetricsPrisma(), {
      now: () => SAMPLED_AT.getTime(),
    });

    const invalid = [
      {
        providerFamily: 'boxlite',
        stage: 'native_execution',
        operation: 'native_exec_settlement',
        outcome: 'failed',
        durationMs: 1,
        anomaly: null,
        taskId: SECRET_CANARY,
      },
      {
        providerFamily: 'private-provider',
        outcome: 'failed',
        cause: 'unknown',
        retryable: true,
        durationMs: null,
      },
      {
        providerFamily: 'boxlite',
        cleanupState: 'failed',
        cause: 'cleanup_failed',
        providerResourceId: SECRET_CANARY,
      },
      {
        kind: 'recovery',
        providerFamily: 'boxlite',
        stage: 'sandbox_start',
        cause: 'provider_unavailable',
      },
    ];

    assert.doesNotThrow(() => {
      service.observeEvent(invalid[0]);
      service.observeAttemptOutcome(invalid[1]);
      service.observeCleanupTransition(invalid[2]);
      service.observeRetry(invalid[3]);
      service.observeEvent(null);
      service.observeAttemptOutcome(new Error(SECRET_CANARY));
    });

    const snapshot = service.currentSnapshot(SAMPLED_AT.getTime());
    assert.equal(snapshot.stageOutcomes.length, 0);
    assert.equal(snapshot.attemptOutcomes.length, 0);
    assert.equal(snapshot.cleanupOutcomes.length, 0);
    assert.equal(snapshot.retries.length, 0);
    assert.equal(JSON.stringify(snapshot).includes(SECRET_CANARY), false);
  });

  it('keeps failed duration, scheduled retry, and succeeding retry duration independent', () => {
    const service = makeService(new FakeMetricsPrisma(), {
      now: () => SAMPLED_AT.getTime(),
    });
    service.observeAttemptOutcome({
      providerFamily: 'cloud-http',
      outcome: 'failed',
      cause: 'tls_network_failed',
      retryable: true,
      durationMs: 2_500,
    });
    service.observeRetry({
      kind: 'retry',
      providerFamily: 'cloud-http',
      stage: 'workspace_transfer',
      cause: 'tls_network_failed',
    });
    service.observeAttemptOutcome({
      providerFamily: 'cloud-http',
      outcome: 'succeeded',
      cause: null,
      retryable: false,
      durationMs: 900,
    });

    const snapshot = service.currentSnapshot(SAMPLED_AT.getTime());
    assert.deepEqual(snapshot.attemptOutcomes, [
      {
        providerFamily: 'cloud-http',
        outcome: 'failed',
        cause: 'tls_network_failed',
        retryable: true,
        count: 1,
        duration: { count: 1, sumMs: 2_500, maxMs: 2_500 },
      },
      {
        providerFamily: 'cloud-http',
        outcome: 'succeeded',
        cause: null,
        retryable: false,
        count: 1,
        duration: { count: 1, sumMs: 900, maxMs: 900 },
      },
    ]);
    assert.deepEqual(snapshot.retries, [
      {
        providerFamily: 'cloud-http',
        stage: 'workspace_transfer',
        cause: 'tls_network_failed',
        count: 1,
      },
    ]);
  });

  it('keeps cleanup history after later success and resets process provenance per instance', () => {
    const first = makeService(new FakeMetricsPrisma(), {
      now: () => SAMPLED_AT.getTime(),
    });
    first.observeCleanupTransition({
      providerFamily: 'cloud-http',
      cleanupState: 'failed',
      cause: 'cleanup_unconfirmed',
    });
    first.observeCleanupTransition({
      providerFamily: 'cloud-http',
      cleanupState: 'succeeded',
      cause: null,
    });

    const restartedAt = SAMPLED_AT.getTime() + 10_000;
    const restarted = makeService(new FakeMetricsPrisma(), {
      now: () => restartedAt,
    });
    const firstSnapshot = first.currentSnapshot(SAMPLED_AT.getTime());
    const restartedSnapshot = restarted.currentSnapshot(restartedAt);

    assert.deepEqual(
      firstSnapshot.cleanupOutcomes.map((entry) => entry.cleanupState),
      ['failed', 'succeeded'],
    );
    assert.equal(restartedSnapshot.cleanupOutcomes.length, 0);
    assert.equal(
      restartedSnapshot.observedSince.getTime(),
      restartedAt,
    );
  });
});

describe('TaskProvisioningDiagnosticsMetricsService durable gauge cache', () => {
  it('does no IO on reads and hydrates exact active, cleanup, and orphan gauges', async () => {
    let now = SAMPLED_AT.getTime();
    const prisma = new FakeMetricsPrisma();
    const service = makeService(prisma, {
      now: () => now,
      staleAfterMs: 30_000,
    });

    const before = service.currentSnapshot(now);
    assert.equal(before.durableGauges.status, 'unavailable');
    assert.equal(prisma.aggregateCalls, 0);
    assert.equal(prisma.countCalls, 0);
    assert.equal(prisma.transactionCalls, 0);

    await service.refreshDurableGauges(now);
    assert.equal(prisma.transactionCalls, 1);
    assert.deepEqual(prisma.transactionOptions, [
      { isolationLevel: 'RepeatableRead' },
    ]);
    const fresh = service.currentSnapshot(now + 1_000);
    assert.deepEqual(prisma.aggregateWhere, { state: 'active' });
    assert.deepEqual(prisma.countWheres, [
      { status: 'deleting' },
      {
        status: { in: ['deleting', 'failed'] },
        cleanupOrphanConfirmedAt: { not: null },
      },
    ]);
    assert.equal(fresh.durableGauges.status, 'available');
    assert.equal(fresh.durableGauges.activeAttempts, 2);
    assert.equal(fresh.durableGauges.oldestActiveAttemptAgeMs, 61_000);
    assert.equal(fresh.durableGauges.cleanupPendingRuns, 3);
    assert.equal(fresh.durableGauges.confirmedOrphanRuns, 1);

    const callsAfterRefresh = prisma.aggregateCalls + prisma.countCalls;
    service.currentSnapshot(now + 2_000);
    assert.equal(prisma.aggregateCalls + prisma.countCalls, callsAfterRefresh);

    now += 31_000;
    assert.equal(service.currentSnapshot(now).durableGauges.status, 'stale');
  });

  it('joins concurrent refresh callers at one transaction completion point', async () => {
    const prisma = new FakeMetricsPrisma();
    let releaseTransaction: (() => void) | undefined;
    prisma.transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const service = makeService(prisma, {
      now: () => SAMPLED_AT.getTime(),
    });

    const first = service.refreshDurableGauges();
    const joined = service.refreshDurableGauges();
    assert.equal(joined, first);
    assert.equal(prisma.transactionCalls, 1);
    assert.equal(prisma.aggregateCalls, 0);

    assert.ok(releaseTransaction);
    releaseTransaction();
    await Promise.all([first, joined]);
    assert.equal(prisma.aggregateCalls, 1);
    assert.equal(prisma.countCalls, 2);

    prisma.transactionGate = null;
    await service.refreshDurableGauges();
    assert.equal(prisma.transactionCalls, 2);
  });

  it('reports first failure unavailable, retains later failures stale, then reconciles', async () => {
    let now = SAMPLED_AT.getTime();
    const prisma = new FakeMetricsPrisma();
    prisma.fail = true;
    const service = makeService(prisma, {
      now: () => now,
      staleAfterMs: 30_000,
    });

    await assert.doesNotReject(() => service.refreshDurableGauges(now));
    assert.equal(
      service.currentSnapshot(now).durableGauges.status,
      'unavailable',
    );

    prisma.fail = false;
    await service.refreshDurableGauges(now);
    assert.equal(
      service.currentSnapshot(now).durableGauges.confirmedOrphanRuns,
      1,
    );

    now += 1_000;
    prisma.fail = true;
    await service.refreshDurableGauges(now);
    const stale = service.currentSnapshot(now);
    assert.equal(stale.durableGauges.status, 'stale');
    assert.equal(stale.durableGauges.confirmedOrphanRuns, 1);

    prisma.fail = false;
    prisma.confirmedOrphanRuns = 0;
    now += 1_000;
    await service.refreshDurableGauges(now);
    const reconciled = service.currentSnapshot(now);
    assert.equal(reconciled.durableGauges.status, 'available');
    assert.equal(reconciled.durableGauges.confirmedOrphanRuns, 0);
  });

  it('degrades an invalid oldest-active timestamp instead of fabricating zero age', async () => {
    const prisma = new FakeMetricsPrisma();
    prisma.oldestStartedAt = new Date(Number.NaN);
    const service = makeService(prisma, {
      now: () => SAMPLED_AT.getTime(),
    });

    await assert.doesNotReject(() => service.refreshDurableGauges());
    assert.equal(
      service.currentSnapshot().durableGauges.status,
      'unavailable',
    );
  });

  it('starts immediate background hydration and stops its interval', async () => {
    const prisma = new FakeMetricsPrisma();
    const service = makeService(prisma, {
      now: () => SAMPLED_AT.getTime(),
      cadenceMs: 60_000,
    });

    service.onApplicationBootstrap();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(prisma.aggregateCalls, 1);
    assert.equal(service.currentSnapshot().durableGauges.status, 'available');
    assert.doesNotThrow(() => service.onModuleDestroy());
  });
});
