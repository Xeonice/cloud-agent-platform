import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildTaskAdmissionClaimQuery,
  PrismaTaskAdmissionStore,
} from './prisma-task-admission.store';

const PENDING_TASK_FENCES = [
  { status: 'pending', lifecycleVersion: 3 },
] as const;

function claimedRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    taskId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'claim:one',
    leaseUntil: new Date('2026-07-15T00:01:00.000Z'),
    sourceState: 'accepted',
    attempt: 1,
    stage: 'accepted',
    resolvedBranch: 'master',
    resourceSnapshot: { diskSizeGb: 12 },
    workspaceMaterializationDeadlineMs: 900_000,
    taskStatus: 'pending',
    taskLifecycleVersion: 3,
    ...overrides,
  };
}

function sqlText(value: unknown): string {
  return (value as { readonly sql: string }).sql;
}

function sqlValues(value: unknown): readonly unknown[] {
  return (value as { readonly values: readonly unknown[] }).values;
}

test('claim is one parameterized CTE using DB time and SKIP LOCKED', () => {
  const token = 'opaque-worker-token-never-in-sql-text';
  const query = buildTaskAdmissionClaimQuery({
    leaseToken: token,
    leaseDurationMs: 30_000,
  });
  const sql = sqlText(query);

  assert.match(sql, /WITH candidate AS/);
  assert.match(sql, /FOR UPDATE OF w SKIP LOCKED/);
  assert.match(sql, /UPDATE "task_admission_work" AS w/);
  assert.match(sql, /clock_timestamp\(\)/);
  assert.match(sql, /WHEN w\."state" = 'queued' THEN w\."attempt"/);
  assert.match(
    sql,
    /t\."status"::text IN \(\s*'completed',\s*'failed',\s*'cancelled',\s*'agent_failed_to_start'\s*\)/,
  );
  assert.match(
    sql,
    /WHEN w\."state" = 'running' AND c\."task_terminal"\s*THEN GREATEST\(w\."attempt", 1\)/,
  );
  assert.match(sql, /ELSE w\."attempt" \+ 1/);
  assert.match(sql, /workspace_materialization_deadline_ms/);
  assert.match(sql, /INNER JOIN "tasks" AS t/);
  assert.equal(sql.includes(token), false);
  assert.equal(sql.includes('30000'), false);
  assert.deepEqual(sqlValues(query), [token, 30_000]);
});

test('claim parses and freezes the complete immutable processor context', async () => {
  let captured: unknown;
  const prisma = {
    async $queryRaw(query: unknown) {
      captured = query;
      return [claimedRow()];
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  const claim = await store.claim({
    leaseToken: 'claim:one',
    leaseDurationMs: 30_000,
  });

  assert.ok(captured);
  assert.deepEqual(claim, {
    taskId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'claim:one',
    leaseUntil: new Date('2026-07-15T00:01:00.000Z'),
    sourceState: 'accepted',
    attempt: 1,
    stage: 'accepted',
    resolvedBranch: 'master',
    resourceSnapshot: { diskSizeGb: 12 },
    workspaceMaterializationDeadlineMs: 900_000,
    taskStatus: 'pending',
    taskLifecycleVersion: 3,
  });
  assert.equal(Object.isFrozen(claim), true);
  assert.equal(Object.isFrozen(claim?.resourceSnapshot), true);
});

test('claim allows rolling null deadline but rejects values outside the durable DB bounds', async () => {
  let rows = [claimedRow({ workspaceMaterializationDeadlineMs: null })];
  const prisma = {
    async $queryRaw() {
      return rows;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  assert.equal(
    (
      await store.claim({
        leaseToken: 'claim:null',
        leaseDurationMs: 30_000,
      })
    )?.workspaceMaterializationDeadlineMs,
    null,
  );

  rows = [claimedRow({ workspaceMaterializationDeadlineMs: 999 })];
  await assert.rejects(
    () =>
      store.claim({
        leaseToken: 'claim:small',
        leaseDurationMs: 30_000,
      }),
    /invalid workspace materialization deadline/,
  );

  rows = [claimedRow({ workspaceMaterializationDeadlineMs: 86_400_001 })];
  await assert.rejects(
    () =>
      store.claim({
        leaseToken: 'claim:large',
        leaseDurationMs: 30_000,
      }),
    /invalid workspace materialization deadline/,
  );
});

test('renew, checkpoint, and settle all require the current unexpired running lease', async () => {
  const statements: unknown[] = [];
  const results = [1, 0, 1, 0, 1, 0];
  const prisma = {
    async $executeRaw(statement: unknown) {
      statements.push(statement);
      return results.shift() ?? 0;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);
  const lease = {
    taskId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'lease:fence',
  };

  assert.equal(
    await store.renew({
      ...lease,
      leaseDurationMs: 30_000,
      taskFences: PENDING_TASK_FENCES,
    }),
    true,
  );
  assert.equal(
    await store.renew({
      ...lease,
      leaseDurationMs: 30_000,
      taskFences: PENDING_TASK_FENCES,
    }),
    false,
  );
  assert.equal(
    await store.checkpoint({
      ...lease,
      stage: 'workspace_transfer',
      taskFences: PENDING_TASK_FENCES,
    }),
    true,
  );
  assert.equal(
    await store.checkpoint({
      ...lease,
      stage: 'accepted',
      taskFences: PENDING_TASK_FENCES,
    }),
    false,
  );
  assert.equal(
    await store.settle({
      ...lease,
      taskFences: PENDING_TASK_FENCES,
      settlement: { state: 'succeeded', stage: 'complete' },
    }),
    true,
  );
  assert.equal(
    await store.settle({
      ...lease,
      taskFences: PENDING_TASK_FENCES,
      settlement: { state: 'cancelled', stage: 'accepted' },
    }),
    false,
  );

  for (const statement of statements) {
    const sql = sqlText(statement);
    assert.match(sql, /"state" = 'running'/);
    assert.match(sql, /"lease_owner" = \?/);
    assert.match(sql, /"lease_until" > clock_timestamp\(\)/);
  }
  assert.match(sqlText(statements[2]), /array_position/);
  assert.match(sqlText(statements[2]), /credential_cleanup/);
});

test('settlement accepts only safe causes and never interpolates them into SQL', async () => {
  let statement: unknown;
  const prisma = {
    async $executeRaw(value: unknown) {
      statement = value;
      return 1;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);
  const safeCause = 'provisioning_tls_network_failed';

  assert.equal(
    await store.settle({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:safe',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'failed',
        stage: 'remote_ref_resolution',
        causeCode: safeCause,
      },
    }),
    true,
  );
  assert.equal(sqlText(statement).includes(safeCause), false);
  assert.equal(sqlValues(statement).includes(safeCause), true);

  await assert.rejects(() =>
    store.settle({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:unsafe',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'failed',
        stage: 'accepted',
        causeCode: 'raw-provider-diagnostic',
      } as never,
    }),
  );
});
