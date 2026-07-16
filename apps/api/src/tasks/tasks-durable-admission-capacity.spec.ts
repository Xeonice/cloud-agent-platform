import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { TasksService } from './tasks.service';

type TaskRow = {
  status:
    | 'pending'
    | 'queued'
    | 'running'
    | 'awaiting_input'
    | 'failed'
    | 'cancelled';
  lifecycleVersion: number;
  createdAt: Date;
};

type WorkRow = {
  state: 'accepted' | 'queued' | 'running';
  leaseOwner: string;
  createdAt: Date;
};

class SharedAdmissionDb {
  readonly tasks = new Map<string, TaskRow>();
  readonly work = new Map<string, WorkRow>();
  readonly activeSandboxOwners = new Set<string>();
  ceiling: number | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  prisma(): PrismaService {
    return {
      $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => {
        let release!: () => void;
        const predecessor = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await predecessor;
        try {
          return await operation(this.transactionClient());
        } finally {
          release();
        }
      },
    } as unknown as PrismaService;
  }

  private transactionClient() {
    const tasks = this.tasks;
    const workRows = this.work;
    const activeSandboxOwners = this.activeSandboxOwners;
    const readCeiling = () => this.ceiling;
    return {
      systemSettings: {
        async findUnique() {
          const ceiling = readCeiling();
          return ceiling === null
            ? null
            : { maxConcurrentTasks: ceiling };
        },
      },
      task: {
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; status: string; lifecycleVersion: number };
          data: {
            status: TaskRow['status'];
            lifecycleVersion: { increment: number };
          };
        }) {
          const task = tasks.get(where.id);
          if (
            !task ||
            task.status !== where.status ||
            task.lifecycleVersion !== where.lifecycleVersion
          ) {
            return { count: 0 };
          }
          task.status = data.status;
          task.lifecycleVersion += data.lifecycleVersion.increment;
          return { count: 1 };
        },
      },
      async $queryRaw(query: { strings?: readonly string[]; values?: readonly unknown[] }) {
        const sql = (query.strings ?? []).join('?');
        const values = query.values ?? [];
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('AS "blocked"')) {
          const taskId = values.find(
            (value): value is string =>
              typeof value === 'string' && tasks.has(value),
          );
          assert(taskId);
          const current = workRows.get(taskId);
          assert(current);
          const blocked = [...workRows.entries()].some(([olderId, older]) => {
            const olderTask = tasks.get(olderId);
            if (!olderTask || !['pending', 'queued'].includes(olderTask.status)) {
              return false;
            }
            if (!['accepted', 'queued', 'running'].includes(older.state)) {
              return false;
            }
            return (
              older.createdAt < current.createdAt ||
              (older.createdAt.getTime() === current.createdAt.getTime() &&
                olderId < taskId)
            );
          });
          return [{ blocked }];
        }
        if (sql.includes('AS occupied_slots')) {
          const occupied = new Set(activeSandboxOwners);
          for (const [taskId, task] of tasks) {
            if (
              task.status === 'running' ||
              task.status === 'awaiting_input'
            ) {
              occupied.add(taskId);
            }
          }
          return [{ occupied: occupied.size }];
        }
        if (sql.includes('FOR UPDATE OF t, w')) {
          const taskId = values.find(
            (value): value is string =>
              typeof value === 'string' && tasks.has(value),
          );
          assert(taskId);
          const task = tasks.get(taskId)!;
          const work = workRows.get(taskId)!;
          const strings = values.filter(
            (value): value is string => typeof value === 'string',
          );
          const expectedStatus = strings.find((value) =>
            ['pending', 'queued', 'running'].includes(value),
          );
          const leaseToken = strings.find((value) => value.startsWith('lease:'));
          const expectedVersion = values.find(
            (value): value is number => typeof value === 'number',
          );
          return task.status === expectedStatus &&
            task.lifecycleVersion === expectedVersion &&
            work.state === 'running' &&
            work.leaseOwner === leaseToken
            ? [
                {
                  status: task.status,
                  lifecycleVersion: task.lifecycleVersion,
                },
              ]
            : [];
        }
        throw new Error(`unexpected SQL in capacity fixture: ${sql}`);
      },
    };
  }
}

function seed(
  db: SharedAdmissionDb,
  taskId: string,
  createdAt: string,
  status: TaskRow['status'] = 'pending',
) {
  db.tasks.set(taskId, {
    status,
    lifecycleVersion: 0,
    createdAt: new Date(createdAt),
  });
  db.work.set(taskId, {
    state: 'running',
    leaseOwner: `lease:${taskId}`,
    createdAt: new Date(createdAt),
  });
}

function reserve(service: TasksService, taskId: string, fallback = 5) {
  return service.reserveDurableAdmissionCapacity({
    taskId,
    leaseToken: `lease:${taskId}`,
    expectedStatus: 'pending',
    expectedLifecycleVersion: 0,
    fallbackMaxConcurrentTasks: fallback,
    transitionToken: `transition:${taskId}`,
  });
}

test('shared SystemSettings ceiling wins over a stale replica fallback inside the capacity transaction', async () => {
  const db = new SharedAdmissionDb();
  db.ceiling = 1;
  seed(db, 'occupied', '2026-07-15T00:00:00.000Z', 'running');
  seed(db, 'candidate', '2026-07-15T00:00:01.000Z');

  const result = await reserve(new TasksService(db.prisma()), 'candidate', 5);

  assert.equal(result.outcome, 'queued');
  assert.equal(db.tasks.get('candidate')?.status, 'queued');
});

test('an out-of-contract persisted ceiling cannot over-admit and falls back consistently', async () => {
  const db = new SharedAdmissionDb();
  db.ceiling = 21;
  seed(db, 'occupied', '2026-07-15T00:00:00.000Z', 'running');
  seed(db, 'candidate', '2026-07-15T00:00:01.000Z');

  const result = await reserve(new TasksService(db.prisma()), 'candidate', 1);

  assert.equal(result.outcome, 'queued');
  assert.equal(db.tasks.get('candidate')?.status, 'queued');
});

test('a terminal task with generation cleanup still pending retains its global slot', async () => {
  const db = new SharedAdmissionDb();
  db.ceiling = 1;
  seed(db, 'cleanup-pending', '2026-07-15T00:00:00.000Z', 'failed');
  db.work.get('cleanup-pending')!.state = 'accepted';
  db.activeSandboxOwners.add('cleanup-pending');
  seed(db, 'candidate', '2026-07-15T00:00:01.000Z');

  const result = await reserve(new TasksService(db.prisma()), 'candidate', 1);

  assert.equal(result.outcome, 'queued');
  assert.equal(db.tasks.get('candidate')?.status, 'queued');
});

test('capacity promotion is FIFO even when the newer claimed worker reaches the DB lock first', async () => {
  const db = new SharedAdmissionDb();
  db.ceiling = 1;
  seed(db, 'older', '2026-07-15T00:00:00.000Z');
  seed(db, 'newer', '2026-07-15T00:00:01.000Z');
  const replicaOne = new TasksService(db.prisma());
  const replicaTwo = new TasksService(db.prisma());

  const newer = await reserve(replicaTwo, 'newer', 20);
  const older = await reserve(replicaOne, 'older', 20);

  assert.equal(newer.outcome, 'queued');
  assert.equal(older.outcome, 'running');
  assert.equal(db.tasks.get('older')?.status, 'running');
  assert.equal(db.tasks.get('newer')?.status, 'queued');
  assert.equal(
    [...db.tasks.values()].filter((task) => task.status === 'running').length,
    1,
  );
});
