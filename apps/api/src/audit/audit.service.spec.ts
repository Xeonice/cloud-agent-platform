import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';

interface CreatedAuditRow {
  taskId: string;
  userId: string | null;
  type: string;
  level: string;
  resultCode: number | null;
  title: string;
  description: string;
  dedupeKey: string;
}

function buildService() {
  let row: CreatedAuditRow | null = null;
  let creates = 0;
  const prisma = {
    user: {
      async findUnique({ where }: { where: { id: string } }) {
        return { id: where.id };
      },
    },
    auditEvent: {
      async upsert({
        where,
        create,
      }: {
        where: { dedupeKey: string };
        create: CreatedAuditRow;
      }) {
        if (row?.dedupeKey === where.dedupeKey) return row;
        creates += 1;
        row = create;
        return row;
      },
    },
  } as unknown as PrismaService;
  return {
    service: new AuditService(prisma),
    row: () => row,
    creates: () => creates,
  };
}

test('task.created recording is idempotent across recovery retries', async () => {
  const harness = buildService();

  await harness.service.recordTaskCreated(TASK_ID, USER_A);
  await harness.service.recordTaskCreated(TASK_ID, USER_A);

  assert.equal(harness.creates(), 1);
  assert.deepEqual(harness.row(), {
    taskId: TASK_ID,
    userId: USER_A,
    type: 'task.created',
    level: 'info',
    resultCode: 201,
    title: '任务已创建',
    description: '任务已创建',
    dedupeKey: `task.created:${TASK_ID}`,
  });
});

test('a retry cannot replace the canonical creation owner', async () => {
  const harness = buildService();

  await harness.service.recordTaskCreated(TASK_ID, USER_A);
  await harness.service.recordTaskCreated(TASK_ID, USER_B);

  assert.equal(harness.creates(), 1);
  assert.equal(harness.row()?.userId, USER_A);
});
