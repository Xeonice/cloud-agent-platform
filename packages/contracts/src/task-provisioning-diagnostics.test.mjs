import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE,
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticCompactionSummarySchema,
  TaskProvisioningDiagnosticEventSchema,
  TaskProvisioningDiagnosticsQuerySchema,
  TaskProvisioningDiagnosticsResponseSchema,
} = require(path.join(here, '..', 'dist', 'index.js'));

const ids = {
  taskId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  eventId: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
};

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: ids.eventId,
    idempotencyKey: 'runtime_setup:1:terminal',
    taskId: ids.taskId,
    attemptId: ids.attemptId,
    attempt: 1,
    sequence: 2,
    operationId: ids.operationId,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    stage: 'runtime_setup',
    operation: 'runtime_setup',
    channel: 'primary',
    commandKind: 'runtime_setup',
    observedAt: '2026-07-17T00:00:00.000Z',
    outcome: 'failed',
    durationMs: 1200,
    cause: 'missing_exit_code',
    retryable: false,
    nativeState: 'failed',
    anomaly: 'missing_exit_code',
    exitCode: null,
    ...overrides,
  };
}

function cleanup(overrides = {}) {
  return {
    state: 'succeeded',
    cause: null,
    attemptCount: 1,
    lastAttemptOutcome: 'succeeded',
    observedAt: '2026-07-17T00:00:01.000Z',
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    schemaVersion: 1,
    id: ids.attemptId,
    taskId: ids.taskId,
    attempt: 1,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    state: 'failed',
    stage: 'runtime_setup',
    coverage: 'complete',
    primary: {
      outcome: 'failed',
      cause: 'missing_exit_code',
      retryable: false,
      exitCode: null,
      observedAt: '2026-07-17T00:00:00.000Z',
    },
    cleanup: cleanup(),
    eventCount: 2,
    truncated: false,
    startedAt: '2026-07-16T23:59:59.000Z',
    finishedAt: '2026-07-17T00:00:01.000Z',
    completenessMarkedAt: '2026-07-17T00:00:01.000Z',
    ...overrides,
  };
}

test('versioned diagnostic event and canonical response round-trip', () => {
  const parsedEvent = TaskProvisioningDiagnosticEventSchema.parse(event());
  assert.equal(parsedEvent.exitCode, null);
  assert.equal(parsedEvent.nativeState, 'failed');
  assert.equal(parsedEvent.channel, 'primary');
  assert.equal(parsedEvent.anomaly, 'missing_exit_code');

  const response = TaskProvisioningDiagnosticsResponseSchema.parse({
    schemaVersion: 1,
    taskId: ids.taskId,
    coverage: 'complete',
    admissionState: 'failed',
    attempts: [attempt()],
    events: [event()],
    compaction: null,
    nextCursor: null,
  });
  assert.equal(response.attempts[0].primary.cause, 'missing_exit_code');
});

test('workspace-source kind is an additive, closed, optional event field', () => {
  // add-repo-content-store: evidence written before the field existed must
  // still parse unchanged.
  const legacy = event();
  delete legacy.workspaceSourceKind;
  const parsedLegacy = TaskProvisioningDiagnosticEventSchema.parse(legacy);
  assert.equal(parsedLegacy.workspaceSourceKind, undefined);
  assert.equal(
    TaskProvisioningDiagnosticEventSchema.parse({
      ...event(),
      workspaceSourceKind: null,
    }).workspaceSourceKind,
    null,
  );

  for (const kind of ['volume', 'archive', 'git']) {
    const parsed = TaskProvisioningDiagnosticEventSchema.parse({
      ...event(),
      stage: 'workspace_transfer',
      operation: 'repository_transfer',
      commandKind: 'git_clone',
      workspaceSourceKind: kind,
    });
    assert.equal(parsed.workspaceSourceKind, kind);
  }

  // The vocabulary stays closed: no free-form variant name may be smuggled in.
  for (const invalid of ['mount', 'tarball', 'https://example.test', '']) {
    assert.equal(
      TaskProvisioningDiagnosticEventSchema.safeParse({
        ...event(),
        workspaceSourceKind: invalid,
      }).success,
      false,
      `event must reject workspaceSourceKind ${JSON.stringify(invalid)}`,
    );
  }
});

