import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const {
  MetricsResponseSchema,
  TERMINAL_ATTACH_OUTCOMES,
  TERMINAL_CLEANUP_OUTCOMES,
  TerminalDiagnosticsMetricsSchema,
} = await import(join(here, '..', 'dist', 'metrics.js'));

function terminalDiagnostics(overrides = {}) {
  return {
    observedSince: new Date('2026-07-26T00:00:00.000Z'),
    gauges: { activeViewers: 2, pausedViewers: 1 },
    attachOutcomes: TERMINAL_ATTACH_OUTCOMES.map((outcome, index) => ({
      outcome,
      count: index,
    })),
    flowControl: { pauseCount: 3, resumeCount: 2 },
    cleanupOutcomes: TERMINAL_CLEANUP_OUTCOMES.map((outcome, index) => ({
      outcome,
      count: index,
    })),
    ...overrides,
  };
}

function priorMetricsResponse() {
  return {
    capacity: { ceiling: 1, active: 0, free: 1, queueDepth: 0 },
    occupancy: { slots: [{ slot: 0, busy: false, taskId: null }], queuedTaskIds: [] },
    runnerMinutes: { available: true, minutes: 0 },
    resources: {
      status: 'unavailable',
      sampledAt: null,
      ageMs: null,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    },
  };
}

test('terminal diagnostics expose only closed low-cardinality dimensions', () => {
  const parsed = TerminalDiagnosticsMetricsSchema.parse(terminalDiagnostics());
  assert.deepEqual(
    parsed.attachOutcomes.map(({ outcome }) => outcome),
    TERMINAL_ATTACH_OUTCOMES,
  );
  assert.deepEqual(
    parsed.cleanupOutcomes.map(({ outcome }) => outcome),
    TERMINAL_CLEANUP_OUTCOMES,
  );

  for (const forbidden of [
    { taskId: 'task-secret' },
    { sessionId: 'session-secret' },
    { providerUrl: 'https://provider.invalid/token-secret' },
    { labels: { executionId: 'execution-secret' } },
    { token: 'credential-secret' },
  ]) {
    assert.equal(
      TerminalDiagnosticsMetricsSchema.safeParse({
        ...terminalDiagnostics(),
        ...forbidden,
      }).success,
      false,
    );
  }
});

test('terminal diagnostics reject impossible gauges, unknown or duplicate outcomes, and unsafe counters', () => {
  assert.equal(
    TerminalDiagnosticsMetricsSchema.safeParse(
      terminalDiagnostics({ gauges: { activeViewers: 1, pausedViewers: 2 } }),
    ).success,
    false,
  );
  assert.equal(
    TerminalDiagnosticsMetricsSchema.safeParse(
      terminalDiagnostics({
        attachOutcomes: [{ outcome: 'task-specific-failure', count: 1 }],
      }),
    ).success,
    false,
  );
  assert.equal(
    TerminalDiagnosticsMetricsSchema.safeParse(
      terminalDiagnostics({
        cleanupOutcomes: [
          { outcome: 'confirmed', count: 1 },
          { outcome: 'confirmed', count: 2 },
        ],
      }),
    ).success,
    false,
  );
  assert.equal(
    TerminalDiagnosticsMetricsSchema.safeParse(
      terminalDiagnostics({
        flowControl: {
          pauseCount: Number.MAX_SAFE_INTEGER + 1,
          resumeCount: 0,
        },
      }),
    ).success,
    false,
  );
});

test('terminal diagnostics are additive to the rolling-compatible metrics response', () => {
  assert.equal(MetricsResponseSchema.safeParse(priorMetricsResponse()).success, true);
  const parsed = MetricsResponseSchema.parse({
    ...priorMetricsResponse(),
    terminalDiagnostics: terminalDiagnostics(),
  });
  assert.equal(parsed.terminalDiagnostics.gauges.activeViewers, 2);
});
