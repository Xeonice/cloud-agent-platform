import assert from 'node:assert/strict';
import test from 'node:test';
import type { CreateTaskBody } from '@cap-console/contracts';
import type { AuditRecorderPort } from '@/audit/audit-recorder.port';
import type { PrismaService } from '@/prisma/prisma.service';
import { TasksService, type IGuardrailsService } from './tasks.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

test('post-commit dispatch attributes the creation audit to the persisted owner', async () => {
  const events: string[] = [];
  const guardrails: IGuardrailsService = {
    async onTerminal() {},
    recordFailure() {},
    recordSuccess() {},
  };
  const audit = {
    async recordTaskCreated(taskId: string, userId?: string) {
      events.push(`audit:${taskId}:${userId ?? 'none'}`);
    },
  } as unknown as AuditRecorderPort;
  const prisma = {
    task: {
      async findUnique() {
        return { ownerUserId: USER_ID };
      },
    },
  } as unknown as PrismaService;
  const service = new TasksService(prisma, guardrails, audit);
  const body: CreateTaskBody = {
    prompt: 'scheduled work',
    deadlineMs: 60_000,
    idleTimeoutMs: 30_000,
  };

  await service.admitCreatedTask(TASK_ID, body, USER_ID);

  // The owner comes from the PERSISTED row, not from the caller's argument, so
  // the owner-scoped credential resolver reading this event agrees with the
  // task's row even when the two disagree.
  assert.deepEqual(events, [`audit:${TASK_ID}:${USER_ID}`]);
});
