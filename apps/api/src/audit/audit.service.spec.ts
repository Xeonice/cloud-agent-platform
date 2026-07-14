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

test('structured runtime failure writes an actionable task.failed audit', async () => {
  let created: Omit<CreatedAuditRow, 'dedupeKey'> | null = null;
  const prisma = {
    user: {
      async findUnique({ where }: { where: { id: string } }) {
        return { id: where.id };
      },
    },
    auditEvent: {
      async create({ data }: { data: Omit<CreatedAuditRow, 'dedupeKey'> }) {
        created = data;
        return data;
      },
    },
  } as unknown as PrismaService;
  const service = new AuditService(prisma);
  const createdRow = (): Omit<CreatedAuditRow, 'dedupeKey'> | null => created;

  await service.recordTransition(TASK_ID, 'failed', USER_A, {
    code: 'runtime_auth_expired',
    runtime: 'claude-code',
    message: 'Claude Code 登录凭据已过期，请前往设置重新连接后创建新任务。',
    action: 'reconnect_runtime',
    occurredAt: new Date('2026-07-12T12:32:31.000Z'),
    exitCode: 1,
  });

  assert.equal(createdRow()?.type, 'task.failed');
  assert.equal(createdRow()?.level, 'error');
  assert.equal(createdRow()?.title, 'Claude Code 登录凭据已过期');
  assert.match(createdRow()?.description ?? '', /重新连接/);
});

test('model failure audits use fixed allowlisted text and redact supplied diagnostics', async () => {
  const created: Array<Omit<CreatedAuditRow, 'dedupeKey'>> = [];
  const prisma = {
    user: {
      async findUnique({ where }: { where: { id: string } }) {
        return { id: where.id };
      },
    },
    auditEvent: {
      async create({ data }: { data: Omit<CreatedAuditRow, 'dedupeKey'> }) {
        created.push(data);
        return data;
      },
    },
  } as unknown as PrismaService;
  const service = new AuditService(prisma);
  const unsafeDiagnostic =
    'selector=private/provider-model token=secret endpoint=https://private.invalid';

  await service.recordTransition(TASK_ID, 'failed', USER_A, {
    code: 'runtime_model_setup_failed',
    runtime: 'codex',
    message: unsafeDiagnostic,
    action: 'retry_task',
    occurredAt: new Date('2026-07-12T12:32:31.000Z'),
    exitCode: null,
  });
  await service.recordTransition(TASK_ID, 'failed', USER_A, {
    code: 'runtime_model_rejected',
    runtime: 'claude-code',
    message: unsafeDiagnostic,
    action: 'choose_another_model',
    occurredAt: new Date('2026-07-12T12:32:32.000Z'),
    exitCode: 1,
  });

  assert.deepEqual(
    created.map(({ title, description }) => ({ title, description })),
    [
      {
        title: 'Codex 模型准备失败',
        description: 'Codex 未能安全准备任务指定的模型，请重试任务或检查执行环境。',
      },
      {
        title: 'Claude Code 拒绝了指定模型',
        description: 'Claude Code 拒绝了任务指定的模型，请选择其他可用模型。',
      },
    ],
  );
  assert.equal(JSON.stringify(created).includes('private/provider-model'), false);
  assert.equal(JSON.stringify(created).includes('secret'), false);
  assert.equal(JSON.stringify(created).includes('private.invalid'), false);
});
