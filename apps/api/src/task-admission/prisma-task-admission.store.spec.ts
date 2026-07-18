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
  assert.match(
    sql,
    /w\."state" IN \('accepted', 'queued', 'retrying'\)/,
  );
  assert.match(sql, /w\."state" = 'running'/);
  assert.match(sql, /w\."state" = 'succeeded'/);
  assert.match(sql, /FROM "sandbox_runs" AS run/);
  assert.match(sql, /run\."status" IN \('provisioning', 'running', 'deleting'\)/);
  assert.match(sql, /run\."owner_generation" IS NOT NULL/);
  assert.match(sql, /run\."resource_generation" IS NOT NULL/);
  assert.match(
    sql,
    /t\."status"::text IN \(\s*'completed',\s*'failed',\s*'cancelled',\s*'agent_failed_to_start'\s*\)/,
  );
  assert.match(sql, /WHEN w\."state" = 'queued' THEN w\."attempt"/);
  assert.match(sql, /ELSE w\."attempt" \+ 1/);
  assert.match(sql, /workspace_materialization_deadline_ms/);
  assert.match(sql, /INNER JOIN "tasks" AS t/);
  assert.equal(sql.includes(token), false);
  assert.equal(sql.includes('30000'), false);
  assert.deepEqual(sqlValues(query), [token, 30_000]);
});

test('a terminal succeeded work row is claimable only for a live generation-fenced cleanup owner', async () => {
  const prisma = {
    async $queryRaw() {
      return [
        claimedRow({
          sourceState: 'succeeded',
          attempt: 4,
          stage: 'complete',
          taskStatus: 'completed',
          taskLifecycleVersion: 8,
        }),
      ];
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  const claim = await store.claim({
    leaseToken: 'terminal-cleanup:one',
    leaseDurationMs: 30_000,
  });

  assert.equal(claim?.sourceState, 'succeeded');
  assert.equal(claim?.attempt, 4);
  assert.equal(claim?.stage, 'complete');
  assert.equal(claim?.taskStatus, 'completed');
});

test('terminal claims preserve the current positive attempt before every source-state branch', () => {
  const sql = sqlText(
    buildTaskAdmissionClaimQuery({
      leaseToken: 'terminal-recovery-claim',
      leaseDurationMs: 30_000,
    }),
  );
  const terminalAttempt =
    'WHEN c."task_terminal" THEN GREATEST(w."attempt", 1)';
  const queuedAttempt = 'WHEN w."state" = \'queued\' THEN w."attempt"';
  assert.ok(
    sql.includes(terminalAttempt),
    'terminal recovery preserves the current positive attempt for every source state',
  );
  assert.ok(sql.includes(queuedAttempt));
  assert.ok(
    sql.indexOf(terminalAttempt) < sql.indexOf(queuedAttempt),
    'terminal recovery must win before queued replay or retry allocation',
  );
  assert.doesNotMatch(
    sql,
    /w\."state"\s*=\s*'running'\s+AND\s+c\."task_terminal"/,
    'terminal recovery cannot be restricted to expired running work',
  );
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

test('a retry claim carries only its closed durable cause provenance', async () => {
  let rows = [
    claimedRow({
      sourceState: 'retrying',
      causeCode: 'provisioning_tls_network_failed',
    }),
  ];
  const prisma = {
    async $queryRaw() {
      return rows;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  const claim = await store.claim({
    leaseToken: 'claim:retry',
    leaseDurationMs: 30_000,
  });
  assert.equal(claim?.sourceState, 'retrying');
  assert.equal(claim?.causeCode, 'provisioning_tls_network_failed');

  rows = [
    claimedRow({
      sourceState: 'retrying',
      causeCode: 'raw-provider-diagnostic',
    }),
  ];
  await assert.rejects(
    () =>
      store.claim({
        leaseToken: 'claim:unsafe-retry',
        leaseDurationMs: 30_000,
      }),
    /unsafe cause code/,
  );
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
  const safeCause = 'provisioning_platform_dependency_unavailable';

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

  assert.equal(
    await store.settle({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:retry',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'retrying',
        stage: 'remote_ref_resolution',
        causeCode: safeCause,
        availableAfterMs: 250,
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
  await assert.rejects(() =>
    store.settle({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:unsafe-retry',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'retrying',
        stage: 'accepted',
        causeCode: 'raw-provider-diagnostic',
        availableAfterMs: 250,
      } as never,
    }),
  );
});
