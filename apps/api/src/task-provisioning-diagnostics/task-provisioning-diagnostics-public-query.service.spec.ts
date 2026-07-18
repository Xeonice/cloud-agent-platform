import assert from 'node:assert/strict';
import test from 'node:test';

import { ServiceUnavailableException } from '@nestjs/common';
import {
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import { PublicSurfaceError } from '../public-surface/public-surface-error';
import type { TaskProvisioningDiagnosticRecorderResult } from './task-provisioning-diagnostic-recorder.port';
import type { TaskProvisioningDiagnosticsCapabilityGatePort } from './task-provisioning-diagnostics-deployment-gate.port';
import { TaskProvisioningDiagnosticsPublicQueryService } from './task-provisioning-diagnostics-public-query.service';
import type { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';

const OWNER_ID = '10000000-0000-4000-8000-000000000002';
const TASK_ID = '10000000-0000-4000-8000-000000000001';
const QUERY = { limit: 50 } as const;
const RESPONSE = TaskProvisioningDiagnosticsResponseSchema.parse({
  schemaVersion: 1,
  taskId: TASK_ID,
  coverage: 'unavailable',
  admissionState: null,
  attempts: [],
  events: [],
  compaction: null,
  nextCursor: null,
});

function harness(
  initialResult: TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticsResponse> = {
    ok: true,
    value: RESPONSE,
  },
) {
  let result = initialResult;
  let readFailure: unknown;
  let readCalls = 0;
  const callArguments: unknown[][] = [];
  let gateCalls = 0;
  let closeAt: number | null = null;
  const diagnostics = {
    async readOwnedTaskDiagnostics(...args: unknown[]) {
      readCalls += 1;
      callArguments.push(args);
      if (readFailure !== undefined) throw readFailure;
      return result;
    },
  } as unknown as TaskProvisioningDiagnosticsService;
  const gate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen() {
      gateCalls += 1;
      if (gateCalls === closeAt) throw new Error('raw attestation secret');
    },
    assertScopesGrantable() {},
  };
  const service = new TaskProvisioningDiagnosticsPublicQueryService(
    diagnostics,
    gate,
  );
  return {
    service,
    setResult(next: typeof result) {
      result = next;
    },
    setReadFailure(next: unknown) {
      readFailure = next;
    },
    closeGateAt(call: number) {
      closeAt = call;
    },
    counts: () => ({ gateCalls, readCalls }),
    callArguments,
  };
}

test('shared public query checks the same gate before and after the owner read', async () => {
  const testHarness = harness();
  const response = await testHarness.service.readForOwner(
    OWNER_ID,
    TASK_ID,
    QUERY,
  );

  assert.deepEqual(response, RESPONSE);
  assert.deepEqual(testHarness.counts(), { gateCalls: 2, readCalls: 1 });
  assert.deepEqual(testHarness.callArguments, [[OWNER_ID, TASK_ID, QUERY]]);
});

test('a closed pre-gate prevents every diagnostic query', async () => {
  const testHarness = harness();
  testHarness.closeGateAt(1);

  await assert.rejects(
    testHarness.service.readForOwner(OWNER_ID, TASK_ID, QUERY),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.deepEqual(error.getResponse(), {
        code: 'task_provisioning_diagnostics_unavailable',
        message: 'Task provisioning diagnostics are temporarily unavailable.',
        retryable: true,
      });
      return true;
    },
  );
  assert.deepEqual(testHarness.counts(), { gateCalls: 1, readCalls: 0 });
});

test('a post-read gate closure withholds evidence obtained during attestation drift', async () => {
  const testHarness = harness();
  testHarness.closeGateAt(2);

  await assert.rejects(
    testHarness.service.readForOwner(OWNER_ID, TASK_ID, QUERY),
    (error: unknown) => {
      assert.ok(error instanceof ServiceUnavailableException);
      assert.equal(JSON.stringify(error.getResponse()).includes(TASK_ID), false);
      return true;
    },
  );
  assert.deepEqual(testHarness.counts(), { gateCalls: 2, readCalls: 1 });
});

test('recorder result codes map to bounded public semantics without raw detail', async () => {
  const cases = [
    { recorderCode: 'task_not_found', publicCode: 'not_found' },
    { recorderCode: 'invalid_evidence', publicCode: 'validation_failed' },
    {
      recorderCode: 'diagnostics_unavailable',
      publicCode: 'task_provisioning_diagnostics_unavailable',
    },
    {
      recorderCode: 'diagnostic_write_failed',
      publicCode: 'task_provisioning_diagnostics_unavailable',
    },
  ] as const;

  for (const testCase of cases) {
    const testHarness = harness({
      ok: false,
      code: testCase.recorderCode,
      safeCause:
        testCase.recorderCode === 'diagnostic_write_failed'
          ? 'diagnostic_write_failed'
          : 'coordination_failed',
    });
    await assert.rejects(
      testHarness.service.readForOwner(OWNER_ID, TASK_ID, QUERY),
      (error: unknown) => {
        assert.ok(error instanceof PublicSurfaceError);
        assert.equal(error.code, testCase.publicCode);
        assert.equal(JSON.stringify(error).includes('safeCause'), false);
        return true;
      },
      testCase.recorderCode,
    );
  }
});

test('an unexpected store throw becomes generic diagnostics unavailable', async () => {
  const testHarness = harness();
  testHarness.setReadFailure(new Error('raw database secret and path'));

  await assert.rejects(
    testHarness.service.readForOwner(OWNER_ID, TASK_ID, QUERY),
    (error: unknown) => {
      assert.ok(error instanceof PublicSurfaceError);
      assert.equal(
        error.code,
        'task_provisioning_diagnostics_unavailable',
      );
      assert.equal(error.message.includes('secret'), false);
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    },
  );
});
