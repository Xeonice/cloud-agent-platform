import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AdmissionTransitionIndeterminateError,
  TasksService,
} from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

test('admission transition CAS has one winner and one idempotent observer', async () => {
  let status = 'pending';
  let queuedAdmissionToken: string | null = null;
  let runningAdmissionToken: string | null = null;
  let auditCalls = 0;
  const prisma = {
    task: {
      async findUnique() {
        return { status, queuedAdmissionToken, runningAdmissionToken };
      },
      async updateMany({
        where,
        data,
      }: {
        where: { status: string };
        data: {
          status: string;
          queuedAdmissionToken?: string;
          runningAdmissionToken?: string;
        };
      }) {
        if (status !== where.status) return { count: 0 };
        status = data.status;
        queuedAdmissionToken = data.queuedAdmissionToken ?? queuedAdmissionToken;
        runningAdmissionToken = data.runningAdmissionToken ?? runningAdmissionToken;
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTransition() {
      auditCalls += 1;
    },
  } as unknown as AuditRecorderPort;
  const service = new TasksService(prisma, undefined, audit);

  const results = await Promise.all([
    service.transitionForAdmission(TASK_ID, 'running', USER_ID),
    service.transitionForAdmission(TASK_ID, 'running', USER_ID),
  ]);

  assert.deepEqual(results.sort(), ['already-transitioned', 'transitioned']);
  assert.equal(status, 'running');
  assert.equal(auditCalls, 1);
});

test('ambiguous admission commit is resolved by the same durable winner token', async () => {
  const transitionToken = '44444444-4444-4444-8444-444444444444';
  let status = 'pending';
  let runningAdmissionToken: string | null = null;
  let auditCalls = 0;
  let firstWrite = true;
  const prisma = {
    task: {
      async findUnique() {
        return {
          status,
          queuedAdmissionToken: null,
          runningAdmissionToken,
        };
      },
      async updateMany({ data }: { data: { status: string; runningAdmissionToken: string } }) {
        status = data.status;
        runningAdmissionToken = data.runningAdmissionToken;
        if (firstWrite) {
          firstWrite = false;
          throw new Error('connection dropped after commit');
        }
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTransition() {
      auditCalls += 1;
    },
  } as unknown as AuditRecorderPort;
  const service = new TasksService(prisma, undefined, audit);

  await assert.rejects(
    service.transitionForAdmission(TASK_ID, 'running', USER_ID, transitionToken),
    (err: unknown) =>
      err instanceof AdmissionTransitionIndeterminateError &&
      err.transitionToken === transitionToken,
  );

  assert.equal(
    await service.reconcileAdmissionTransition(
      TASK_ID,
      'running',
      transitionToken,
      USER_ID,
    ),
    'transitioned',
  );
  assert.equal(
    await service.isAdmissionTransitionCurrent(TASK_ID, 'running', transitionToken),
    true,
  );
  assert.equal(auditCalls, 1);
});

test('a queued winner can be identified after another worker has already promoted it', async () => {
  const transitionToken = '55555555-5555-4555-8555-555555555555';
  let auditCalls = 0;
  const prisma = {
    task: {
      async findUnique() {
        return {
          status: 'running',
          queuedAdmissionToken: transitionToken,
          runningAdmissionToken: 'another-running-worker',
        };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTransition() {
      auditCalls += 1;
    },
  } as unknown as AuditRecorderPort;
  const service = new TasksService(prisma, undefined, audit);

  assert.equal(
    await service.reconcileAdmissionTransition(
      TASK_ID,
      'queued',
      transitionToken,
      USER_ID,
    ),
    'superseded',
  );
  assert.equal(auditCalls, 1);
});
