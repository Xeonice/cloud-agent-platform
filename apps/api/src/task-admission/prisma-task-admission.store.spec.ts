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

test('claim resumes parked work only through the expired-lease branch, preserving attempt and generation', () => {
  const sql = sqlText(
    buildTaskAdmissionClaimQuery({
      leaseToken: 'parked-resume-claim',
      leaseDurationMs: 30_000,
    }),
  );

  // Parked rows are never claimable by available_at: only their expired lease
  // (poll-loop release, crash, or rollback) makes them candidates.
  assert.match(
    sql,
    /w\."state" = 'parked'\s+AND w\."lease_until" <= clock_timestamp\(\)/,
  );
  assert.match(
    sql,
    /w\."state" IN \('accepted', 'queued', 'retrying'\)\s+AND w\."available_at" <= clock_timestamp\(\)/,
  );
  // Parking is not a retry event: resume keeps the parked attempt.
  assert.match(sql, /WHEN w\."state" = 'parked' THEN w\."attempt"/);
  // Ordering treats parked like an expired running lease.
  assert.match(
    sql,
    /WHEN w\."state" IN \('running', 'parked'\) THEN w\."lease_until"/,
  );
  // The retained parked generation travels with the claim for the ownership
  // re-stamp compare, and only for parked source rows.
  assert.match(sql, /w\."lease_owner" AS "parked_lease_owner"/);
  assert.match(
    sql,
    /WHEN c\."source_state" = 'parked' THEN c\."parked_lease_owner"\s+ELSE NULL/,
  );
});

test('a parked claim surfaces the parked generation without burning the attempt', async () => {
  const prisma = {
    async $queryRaw() {
      return [
        claimedRow({
          sourceState: 'parked',
          attempt: 3,
          stage: 'workspace_transfer',
          parkedLeaseToken: 'parked:generation',
        }),
      ];
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  const claim = await store.claim({
    leaseToken: 'parked-resume:one',
    leaseDurationMs: 30_000,
  });

  assert.equal(claim?.sourceState, 'parked');
  assert.equal(claim?.attempt, 3);
  assert.equal(claim?.stage, 'workspace_transfer');
  assert.equal(claim?.parkedLeaseToken, 'parked:generation');
});

test('a parked claim without its retained generation fails closed', async () => {
  const prisma = {
    async $queryRaw() {
      return [
        claimedRow({
          sourceState: 'parked',
          attempt: 1,
          stage: 'workspace_transfer',
          parkedLeaseToken: null,
        }),
      ];
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  await assert.rejects(() =>
    store.claim({ leaseToken: 'parked-resume:two', leaseDurationMs: 30_000 }),
  );
});

test('non-parked claims never surface a parked generation', async () => {
  const prisma = {
    async $queryRaw() {
      return [claimedRow({ parkedLeaseToken: null })];
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  const claim = await store.claim({
    leaseToken: 'accepted:one',
    leaseDurationMs: 30_000,
  });

  assert.equal(claim?.sourceState, 'accepted');
  assert.equal(claim?.parkedLeaseToken ?? null, null);
});

test('park settles from the running lease but retains the lease pair as the parked generation', async () => {
  let statement: unknown;
  const prisma = {
    async $executeRaw(value: unknown) {
      statement = value;
      return 1;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  assert.equal(
    await store.park({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:parking',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'parked',
        stage: 'workspace_transfer',
        leaseDurationMs: 60_000,
      },
    }),
    true,
  );

  const sql = sqlText(statement);
  // Fenced exactly like settle: only the live running owner may park.
  assert.match(sql, /"state" = 'running'/);
  assert.match(sql, /"lease_owner" = \?/);
  assert.match(sql, /"lease_until" > clock_timestamp\(\)/);
  assert.match(sql, /"state" = 'parked'/);
  // The lease pair is retained, not released: the token stays as the parked
  // ownership generation and the expiry becomes the recovery horizon.
  assert.doesNotMatch(sql, /"lease_owner" = NULL/);
  assert.match(
    sql,
    /"lease_until" = clock_timestamp\(\)\s+\+ \(\?::bigint \* interval '1 millisecond'\)/,
  );
  assert.equal(sqlValues(statement).includes(60_000), true);
  assert.equal(sql.includes('60000'), false);

  await assert.rejects(() =>
    store.park({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:parking',
      taskFences: PENDING_TASK_FENCES,
      settlement: {
        state: 'parked',
        stage: 'workspace_transfer',
        leaseDurationMs: 0,
      },
    }),
  );
});

test('parked heartbeat extends only a live parked lease and persists the numeric snapshot', async () => {
  const statements: unknown[] = [];
  const prisma = {
    async $executeRaw(value: unknown) {
      statements.push(value);
      return 1;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);
  const request = {
    taskId: '11111111-1111-4111-8111-111111111111',
    leaseToken: 'lease:parked-generation',
    leaseDurationMs: 30_000,
  };

  assert.equal(
    await store.parkedHeartbeat({
      ...request,
      progress: {
        percent: 42,
        receivedObjects: 420,
        totalObjects: 1000,
        receivedBytes: 65_536,
        throughputBytesPerSecond: 8_192,
      },
    }),
    true,
  );
  const withProgress = sqlText(statements[0]);
  assert.match(withProgress, /"state" = 'parked'/);
  assert.match(withProgress, /"lease_owner" = \?/);
  // A late tick can never resurrect an already-expired parked lease.
  assert.match(withProgress, /"lease_until" > clock_timestamp\(\)/);
  assert.match(withProgress, /"progress_percent" = \?/);
  assert.match(withProgress, /"progress_throughput_bytes_per_second" = \?/);
  assert.equal(sqlValues(statements[0]).includes(42), true);

  // An omitted snapshot leaves the stored progress columns untouched.
  assert.equal(await store.parkedHeartbeat(request), true);
  const withoutProgress = sqlText(statements[1]);
  assert.doesNotMatch(withoutProgress, /progress_percent/);

  // Numeric-only, bounded: indeterminate is null, never an out-of-range value.
  await assert.rejects(() =>
    store.parkedHeartbeat({
      ...request,
      progress: {
        percent: 101,
        receivedObjects: null,
        totalObjects: null,
        receivedBytes: null,
        throughputBytesPerSecond: null,
      },
    }),
  );
  await assert.rejects(() =>
    store.parkedHeartbeat({
      ...request,
      progress: {
        percent: null,
        receivedObjects: null,
        totalObjects: null,
        receivedBytes: -1,
        throughputBytesPerSecond: null,
      },
    }),
  );
});

test('releaseParked expires the parked lease in place without admission or settlement', async () => {
  let statement: unknown;
  const prisma = {
    async $executeRaw(value: unknown) {
      statement = value;
      return 1;
    },
  } as unknown as PrismaService;
  const store = new PrismaTaskAdmissionStore(prisma);

  assert.equal(
    await store.releaseParked({
      taskId: '11111111-1111-4111-8111-111111111111',
      leaseToken: 'lease:parked-generation',
    }),
    true,
  );

  const sql = sqlText(statement);
  assert.match(sql, /"state" = 'parked'/);
  assert.match(sql, /"lease_owner" = \?/);
  assert.match(sql, /"lease_until" = clock_timestamp\(\)/);
  assert.match(sql, /"available_at" = clock_timestamp\(\)/);
  // No state transition, attempt mutation, or cause writing happens here: the
  // row re-enters only through the expired-lease claim branch.
  assert.doesNotMatch(sql, /"state" =\s*\?/);
  assert.doesNotMatch(sql, /"attempt"/);
  assert.doesNotMatch(sql, /"cause_code"/);
});
