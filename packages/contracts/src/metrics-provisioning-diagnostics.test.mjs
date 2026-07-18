import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  MetricsResponseSchema,
  ProvisioningDiagnosticsMetricsSchema,
} = require(path.join(here, '..', 'dist', 'metrics.js'));

const duration = (overrides = {}) => ({
  count: 1,
  sumMs: 1200,
  maxMs: 1200,
  ...overrides,
});

function metrics(overrides = {}) {
  return {
    observedSince: '2026-07-18T00:00:00.000Z',
    attemptOutcomes: [
      {
        providerFamily: 'boxlite',
        outcome: 'failed',
        cause: 'missing_exit_code',
        retryable: false,
        count: 1,
        duration: duration(),
      },
    ],
    stageOutcomes: [
      {
        providerFamily: 'boxlite',
        stage: 'native_execution',
        operation: 'native_exec_settlement',
        outcome: 'failed',
        count: 1,
        duration: duration(),
      },
    ],
    retries: [
      {
        providerFamily: 'cloud-http',
        stage: 'sandbox_start',
        cause: 'provider_unavailable',
        count: 2,
      },
    ],
    cleanupOutcomes: [
      {
        providerFamily: 'boxlite',
        cleanupState: 'failed',
        cause: 'cleanup_unconfirmed',
        count: 1,
      },
    ],
    anomalies: [
      {
        providerFamily: 'boxlite',
        anomaly: 'missing_exit_code',
        count: 1,
      },
    ],
    durableGauges: {
      status: 'available',
      sampledAt: '2026-07-18T00:01:00.000Z',
      ageMs: 50,
      activeAttempts: 1,
      oldestActiveAttemptAgeMs: 4000,
      cleanupPendingRuns: 2,
      confirmedOrphanRuns: 1,
    },
    ...overrides,
  };
}

function priorMetricsResponse() {
  return {
    capacity: { ceiling: 1, active: 0, free: 1, queueDepth: 0 },
    occupancy: {
      slots: [{ slot: 0, busy: false, taskId: null }],
      queuedTaskIds: [],
    },
    runnerMinutes: { available: false, minutes: null },
    resources: {
      status: 'available',
      sampledAt: '2026-07-18T00:01:00.000Z',
      ageMs: 0,
      hasActiveContainers: false,
      containers: [],
      aggregateCpuPercent: 0,
      aggregateMemoryBytes: 0,
    },
  };
}

test('provisioning diagnostics metrics round-trip with only closed labels', () => {
  const parsed = ProvisioningDiagnosticsMetricsSchema.parse(metrics());

  assert.ok(parsed.observedSince instanceof Date);
  assert.equal(parsed.attemptOutcomes[0].cause, 'missing_exit_code');
  assert.equal(parsed.stageOutcomes[0].duration.sumMs, 1200);
  assert.equal(parsed.durableGauges.status, 'available');
  assert.ok(parsed.durableGauges.sampledAt instanceof Date);
});

test('MetricsResponse keeps the additive block optional for rolling compatibility', () => {
  const prior = MetricsResponseSchema.parse(priorMetricsResponse());
  assert.equal(prior.provisioningDiagnostics, undefined);

  const current = MetricsResponseSchema.parse({
    ...priorMetricsResponse(),
    provisioningDiagnostics: metrics(),
  });
  assert.equal(current.provisioningDiagnostics.attemptOutcomes.length, 1);
});

test('every series is strict and rejects identifier or payload dimensions', () => {
  const forbiddenFields = [
    'taskId',
    'attemptId',
    'operationId',
    'providerId',
    'providerResourceId',
    'providerExecutionId',
    'sandboxId',
    'repository',
    'accountId',
    'url',
    'endpoint',
    'path',
    'commandKind',
    'error',
    'credential',
  ];
  const series = [
    'attemptOutcomes',
    'stageOutcomes',
    'retries',
    'cleanupOutcomes',
    'anomalies',
  ];

  for (const field of forbiddenFields) {
    for (const seriesName of series) {
      const candidate = metrics();
      candidate[seriesName][0][field] = 'secret-canary';
      assert.equal(
        ProvisioningDiagnosticsMetricsSchema.safeParse(candidate).success,
        false,
        `${seriesName} must reject ${field}`,
      );
    }
  }

  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse({
      ...metrics(),
      taskId: '11111111-1111-4111-8111-111111111111',
    }).success,
    false,
  );
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse({
      ...metrics(),
      durableGauges: {
        ...metrics().durableGauges,
        providerResourceId: 'raw-provider-id',
      },
    }).success,
    false,
  );
});

