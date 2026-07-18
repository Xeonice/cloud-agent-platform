import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  TaskProvisioningDiagnosticsResponseSchema,
  type TaskProvisioningDiagnosticsResponse,
} from '@cap/contracts';

import type { PrismaService } from '../prisma/prisma.service';
import type { TaskProvisioningDiagnosticRecorderResult } from './task-provisioning-diagnostic-recorder.port';
import { TaskProvisioningDiagnosticsConsoleQueryService } from './task-provisioning-diagnostics-console-query.service';
import type { TaskProvisioningDiagnosticsCapabilityGatePort } from './task-provisioning-diagnostics-deployment-gate.port';
import type { TaskProvisioningDiagnosticsService } from './task-provisioning-diagnostics.service';

const ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';
const TASK_ID = '10000000-0000-4000-8000-000000000001';
const QUERY = { limit: 37, cursor: 'opaque-cursor' } as const;
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

type LiveAccount = {
  readonly allowed: boolean;
  readonly role: 'admin' | 'member' | 'unexpected';
};

function harness(
  initialAccount: LiveAccount | null = { allowed: true, role: 'member' },
  initialResult: TaskProvisioningDiagnosticRecorderResult<TaskProvisioningDiagnosticsResponse> = {
    ok: true,
    value: RESPONSE,
  },
) {
  let account = initialAccount;
  let accountFailure: unknown;
  let result = initialResult;
  let readFailure: unknown;
  let gateCalls = 0;
  let closeGateAt: number | null = null;
  const accountLookups: unknown[] = [];
  const ownedReads: unknown[][] = [];
  const unrestrictedReads: unknown[][] = [];

  const prisma = {
    user: {
      async findUnique(args: unknown) {
        accountLookups.push(args);
        if (accountFailure !== undefined) throw accountFailure;
        return account;
      },
    },
  } as unknown as PrismaService;
  const diagnostics = {
    async readOwnedTaskDiagnostics(...args: unknown[]) {
      ownedReads.push(args);
      if (readFailure !== undefined) throw readFailure;
      return result;
    },
    async readTaskDiagnostics(...args: unknown[]) {
      unrestrictedReads.push(args);
      if (readFailure !== undefined) throw readFailure;
      return result;
    },
  } as unknown as TaskProvisioningDiagnosticsService;
  const gate: TaskProvisioningDiagnosticsCapabilityGatePort = {
    assertReadOpen() {
      gateCalls += 1;
      if (gateCalls === closeGateAt) {
        throw new Error('raw capability attestation secret');
      }
    },
    assertScopesGrantable() {},
  };
  const service = new TaskProvisioningDiagnosticsConsoleQueryService(
    prisma,
    diagnostics,
    gate,
  );

  return {
    service,
    setAccount(next: LiveAccount | null) {
      account = next;
    },
    setAccountFailure(next: unknown) {
      accountFailure = next;
    },
    setResult(next: typeof result) {
      result = next;
    },
    setReadFailure(next: unknown) {
      readFailure = next;
    },
    closeGateOn(call: number) {
      closeGateAt = call;
    },
    calls: () => ({
      gateCalls,
      accountLookups,
      ownedReads,
      unrestrictedReads,
    }),
  };
}

test('a live enabled member uses only the owner-constrained canonical read', async () => {
  const testHarness = harness();

  const response = await testHarness.service.readForSessionAccount(
    ACCOUNT_ID,
    TASK_ID,
    QUERY,
  );

  assert.deepEqual(response, RESPONSE);
  assert.deepEqual(testHarness.calls(), {
    gateCalls: 2,
    accountLookups: [
      {
        where: { id: ACCOUNT_ID },
        select: { allowed: true, role: true },
      },
    ],
    ownedReads: [[ACCOUNT_ID, TASK_ID, QUERY]],
    unrestrictedReads: [],
  });
});

test('a live enabled admin may use the unrestricted read for cross-owner and ownerless tasks', async () => {
  const testHarness = harness({ allowed: true, role: 'admin' });

  const response = await testHarness.service.readForSessionAccount(
    ACCOUNT_ID,
    TASK_ID,
    QUERY,
  );

  assert.deepEqual(response, RESPONSE);
  assert.deepEqual(testHarness.calls().ownedReads, []);
  assert.deepEqual(testHarness.calls().unrestrictedReads, [[TASK_ID, QUERY]]);
});

test('a stale admin session snapshot cannot bypass the live member role', async () => {
  const testHarness = harness(
    { allowed: true, role: 'member' },
    { ok: false, code: 'task_not_found', safeCause: 'coordination_failed' },
  );

  await assert.rejects(
    testHarness.service.readForSessionAccount(ACCOUNT_ID, TASK_ID, QUERY),
    NotFoundException,
  );

  assert.deepEqual(testHarness.calls().ownedReads, [
    [ACCOUNT_ID, TASK_ID, QUERY],
  ]);
  assert.deepEqual(testHarness.calls().unrestrictedReads, []);
});

