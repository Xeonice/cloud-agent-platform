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

test('normal cancellation and terminal recovery share one durable audit identity', async () => {
  const harness = buildService();

  await harness.service.recordTransition(TASK_ID, 'cancelled', USER_A);
  assert.equal(await harness.service.recordTaskCancellation(TASK_ID), true);

  assert.equal(harness.creates(), 1);
  assert.deepEqual(harness.row(), {
    taskId: TASK_ID,
    userId: USER_A,
    type: 'task.cancelled',
    level: 'info',
    resultCode: 200,
    title: '任务已取消',
    description: '任务已取消',
    dedupeKey: `task.cancelled:${TASK_ID}`,
  });
});

test('provisioning progress is idempotent per attempt/stage and contains only safe fields', async () => {
  const rows = new Map<string, CreatedAuditRow>();
  const prisma = {
    auditEvent: {
      async upsert({
        where,
        create,
      }: {
        where: { dedupeKey: string };
        create: CreatedAuditRow;
      }) {
        const existing = rows.get(where.dedupeKey);
        if (existing) return existing;
        rows.set(where.dedupeKey, create);
        return create;
      },
    },
  } as unknown as PrismaService;
  const service = new AuditService(prisma);

  await service.recordProvisioningProgress(TASK_ID, 'workspace_transfer', 2);
  await service.recordProvisioningProgress(TASK_ID, 'workspace_transfer', 2);
  await service.recordProvisioningProgress(TASK_ID, 'checkout', 2);

  assert.equal(rows.size, 2, 'lease replay does not duplicate a checkpoint');
  assert.deepEqual(
    [...rows.values()].map((row) => ({
      type: row.type,
      level: row.level,
      resultCode: row.resultCode,
      description: row.description,
    })),
    [
      {
        type: 'task.provisioning:workspace_transfer',
        level: 'info',
        resultCode: 200,
        description: '置备阶段：传输仓库工作区；尝试次数：2',
      },
      {
        type: 'task.provisioning:checkout',
        level: 'info',
        resultCode: 200,
        description: '置备阶段：检出分支；尝试次数：2',
      },
    ],
  );
  const serialized = JSON.stringify([...rows.values()]);
  for (const forbidden of [
    'leaseOwner',
    'providerSandboxId',
    'authorization',
    'credential',
    'git clone',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('terminal provisioning audit writes one safe central event and one deduped detail', async () => {
  const rows = new Map<string, CreatedAuditRow>();
  const prisma = {
    auditEvent: {
      async upsert({
        where,
        create,
      }: {
        where: { dedupeKey: string };
        create: CreatedAuditRow;
      }) {
        const existing = rows.get(where.dedupeKey);
        if (existing) return existing;
        rows.set(where.dedupeKey, create);
        return create;
      },
    },
  } as unknown as PrismaService;
  const service = new AuditService(prisma);
  const unsafeCanary =
    'Bearer secret-canary https://provider.invalid git -c http.extraHeader=...';
  const failure = {
    code: 'provisioning_capacity_exhausted' as const,
    message: unsafeCanary,
    action: 'increase_sandbox_capacity' as const,
    occurredAt: new Date('2026-07-15T00:00:00.000Z'),
  };

  assert.equal(
    await service.recordProvisioningFailure(
      TASK_ID,
      'workspace_transfer',
      3,
      failure,
    ),
    true,
  );
  assert.equal(
    await service.recordProvisioningFailure(
      TASK_ID,
      'workspace_transfer',
      4,
      failure,
    ),
    true,
  );

  assert.equal(rows.size, 2, 'terminal replay retains one central/detail pair');
  const central = rows.get(`task.failed:provisioning:${TASK_ID}`);
  const detail = rows.get(`task.provisioning.failed:${TASK_ID}`);
  assert.equal(central?.type, 'task.failed');
  assert.equal(detail?.type, 'task.provisioning.failed:provisioning_capacity_exhausted');
  assert.match(detail?.description ?? '', /传输仓库工作区.*尝试次数：3.*存储空间不足/);
  const serialized = JSON.stringify([...rows.values()]);
  assert.equal(serialized.includes('secret-canary'), false);
  assert.equal(serialized.includes('provider.invalid'), false);
  assert.equal(serialized.includes('extraHeader'), false);
});

test('progress audit swallows persistence failure while terminal audit reports it', async () => {
  const unsafeCanary =
    'Bearer secret-canary https://provider.invalid git -c http.extraHeader=...';
  const service = new AuditService({
    auditEvent: {
      async upsert() {
        throw new Error(unsafeCanary);
      },
    },
  } as unknown as PrismaService);
  const warnings: string[] = [];
  Object.assign(service as unknown as { logger: object }, {
    logger: {
      warn(message: unknown) {
        warnings.push(String(message));
      },
    },
  });

  await assert.doesNotReject(() =>
    service.recordProvisioningProgress(TASK_ID, 'sandbox_creation', 1),
  );
  assert.equal(
    await service.recordProvisioningFailure(
      TASK_ID,
      'sandbox_creation',
      1,
      {
        code: 'provisioning_unknown',
        message: 'ignored',
        action: 'retry_task',
        occurredAt: new Date('2026-07-15T00:00:00.000Z'),
      },
    ),
    false,
  );
  assert.equal(await service.recordTaskCancellation(TASK_ID), false);
  const serializedWarnings = JSON.stringify(warnings);
  assert.equal(serializedWarnings.includes('secret-canary'), false);
  assert.equal(serializedWarnings.includes('provider.invalid'), false);
  assert.equal(serializedWarnings.includes('extraHeader'), false);
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

test('failure audits use fixed allowlisted text and redact supplied diagnostics', async () => {
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
  await service.recordTransition(TASK_ID, 'failed', USER_A, {
    code: 'provisioning_capacity_exhausted',
    message: unsafeDiagnostic,
    action: 'increase_sandbox_capacity',
    occurredAt: new Date('2026-07-12T12:32:33.000Z'),
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
      {
        title: '沙箱存储空间不足',
        description: '沙箱存储空间不足，请增加磁盘容量后重试任务。',
      },
    ],
  );
  assert.equal(JSON.stringify(created).includes('private/provider-model'), false);
  assert.equal(JSON.stringify(created).includes('secret'), false);
  assert.equal(JSON.stringify(created).includes('private.invalid'), false);
});