test('all labels remain closed diagnostics vocabularies', () => {
  const invalidLabels = [
    ['attemptOutcomes', 'providerFamily', 'custom-provider'],
    ['attemptOutcomes', 'outcome', 'started'],
    ['attemptOutcomes', 'cause', 'provider-message'],
    ['stageOutcomes', 'stage', 'custom-stage'],
    ['stageOutcomes', 'operation', 'custom-operation'],
    ['cleanupOutcomes', 'cleanupState', 'orphaned'],
    ['anomalies', 'anomaly', 'provider-error'],
  ];

  for (const [seriesName, field, value] of invalidLabels) {
    const candidate = metrics();
    candidate[seriesName][0][field] = value;
    assert.equal(
      ProvisioningDiagnosticsMetricsSchema.safeParse(candidate).success,
      false,
      `${seriesName}.${field} must reject ${value}`,
    );
  }
});

test('all provisioning metric numbers are nonnegative safe integers', () => {
  const invalidNumbers = [-1, 0.5, Number.MAX_SAFE_INTEGER + 1];
  const mutations = [
    (candidate, value) => {
      candidate.attemptOutcomes[0].count = value;
    },
    (candidate, value) => {
      candidate.attemptOutcomes[0].duration.count = value;
    },
    (candidate, value) => {
      candidate.attemptOutcomes[0].duration.sumMs = value;
    },
    (candidate, value) => {
      candidate.attemptOutcomes[0].duration.maxMs = value;
    },
    (candidate, value) => {
      candidate.stageOutcomes[0].count = value;
    },
    (candidate, value) => {
      candidate.retries[0].count = value;
    },
    (candidate, value) => {
      candidate.cleanupOutcomes[0].count = value;
    },
    (candidate, value) => {
      candidate.anomalies[0].count = value;
    },
    (candidate, value) => {
      candidate.durableGauges.ageMs = value;
    },
    (candidate, value) => {
      candidate.durableGauges.activeAttempts = value;
    },
    (candidate, value) => {
      candidate.durableGauges.oldestActiveAttemptAgeMs = value;
    },
    (candidate, value) => {
      candidate.durableGauges.cleanupPendingRuns = value;
    },
    (candidate, value) => {
      candidate.durableGauges.confirmedOrphanRuns = value;
    },
  ];

  for (const invalid of invalidNumbers) {
    for (const mutate of mutations) {
      const candidate = metrics();
      mutate(candidate, invalid);
      assert.equal(
        ProvisioningDiagnosticsMetricsSchema.safeParse(candidate).success,
        false,
        `metric numeric field must reject ${invalid}`,
      );
    }
  }
});

test('duration summaries and active-attempt age are internally honest', () => {
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({
        attemptOutcomes: [
          {
            ...metrics().attemptOutcomes[0],
            duration: duration({ count: 0, sumMs: 1, maxMs: 1 }),
          },
        ],
      }),
    ).success,
    false,
  );
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({
        stageOutcomes: [
          {
            ...metrics().stageOutcomes[0],
            duration: duration({ sumMs: 100, maxMs: 101 }),
          },
        ],
      }),
    ).success,
    false,
  );
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({
        durableGauges: {
          ...metrics().durableGauges,
          activeAttempts: 0,
          oldestActiveAttemptAgeMs: 1,
        },
      }),
    ).success,
    false,
  );
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({ observedSince: null }),
    ).success,
    false,
  );
  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({
        durableGauges: {
          ...metrics().durableGauges,
          sampledAt: null,
        },
      }),
    ).success,
    false,
  );
});

test('unavailable gauges expose unknown values as null while stale gauges retain age', () => {
  const unavailable = ProvisioningDiagnosticsMetricsSchema.parse(
    metrics({
      durableGauges: {
        status: 'unavailable',
        sampledAt: null,
        ageMs: null,
        activeAttempts: null,
        oldestActiveAttemptAgeMs: null,
        cleanupPendingRuns: null,
        confirmedOrphanRuns: null,
      },
    }),
  );
  assert.equal(unavailable.durableGauges.activeAttempts, null);

  const stale = ProvisioningDiagnosticsMetricsSchema.parse(
    metrics({
      durableGauges: {
        ...metrics().durableGauges,
        status: 'stale',
        ageMs: 60_000,
      },
    }),
  );
  assert.equal(stale.durableGauges.status, 'stale');
  assert.equal(stale.durableGauges.ageMs, 60_000);

  assert.equal(
    ProvisioningDiagnosticsMetricsSchema.safeParse(
      metrics({
        durableGauges: {
          status: 'unavailable',
          sampledAt: null,
          ageMs: null,
          activeAttempts: 0,
          oldestActiveAttemptAgeMs: null,
          cleanupPendingRuns: 0,
          confirmedOrphanRuns: 0,
        },
      }),
    ).success,
    false,
  );
});
