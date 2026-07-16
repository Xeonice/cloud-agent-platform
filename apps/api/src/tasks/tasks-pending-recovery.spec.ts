import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditRecorderPort } from '../audit/audit-recorder.port';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService, type IGuardrailsService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

test('startup re-offers only direct pending tasks with durable owner attribution', async () => {
  const events: string[] = [];
  let where: unknown;
  const prisma = {
    task: {
      async findMany(args: { where: unknown }) {
        where = args.where;
        return [
          {
            id: TASK_ID,
            status: 'pending',
            ownerUserId: USER_ID,
            deadlineMs: null,
            idleTimeoutMs: null,
            auditEvents: [],
          },
        ];
      },
    },
  } as unknown as PrismaService;
  const guardrails: IGuardrailsService = {
    async admit(taskId, params) {
      events.push(`admit:${taskId}:${params?.userId}`);
      return 'running';
    },
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
  };
  const audit = {
    async recordTaskCreated(taskId: string, userId?: string) {
      events.push(`audit:${taskId}:${userId}`);
    },
  } as unknown as AuditRecorderPort;
  const service = new TasksService(prisma, guardrails, audit);

  assert.equal(await service.reofferQueuedOnStartup(), 1);
  assert.deepEqual(where, {
    admissionWork: { is: null },
    OR: [
      { status: 'queued' },
      { status: 'pending', scheduleRun: { is: null } },
    ],
  });
  assert.deepEqual(events, [
    `audit:${TASK_ID}:${USER_ID}`,
    `admit:${TASK_ID}:${USER_ID}`,
  ]);
});

test('startup re-offer excludes pending/queued tasks owned by durable admission work', async () => {
  const admitted: string[] = [];
  const rows = [
    { id: 'legacy-pending', status: 'pending', hasWork: false },
    { id: 'legacy-queued', status: 'queued', hasWork: false },
    { id: 'durable-pending', status: 'pending', hasWork: true },
    { id: 'durable-queued', status: 'queued', hasWork: true },
  ];
  const prisma = {
    task: {
      async findMany(args: {
        where: { admissionWork?: { is: null } };
      }) {
        assert.deepEqual(args.where.admissionWork, { is: null });
        return rows
          .filter((row) => !row.hasWork)
          .map((row) => ({
            id: row.id,
            status: row.status,
            ownerUserId: USER_ID,
            deadlineMs: null,
            idleTimeoutMs: null,
            auditEvents: [],
          }));
      },
    },
  } as unknown as PrismaService;
  const guardrails: IGuardrailsService = {
    async admit(taskId) {
      admitted.push(taskId);
      return 'running';
    },
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
  };
  const service = new TasksService(prisma, guardrails);

  assert.equal(await service.reofferQueuedOnStartup(), 2);
  assert.deepEqual(admitted, ['legacy-pending', 'legacy-queued']);
});