test('diagnostic boundaries reject every forbidden raw or arbitrary field', () => {
  const forbidden = [
    'command',
    'argv',
    'stdout',
    'stderr',
    'output',
    'prompt',
    'requestBody',
    'responseBody',
    'headers',
    'url',
    'endpoint',
    'credentialPath',
    'token',
    'environment',
    'providerResourceId',
    'providerExecutionId',
    'leaseOwner',
    'stack',
    'message',
    'metadata',
  ];

  for (const field of forbidden) {
    assert.equal(
      TaskProvisioningDiagnosticEventSchema.safeParse({
        ...event(),
        [field]: 'secret-canary',
      }).success,
      false,
      `event must reject ${field}`,
    );
  }
});

test('attempt completeness fails closed while cleanup is pending', () => {
  assert.equal(
    TaskProvisioningDiagnosticAttemptSchema.safeParse(
      attempt({
        coverage: 'partial',
        cleanup: cleanup({
          state: 'pending',
          cause: 'cleanup_unconfirmed',
          lastAttemptOutcome: 'indeterminate',
        }),
        completenessMarkedAt: '2026-07-17T00:00:01.000Z',
      }),
    ).success,
    false,
  );
});

test('attempt state and terminal primary outcome stay semantically paired', () => {
  assert.equal(
    TaskProvisioningDiagnosticAttemptSchema.safeParse(
      attempt({
        state: 'cancelled',
        primary: {
          outcome: 'failed',
          cause: 'command_failed',
          retryable: false,
          exitCode: 1,
          observedAt: '2026-07-17T00:00:00.000Z',
        },
      }),
    ).success,
    false,
  );
});

test('typed compaction summary is ordered and cannot contain pending attempts', () => {
  const summary = {
    compactedAttemptFrom: 1,
    compactedAttemptTo: 4,
    compactedAttemptCount: 4,
    compactedEventCount: 16,
    truncationCount: 1,
    primaryOutcomeCounts: {
      succeeded: 1,
      failed: 2,
      timedOut: 1,
      cancelled: 0,
      degraded: 0,
      indeterminate: 0,
    },
    cleanupStateCounts: {
      notRequired: 0,
      pending: 0,
      succeeded: 3,
      failed: 1,
    },
    compactedAt: '2026-07-17T00:00:00.000Z',
  };
  assert.doesNotThrow(() =>
    TaskProvisioningDiagnosticCompactionSummarySchema.parse(summary),
  );
  assert.equal(
    TaskProvisioningDiagnosticCompactionSummarySchema.safeParse({
      ...summary,
      compactedAttemptFrom: 5,
      compactedAttemptTo: 4,
    }).success,
    false,
  );
  assert.equal(
    TaskProvisioningDiagnosticCompactionSummarySchema.safeParse({
      ...summary,
      cleanupStateCounts: { ...summary.cleanupStateCounts, pending: 1 },
    }).success,
    false,
  );
});

test('pagination and identifiers stay bounded', () => {
  assert.deepEqual(TaskProvisioningDiagnosticsQuerySchema.parse({}), {
    limit: 50,
  });
  assert.equal(
    TaskProvisioningDiagnosticsQuerySchema.safeParse({
      limit: TASK_PROVISIONING_DIAGNOSTIC_MAX_PAGE_SIZE + 1,
    }).success,
    false,
  );
  assert.equal(
    TaskProvisioningDiagnosticEventSchema.safeParse(
      event({ operationId: 'native-provider-secret-or-path' }),
    ).success,
    false,
  );
});