test('missing, disabled, and non-contract live accounts fail closed before every diagnostic read', async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly account: LiveAccount | null;
  }> = [
    { name: 'missing', account: null },
    { name: 'disabled admin', account: { allowed: false, role: 'admin' } },
    { name: 'disabled member', account: { allowed: false, role: 'member' } },
    {
      name: 'unexpected database role',
      account: { allowed: true, role: 'unexpected' },
    },
  ];

  for (const testCase of cases) {
    const testHarness = harness(testCase.account);
    await assert.rejects(
      testHarness.service.readForSessionAccount(ACCOUNT_ID, TASK_ID, QUERY),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenException, testCase.name);
        assert.deepEqual(error.getResponse(), {
          statusCode: 403,
          error: 'Forbidden',
          message: 'Task provisioning diagnostics access is denied.',
        });
        return true;
      },
      testCase.name,
    );
    assert.equal(testHarness.calls().accountLookups.length, 1);
    assert.deepEqual(testHarness.calls().ownedReads, []);
    assert.deepEqual(testHarness.calls().unrestrictedReads, []);
  }
});

test('a closed pre-gate prevents the live-account lookup and diagnostic read', async () => {
  const testHarness = harness();
  testHarness.closeGateOn(1);

  await assertUnavailable(
    testHarness.service.readForSessionAccount(ACCOUNT_ID, TASK_ID, QUERY),
  );
  assert.deepEqual(testHarness.calls(), {
    gateCalls: 1,
    accountLookups: [],
    ownedReads: [],
    unrestrictedReads: [],
  });
});

test('a post-read gate closure withholds canonical evidence', async () => {
  const testHarness = harness();
  testHarness.closeGateOn(2);

  await assertUnavailable(
    testHarness.service.readForSessionAccount(ACCOUNT_ID, TASK_ID, QUERY),
  );
  assert.equal(testHarness.calls().ownedReads.length, 1);
  assert.equal(testHarness.calls().gateCalls, 2);
});

test('recorder result codes map to safe 404, 400, and 503 Console errors', async () => {
  const cases = [
    {
      recorderCode: 'task_not_found',
      exception: NotFoundException,
      status: 404,
      response: {
        statusCode: 404,
        error: 'Not Found',
        message: 'Task provisioning diagnostics were not found.',
      },
    },
    {
      recorderCode: 'invalid_evidence',
      exception: BadRequestException,
      status: 400,
      response: {
        statusCode: 400,
        error: 'Bad Request',
        message: 'Task provisioning diagnostics request is invalid.',
      },
    },
    {
      recorderCode: 'diagnostics_unavailable',
      exception: ServiceUnavailableException,
      status: 503,
      response: unavailableResponse(),
    },
    {
      recorderCode: 'diagnostic_write_failed',
      exception: ServiceUnavailableException,
      status: 503,
      response: unavailableResponse(),
    },
  ] as const;

  for (const testCase of cases) {
    const testHarness = harness({ allowed: true, role: 'member' }, {
      ok: false,
      code: testCase.recorderCode,
      safeCause:
        testCase.recorderCode === 'diagnostic_write_failed'
          ? 'diagnostic_write_failed'
          : 'coordination_failed',
    });

    await assert.rejects(
      testHarness.service.readForSessionAccount(ACCOUNT_ID, TASK_ID, QUERY),
      (error: unknown) => {
        assert.ok(error instanceof testCase.exception, testCase.recorderCode);
        assert.equal(error.getStatus(), testCase.status);
        assert.deepEqual(error.getResponse(), testCase.response);
        assert.equal(JSON.stringify(error).includes('safeCause'), false);
        return true;
      },
      testCase.recorderCode,
    );
  }
});

test('live-account and diagnostic store throws become secret-free retryable unavailable', async () => {
  const accountFailureHarness = harness();
  accountFailureHarness.setAccountFailure(
    new Error('raw account database password=account-secret'),
  );
  await assertUnavailable(
    accountFailureHarness.service.readForSessionAccount(
      ACCOUNT_ID,
      TASK_ID,
      QUERY,
    ),
  );
  assert.deepEqual(accountFailureHarness.calls().ownedReads, []);

  for (const role of ['member', 'admin'] as const) {
    const diagnosticFailureHarness = harness({ allowed: true, role });
    diagnosticFailureHarness.setReadFailure(
      new Error('raw provider token=diagnostic-secret'),
    );
    await assertUnavailable(
      diagnosticFailureHarness.service.readForSessionAccount(
        ACCOUNT_ID,
        TASK_ID,
        QUERY,
      ),
    );
  }
});

async function assertUnavailable(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServiceUnavailableException);
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), unavailableResponse());
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes('secret'), false);
    assert.equal(serialized.includes(TASK_ID), false);
    assert.equal(serialized.includes(ACCOUNT_ID), false);
    return true;
  });
}

function unavailableResponse() {
  return {
    code: 'task_provisioning_diagnostics_unavailable',
    message: 'Task provisioning diagnostics are temporarily unavailable.',
    retryable: true,
  } as const;
}
