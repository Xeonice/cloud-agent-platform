import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsResponseSchema } from '@cap-console/contracts';

import { MetricsService } from './metrics.service';
import { TerminalDiagnosticsMetricsService } from './terminal-diagnostics-metrics.service';

function count(
  entries: readonly { outcome: string; count: number }[],
  outcome: string,
): number {
  return entries.find((entry) => entry.outcome === outcome)?.count ?? -1;
}

test('terminal diagnostics collector maintains bounded gauges and closed counters', () => {
  const metrics = new TerminalDiagnosticsMetricsService();

  metrics.viewerActivated();
  metrics.viewerActivated();
  metrics.viewerPaused();
  metrics.observeAttachOutcome('ready');
  metrics.observeAttachOutcome('viewer_limit');
  metrics.observeAttachOutcome('attach_timeout');
  metrics.observeCleanupOutcome('confirmed');

  let snapshot = metrics.currentSnapshot();
  assert.deepEqual(snapshot.gauges, { activeViewers: 2, pausedViewers: 1 });
  assert.equal(snapshot.flowControl.pauseCount, 1);
  assert.equal(snapshot.flowControl.resumeCount, 0);
  assert.equal(count(snapshot.attachOutcomes, 'ready'), 1);
  assert.equal(count(snapshot.attachOutcomes, 'viewer_limit'), 1);
  assert.equal(count(snapshot.attachOutcomes, 'attach_timeout'), 1);
  assert.equal(count(snapshot.cleanupOutcomes, 'confirmed'), 1);

  metrics.viewerResumed();
  metrics.viewerDeactivated(false);
  metrics.viewerDeactivated(false);
  // Defensive duplicate transitions never make a public gauge negative.
  metrics.viewerResumed();
  metrics.viewerDeactivated(true);
  metrics.observeAttachOutcome({ taskId: 'must-not-be-a-label' });
  metrics.observeCleanupOutcome('provider-specific-cleanup');

  snapshot = metrics.currentSnapshot();
  assert.deepEqual(snapshot.gauges, { activeViewers: 0, pausedViewers: 0 });
  assert.equal(snapshot.flowControl.pauseCount, 1);
  assert.equal(snapshot.flowControl.resumeCount, 2);
  assert.equal(count(snapshot.attachOutcomes, 'ready'), 1);
  assert.equal(count(snapshot.cleanupOutcomes, 'indeterminate'), 0);
  assert.equal(
    /taskId|sessionId|providerUrl|executionId|token/u.test(
      JSON.stringify(snapshot),
    ),
    false,
  );
});

test('metrics aggregation emits terminal diagnostics without changing prior blocks', () => {
  const terminal = new TerminalDiagnosticsMetricsService();
  terminal.viewerActivated();
  terminal.observeAttachOutcome('ready');

  const guardrails = {
    semaphoreProjection: () => ({
      maxConcurrentTasks: 1,
      runningCount: 0,
      queuedCount: 0,
      snapshotRunning: () => [],
      snapshotQueue: () => [],
    }),
    runnerMinuteIntervals: () => [],
  };
  const sampler = {
    currentSnapshot: () => ({
      status: 'unavailable' as const,
      sampledAt: null,
      ageMs: null,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    }),
    taskReading: () => null,
  };

  const response = new MetricsService(
    guardrails as never,
    sampler as never,
    undefined,
    terminal,
  ).build(1_000);
  const parsed = MetricsResponseSchema.parse(response);

  assert.deepEqual(parsed.capacity, {
    ceiling: 1,
    active: 0,
    free: 1,
    queueDepth: 0,
  });
  assert.equal(parsed.terminalDiagnostics?.gauges.activeViewers, 1);
  assert.equal(
    count(parsed.terminalDiagnostics?.attachOutcomes ?? [], 'ready'),
    1,
  );
});
