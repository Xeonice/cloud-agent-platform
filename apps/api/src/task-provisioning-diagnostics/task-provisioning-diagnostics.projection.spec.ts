import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  TaskProvisioningDiagnosticAttemptSchema,
  TaskProvisioningDiagnosticEventSchema,
  type TaskProvisioningDiagnosticAttempt,
  type TaskProvisioningDiagnosticEvent,
} from '@cap/contracts';

import {
  decodeTaskProvisioningDiagnosticCursor,
  deriveTaskDiagnosticCoverage,
  encodeTaskProvisioningDiagnosticCursor,
  hasCompleteEventInvariants,
} from './task-provisioning-diagnostics.projection';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const START_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const END_EVENT_ID = '55555555-5555-4555-8555-555555555555';
const OBSERVED_AT = new Date('2026-07-17T01:02:03.000Z');

function completedAttempt(
  overrides: Partial<TaskProvisioningDiagnosticAttempt> = {},
): TaskProvisioningDiagnosticAttempt {
  return TaskProvisioningDiagnosticAttemptSchema.parse({
    schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
    id: ATTEMPT_ID,
    taskId: TASK_ID,
    attempt: 1,
    admissionMode: 'durable',
    providerFamily: 'boxlite',
    state: 'failed',
    stage: 'runtime_setup',
    coverage: 'complete',
    primary: {
      outcome: 'failed',
      cause: 'command_failed',
      retryable: false,
      exitCode: 17,
      observedAt: OBSERVED_AT,
    },
    cleanup: {
      state: 'succeeded',
      cause: null,
      attemptCount: 1,
      lastAttemptOutcome: 'succeeded',
      observedAt: OBSERVED_AT,
    },
    eventCount: 2,
    truncated: false,
    startedAt: new Date('2026-07-17T01:02:00.000Z'),
    finishedAt: OBSERVED_AT,
    completenessMarkedAt: new Date('2026-07-17T01:02:04.000Z'),
    ...overrides,
  });
}

function completedEvents(): TaskProvisioningDiagnosticEvent[] {
  return [
    TaskProvisioningDiagnosticEventSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: START_EVENT_ID,
      idempotencyKey: 'runtime_setup:start',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      sequence: 1,
      operationId: OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: new Date('2026-07-17T01:02:01.000Z'),
      outcome: 'started',
    }),
    TaskProvisioningDiagnosticEventSchema.parse({
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: END_EVENT_ID,
      idempotencyKey: 'runtime_setup:terminal',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attempt: 1,
      sequence: 2,
      operationId: OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: OBSERVED_AT,
      outcome: 'failed',
      durationMs: 2_000,
      cause: 'command_failed',
      retryable: false,
      httpStatusClass: null,
      nativeState: 'failed',
      anomaly: 'missing_exit_code',
      exitCode: 17,
      timeoutMs: null,
    }),
  ];
}

describe('task provisioning diagnostics projection', () => {
  it('requires a contiguous start/terminal pair with one stable channel', () => {
    const attempt = completedAttempt();
    const events = completedEvents();
    assert.equal(hasCompleteEventInvariants(attempt, events), true);
    assert.equal(hasCompleteEventInvariants(attempt, events.slice(1)), false);
    assert.equal(
      hasCompleteEventInvariants(attempt, [events[0]!, events[0]!]),
      false,
    );

    const cleanupTerminal = TaskProvisioningDiagnosticEventSchema.parse({
      ...events[1],
      channel: 'cleanup',
    });
    assert.equal(
      hasCompleteEventInvariants(attempt, [events[0]!, cleanupTerminal]),
      false,
    );
    const mismatchedOperation = TaskProvisioningDiagnosticEventSchema.parse({
      ...events[1],
      operation: 'runtime_preflight',
    });
    assert.equal(
      hasCompleteEventInvariants(attempt, [events[0]!, mismatchedOperation]),
      false,
    );
    assert.equal(
      hasCompleteEventInvariants(
        completedAttempt({
          primary: {
            outcome: 'failed',
            cause: 'transport_failed',
            retryable: true,
            exitCode: 17,
            observedAt: OBSERVED_AT,
          },
        }),
        events,
      ),
      false,
    );
  });

  it('derives coverage fail-closed from expectation, explicit proof and compaction', () => {
    const attempt = completedAttempt();
    const eventsByAttempt = new Map([[attempt.id, completedEvents()]]);
    const base = {
      expectedSchemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      taskStatus: 'running',
      admissionState: 'running' as const,
      attempts: [attempt],
      eventsByAttempt,
      hasCompaction: false,
      hasUnsupportedEvidence: false,
    };
    assert.equal(deriveTaskDiagnosticCoverage(base), 'complete');
    assert.equal(
      deriveTaskDiagnosticCoverage({ ...base, hasCompaction: true }),
      'partial',
    );
    assert.equal(
      deriveTaskDiagnosticCoverage({
        ...base,
        attempts: [],
        admissionState: 'queued',
      }),
      'not_started',
    );
    assert.equal(
      deriveTaskDiagnosticCoverage({
        ...base,
        expectedSchemaVersion: null,
        attempts: [],
      }),
      'unavailable',
    );
    assert.equal(
      deriveTaskDiagnosticCoverage({
        ...base,
        attempts: [],
        admissionState: 'failed',
        taskStatus: 'failed',
      }),
      'partial',
    );
  });

  it('round-trips a bounded keyset cursor and rejects malformed input', () => {
    const cursor = encodeTaskProvisioningDiagnosticCursor({
      observedAt: OBSERVED_AT,
      eventId: END_EVENT_ID,
    });
    assert.deepEqual(decodeTaskProvisioningDiagnosticCursor(cursor), {
      observedAt: OBSERVED_AT,
      eventId: END_EVENT_ID,
    });
    assert.equal(decodeTaskProvisioningDiagnosticCursor('not-json'), null);
    assert.equal(decodeTaskProvisioningDiagnosticCursor('x'.repeat(2_049)), null);
  });
});
