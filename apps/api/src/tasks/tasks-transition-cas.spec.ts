import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskStatus } from '@cap/contracts';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { PrismaService } from '../prisma/prisma.service';
import type { IGuardrailsService } from './tasks.service';
import { IllegalTaskTransitionError } from './task-lifecycle';
import { TasksService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = '22222222-2222-4222-8222-222222222222';

function taskRow(status: TaskStatus) {
  return {
    id: TASK_ID,
    repoId: REPO_ID,
    ownerUserId: null,
    prompt: 'transition race',
    status,
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: null,
    sandboxEnvironmentId: null,
    executionMode: null,
    deliver: null,
    deliverStatus: null,
    branchPushed: null,
    commitSha: null,
    changeRequestUrl: null,
    changeRequestNumber: null,
    sandboxRuns: [],
    sandboxEnvironment: null,
    scheduleRun: null,
  };
}

test('concurrent terminal transitions use status CAS and cannot overwrite the winner', async () => {
  let status: TaskStatus = 'running';
  const writes: TaskStatus[] = [];
  const prisma = {
    task: {
      findUnique() {
        return Promise.resolve(taskRow(status));
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; status: TaskStatus };
        data: { status: TaskStatus };
      }) {
        if (where.id !== TASK_ID || status !== where.status) return { count: 0 };
        status = data.status;
        writes.push(data.status);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const audits: TaskStatus[] = [];
  const audit = {
    async recordTransition(_taskId: string, next: TaskStatus) {
      audits.push(next);
    },
  } as unknown as AuditRecorderPort;
  const fenced: string[] = [];
  const settled: string[] = [];
  const guardrails = {
    fenceTerminal(taskId: string) {
      fenced.push(taskId);
    },
    async onTerminal(taskId: string) {
      settled.push(taskId);
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(prisma, guardrails, audit);

  const results = await Promise.allSettled([
    service.transition(TASK_ID, 'completed'),
    service.transition(TASK_ID, 'cancelled'),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof IllegalTaskTransitionError);
  assert.equal(writes.length, 1);
  assert.equal(status, writes[0]);
  assert.deepEqual(audits, writes);
  assert.deepEqual(fenced, [TASK_ID]);
  assert.deepEqual(settled, [TASK_ID]);
});

test('the real stop path fences and starts teardown immediately after its terminal CAS', async () => {
  let status: TaskStatus = 'running';
  let findCalls = 0;
  let releasePostCasRead: (() => void) | undefined;
  const postCasReadGate = new Promise<void>((resolve) => {
    releasePostCasRead = resolve;
  });
  let releaseAudit: (() => void) | undefined;
  const auditGate = new Promise<void>((resolve) => {
    releaseAudit = resolve;
  });
  const prisma = {
    task: {
      async findUnique() {
        findCalls += 1;
        // stop() reads once, transition() reads once, then the response row is
        // read after the terminal CAS. Hold that third read open to prove the
        // fence starts in the CAS continuation rather than after this await.
        if (findCalls === 3) await postCasReadGate;
        return Promise.resolve(taskRow(status));
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; status: TaskStatus };
        data: { status: TaskStatus };
      }) {
        if (status !== where.status) return { count: 0 };
        status = data.status;
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const audit = {
    async recordTransition() {
      await auditGate;
    },
  } as unknown as AuditRecorderPort;
  let fenced = false;
  let teardownStarted = false;
  const guardrails = {
    fenceTerminal() {
      fenced = true;
    },
    async onTerminal() {
      teardownStarted = true;
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(prisma, guardrails, audit);

  const stopped = service.stop(TASK_ID);
  for (let attempt = 0; attempt < 100 && !fenced; attempt += 1) {
    await Promise.resolve();
  }

  assert.equal(status, 'cancelled');
  assert.equal(fenced, true);
  assert.equal(teardownStarted, true);
  releasePostCasRead?.();
  let stopSettled = false;
  void stopped.finally(() => {
    stopSettled = true;
  });
  await Promise.resolve();
  assert.equal(stopSettled, false, 'the audit is still deliberately blocked');

  releaseAudit?.();
  assert.equal((await stopped).status, 'cancelled');
});
