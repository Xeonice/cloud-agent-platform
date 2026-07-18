import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION } from '@cap/contracts';

import {
  TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT,
  toTaskProvisioningDiagnosticLogRecord,
} from './task-provisioning-diagnostic-log';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const OBSERVED_AT = '2026-07-18T01:02:03.456Z';
const SECRET_CANARY = 'log-canary-secret-never-emit';

const commonEvent = {
  schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
  eventId: EVENT_ID,
  idempotencyKey: 'runtime_setup:terminal',
  taskId: TASK_ID,
  attemptId: ATTEMPT_ID,
  attempt: 2,
  sequence: 8,
  operationId: OPERATION_ID,
  admissionMode: 'durable' as const,
  providerFamily: 'boxlite' as const,
  stage: 'runtime_setup' as const,
  operation: 'runtime_setup' as const,
  channel: 'primary' as const,
  commandKind: 'runtime_setup' as const,
  observedAt: OBSERVED_AT,
};

describe('task provisioning diagnostic structured log projection', () => {
  it('projects an exact frozen started record without terminal facts', () => {
    const record = toTaskProvisioningDiagnosticLogRecord({
      ...commonEvent,
      idempotencyKey: 'runtime_setup:start',
      outcome: 'started',
    });

    assert.deepEqual(record, {
      event: TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT,
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: EVENT_ID,
      idempotencyKey: 'runtime_setup:start',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attempt: 2,
      sequence: 8,
      operationId: OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: OBSERVED_AT,
      outcome: 'started',
    });
    assert.equal(Object.isFrozen(record), true);
    assert.equal('durationMs' in record, false);
    assert.equal('cause' in record, false);
    assert.equal('retryable' in record, false);
    assert.equal('httpStatusClass' in record, false);
    assert.equal('nativeState' in record, false);
    assert.equal('anomaly' in record, false);
    assert.equal('exitCode' in record, false);
    assert.equal('timeoutMs' in record, false);
  });

  it('projects only explicit safe terminal facts and normalizes time', () => {
    const record = toTaskProvisioningDiagnosticLogRecord({
      ...commonEvent,
      observedAt: new Date(OBSERVED_AT),
      outcome: 'failed',
      durationMs: 1_234,
      cause: 'missing_exit_code',
      retryable: false,
      httpStatusClass: null,
      nativeState: 'failed',
      anomaly: 'missing_exit_code',
      exitCode: null,
      timeoutMs: 15_000,
    });

    assert.deepEqual(record, {
      event: TASK_PROVISIONING_DIAGNOSTIC_LOG_EVENT,
      schemaVersion: TASK_PROVISIONING_DIAGNOSTIC_SCHEMA_VERSION,
      eventId: EVENT_ID,
      idempotencyKey: 'runtime_setup:terminal',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      attempt: 2,
      sequence: 8,
      operationId: OPERATION_ID,
      admissionMode: 'durable',
      providerFamily: 'boxlite',
      stage: 'runtime_setup',
      operation: 'runtime_setup',
      channel: 'primary',
      commandKind: 'runtime_setup',
      observedAt: OBSERVED_AT,
      outcome: 'failed',
      durationMs: 1_234,
      cause: 'missing_exit_code',
      retryable: false,
      httpStatusClass: null,
      nativeState: 'failed',
      anomaly: 'missing_exit_code',
      exitCode: null,
      timeoutMs: 15_000,
    });
    assert.equal(Object.isFrozen(record), true);
  });

  it('retains only required terminal facts when optional facts are absent', () => {
    const record = toTaskProvisioningDiagnosticLogRecord({
      ...commonEvent,
      commandKind: undefined,
      outcome: 'succeeded',
      cause: null,
      retryable: false,
    });

    assert.equal(record.commandKind, null);
    assert.deepEqual(Object.keys(record).slice(-3), [
      'outcome',
      'cause',
      'retryable',
    ]);
  });

  it('rejects unknown and raw fields with a fixed non-leaking error', () => {
    const rejectedFields = [
      'command',
      'argv',
      'stdout',
      'stderr',
      'output',
      'prompt',
      'body',
      'response',
      'url',
      'endpoint',
      'headers',
      'environment',
      'credentialPath',
      'rawProviderId',
      'providerResourceId',
      'providerExecutionId',
      'providerConnectionId',
      'error',
      'cause',
      'stack',
      'reason',
    ] as const;
    const rejectedValues: readonly unknown[] = [
      SECRET_CANARY,
      encodeURIComponent(`https://${SECRET_CANARY}.invalid/a b`),
      Buffer.from(SECRET_CANARY, 'utf8').toString('base64'),
      Buffer.from(SECRET_CANARY, 'utf8').toString('base64url'),
      Buffer.from(SECRET_CANARY, 'utf8'),
      new Uint8Array(Buffer.from(SECRET_CANARY, 'utf8')),
    ];

    for (const rejectedField of rejectedFields) {
      for (const rejectedValue of rejectedValues) {
        const candidate = {
          ...commonEvent,
          outcome: 'failed',
          cause: 'command_failed',
          retryable: false,
          [rejectedField]: rejectedValue,
        };

        assert.throws(
          () => toTaskProvisioningDiagnosticLogRecord(candidate),
          (error: unknown) => {
            assert.ok(error instanceof TypeError);
            assert.equal(
              error.message,
              'Invalid task provisioning diagnostic log event',
            );
            assert.equal(JSON.stringify(error).includes(SECRET_CANARY), false);
            assert.equal(String(error).includes(SECRET_CANARY), false);
            assert.equal(String(error).includes(rejectedField), false);
            return true;
          },
        );
      }
    }
  });
});
