import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskFailure, TaskStatus } from '@cap/contracts';
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
    failureCode: null as string | null,
    failureAt: null as Date | null,
    failureExitCode: null as number | null,
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    branch: null,
    strategy: null,
    skills: [],
    idleTimeoutMs: null,
    deadlineMs: null,
    runtime: null as string | null,
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

test('runtime auth failure writes status and structured cause in one terminal CAS', async () => {
  const row = taskRow('running');
  const writes: Array<{
    status: TaskStatus;
    failureCode?: string;
    failureAt?: Date;
    failureExitCode?: number | null;
  }> = [];
  const prisma = {
    task: {
      findUnique() {
        return Promise.resolve({ ...row });
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; status: TaskStatus };
        data: {
          status: TaskStatus;
          failureCode?: string;
          failureAt?: Date;
          failureExitCode?: number | null;
        };
      }) {
        if (where.id !== TASK_ID || row.status !== where.status) {
          return { count: 0 };
        }
        Object.assign(row, data);
        writes.push(data);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  const audits: Array<{ next: TaskStatus; failure?: TaskFailure }> = [];
  const audit = {
    async recordTransition(
      _taskId: string,
      next: TaskStatus,
      _userId?: string,
      failure?: TaskFailure,
    ) {
      audits.push({ next, failure });
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

  const response = await service.failWithRuntimeFailure(
    TASK_ID,
    'runtime_auth_expired',
    1,
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 'failed');
  assert.equal(writes[0].failureCode, 'runtime_auth_expired');
  assert.ok(writes[0].failureAt instanceof Date);
  assert.equal(writes[0].failureExitCode, 1);
  assert.equal(row.status, 'failed');
  assert.equal(response.failure?.runtime, 'codex');
  assert.equal(response.failure?.code, 'runtime_auth_expired');
  assert.equal(response.failure?.action, 'reconnect_runtime');
  assert.equal(response.failure?.exitCode, 1);
  assert.match(response.failure?.message ?? '', /Codex.*已过期/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].next, 'failed');
  assert.deepEqual(audits[0].failure, response.failure);
  assert.deepEqual(fenced, [TASK_ID]);
  assert.deepEqual(settled, [TASK_ID]);
});

test('runtime auth failure enriches a generic failed CAS winner without repeating teardown', async () => {
  const row = taskRow('failed');
  row.runtime = 'claude-code';
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    task: {
      findUnique() {
        return Promise.resolve({ ...row });
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; status: TaskStatus; failureCode: null };
        data: {
          failureCode?: string;
          failureAt?: Date;
          failureExitCode?: number | null;
        };
      }) {
        if (
          where.id !== TASK_ID ||
          row.status !== where.status ||
          row.failureCode !== where.failureCode
        ) {
          return { count: 0 };
        }
        Object.assign(row, data);
        writes.push(data);
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  let audits = 0;
  const audit = {
    async recordTransition() {
      audits += 1;
    },
  } as unknown as AuditRecorderPort;
  let fences = 0;
  let settlements = 0;
  const guardrails = {
    fenceTerminal() {
      fences += 1;
    },
    async onTerminal() {
      settlements += 1;
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(prisma, guardrails, audit);

  const response = await service.failWithRuntimeFailure(
    TASK_ID,
    'runtime_auth_rejected',
    1,
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0].failureCode, 'runtime_auth_rejected');
  assert.ok(writes[0].failureAt instanceof Date);
  assert.equal(writes[0].failureExitCode, 1);
  assert.equal(response.status, 'failed');
  assert.equal(response.failure?.runtime, 'claude-code');
  assert.equal(response.failure?.code, 'runtime_auth_rejected');
  assert.equal(audits, 0, 'the original terminal winner owns lifecycle audit');
  assert.equal(fences, 0, 'the original terminal winner already fenced the task');
  assert.equal(settlements, 0, 'the original terminal winner already settled teardown');
});

test('runtime auth failure retries enrichment when a generic failed writer wins after its read', async () => {
  const row = taskRow('running');
  let initialReads = 0;
  let releaseInitialReads: (() => void) | undefined;
  const initialReadGate = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  let releaseGenericWrite: (() => void) | undefined;
  const genericWriteGate = new Promise<void>((resolve) => {
    releaseGenericWrite = resolve;
  });
  const writes: Array<Record<string, unknown>> = [];
  const prisma = {
    task: {
      async findUnique() {
        if (initialReads < 2) {
          initialReads += 1;
          if (initialReads === 2) releaseInitialReads?.();
          await initialReadGate;
        }
        return { ...row };
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id: string; status: TaskStatus; failureCode?: null };
        data: {
          status?: TaskStatus;
          failureCode?: string;
          failureAt?: Date;
          failureExitCode?: number | null;
        };
      }) {
        if (data.failureCode && row.status === 'running') {
          await genericWriteGate;
        }
        if (
          where.id !== TASK_ID ||
          row.status !== where.status ||
          (where.failureCode === null && row.failureCode !== null)
        ) {
          return { count: 0 };
        }
        Object.assign(row, data);
        writes.push(data);
        if (!data.failureCode) releaseGenericWrite?.();
        return { count: 1 };
      },
    },
  } as unknown as PrismaService;
  let audits = 0;
  const audit = {
    async recordTransition() {
      audits += 1;
    },
  } as unknown as AuditRecorderPort;
  let settlements = 0;
  const guardrails = {
    fenceTerminal() {},
    async onTerminal() {
      settlements += 1;
    },
  } as unknown as IGuardrailsService;
  const service = new TasksService(prisma, guardrails, audit);

  const [generic, classified] = await Promise.all([
    service.transition(TASK_ID, 'failed'),
    service.failWithRuntimeFailure(TASK_ID, 'runtime_auth_expired', 1),
  ]);

  assert.equal(generic.status, 'failed');
  assert.equal(classified.failure?.code, 'runtime_auth_expired');
  assert.equal(row.failureCode, 'runtime_auth_expired');
  assert.equal(writes.length, 2, 'one terminal status CAS plus one cause CAS');
  assert.equal(audits, 1, 'only the lifecycle winner records a transition audit');
  assert.equal(settlements, 1, 'only the lifecycle winner tears down the task');
});
