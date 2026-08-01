/**
 * Domain event publishing from the durable admission seams (add-domain-event-bus 4.12).
 *
 * A NEW file: publishing is new behaviour, and the existing durable-admission
 * specs are the characterization baseline for everything around it. Their
 * capacity fixture is re-created here rather than exported from them, so those
 * files stay byte-for-byte unchanged.
 *
 * Two publish points live in `TasksService`: the durable `TaskAdmitted` on a
 * committed reservation, and two of the three `TaskSuperseded` observation
 * points. Each assertion pairs "fired exactly once" with "payload parses".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DomainEventSchema,
  type DomainEvent,
  type DomainEventType,
} from '@cap-console/contracts';
import type { PrismaService } from '@/prisma/prisma.service';
import type { DomainEventBusPort } from '@/domain-events/domain-event-bus.port';
import { TasksService } from './tasks.service';

type TaskRow = {
  status: 'pending' | 'queued' | 'running' | 'awaiting_input' | 'failed';
  lifecycleVersion: number;
  createdAt: Date;
};

type WorkRow = {
  state: 'accepted' | 'queued' | 'running';
  leaseOwner: string;
  createdAt: Date;
};

type EventOfType<TType extends DomainEventType> = Extract<
  DomainEvent,
  { type: TType }
>;

/** `transitionForAdmission` types its token as a UUID, so this one is shaped like one. */
const TRANSITION_TOKEN = '55555555-5555-4555-8555-555555555555';

function recordingBus() {
  const published: DomainEvent[] = [];
  return {
    bus: {
      publish(event: DomainEvent) {
        published.push(event);
      },
      subscribe() {},
    } as DomainEventBusPort,
    published,
    of<TType extends DomainEventType>(type: TType): EventOfType<TType>[] {
      return published.filter(
        (event): event is EventOfType<TType> => event.type === type,
      );
    },
  };
}

function assertAllParse(published: readonly DomainEvent[]): void {
  for (const event of published) {
    DomainEventSchema.parse(event);
  }
}

/**
 * The capacity transaction, faked at the SQL boundary.
 *
 * Deliberately a re-creation of the fixture in
 * `tasks-durable-admission-capacity.spec.ts` rather than a shared import: that
 * file is part of the untouched baseline, and a test fixture is a cheaper thing
 * to duplicate than a characterization guarantee is to weaken.
 */
class AdmissionDb {
  readonly tasks = new Map<string, TaskRow>();
  readonly work = new Map<string, WorkRow>();
  ceiling: number | null = null;

  prisma(): PrismaService {
    return {
      $transaction: async <T>(operation: (tx: unknown) => Promise<T>) =>
        operation(this.transactionClient()),
    } as unknown as PrismaService;
  }

  private transactionClient() {
    const tasks = this.tasks;
    const workRows = this.work;
    const readCeiling = () => this.ceiling;
    return {
      systemSettings: {
        async findUnique() {
          const ceiling = readCeiling();
          return ceiling === null ? null : { maxConcurrentTasks: ceiling };
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
      async $executeRaw() {
        return 1;
      },
      async $queryRaw(query: {
        strings?: readonly string[];
        values?: readonly unknown[];
      }) {
        const sql = (query.strings ?? []).join('?');
        const values = query.values ?? [];
        if (sql.includes('AS "blocked"')) return [{ blocked: false }];
        if (sql.includes('AS occupied_slots')) {
          const occupied = [...tasks.values()].filter(
            (task) => task.status === 'running' || task.status === 'awaiting_input',
          ).length;
          return [{ occupied }];
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
            ? [{ status: task.status, lifecycleVersion: task.lifecycleVersion }]
            : [];
        }
        throw new Error(`unexpected SQL in publishing fixture: ${sql}`);
      },
    };
  }
}

function seed(
  db: AdmissionDb,
  taskId: string,
  status: TaskRow['status'] = 'pending',
) {
  db.tasks.set(taskId, {
    status,
    lifecycleVersion: 0,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  });
  db.work.set(taskId, {
    state: 'running',
    leaseOwner: `lease:${taskId}`,
    createdAt: new Date('2026-07-15T00:00:00.000Z'),
  });
}

/**
 * The bus is attached after construction rather than passed positionally.
 *
 * `TasksService` takes sixteen constructor parameters and every spec in this
 * directory builds it as `new TasksService(db.prisma())`; spelling out fourteen
 * `undefined`s to reach the trailing one would make this fixture harder to read
 * and would break the moment an optional collaborator is inserted before it. The
 * trailing-optional property itself is asserted structurally, below.
 */
function buildService(db: AdmissionDb, bus?: DomainEventBusPort): TasksService {
  const service = new TasksService(db.prisma());
  if (bus) Object.assign(service, { bus });
  return service;
}

function reserve(
  service: TasksService,
  taskId: string,
  expectedStatus: 'pending' | 'queued' | 'running' = 'pending',
) {
  return service.reserveDurableAdmissionCapacity({
    taskId,
    leaseToken: `lease:${taskId}`,
    expectedStatus,
    expectedLifecycleVersion: 0,
    fallbackMaxConcurrentTasks: 5,
    transitionToken: `transition:${taskId}`,
  });
}

test('a committed durable reservation publishes exactly one TaskAdmitted', async () => {
  const db = new AdmissionDb();
  seed(db, 'candidate');
  const recorder = recordingBus();

  const result = await reserve(buildService(db, recorder.bus), 'candidate');

  assert.equal(result.outcome, 'running');
  assertAllParse(recorder.published);
  const admitted = recorder.of('task.admitted');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.admissionMode, 'durable');
  assert.equal(admitted[0]?.outcome, 'running');
  assert.equal(admitted[0]?.taskId, 'candidate');
  // The transition token minted FOR THIS RESERVATION — never the lease token,
  // which belongs to the admission-work lease rather than to this transition.
  assert.equal(admitted[0]?.fenceToken, 'transition:candidate');
  assert.notEqual(admitted[0]?.fenceToken, 'lease:candidate');
});

test('a durable reservation held back by capacity publishes TaskAdmitted with the queued outcome', async () => {
  const db = new AdmissionDb();
  db.ceiling = 1;
  seed(db, 'occupied', 'running');
  seed(db, 'candidate');
  const recorder = recordingBus();

  const result = await reserve(buildService(db, recorder.bus), 'candidate');

  assert.equal(result.outcome, 'queued');
  assertAllParse(recorder.published);
  const admitted = recorder.of('task.admitted');
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0]?.outcome, 'queued');
  assert.equal(admitted[0]?.admissionMode, 'durable');
});

test('a superseded reservation publishes TaskSuperseded and no TaskAdmitted', async () => {
  const db = new AdmissionDb();
  // The authority row does not match: another actor moved the task on, so this
  // reservation observes that it lost.
  seed(db, 'candidate', 'running');
  db.tasks.get('candidate')!.lifecycleVersion = 7;
  const recorder = recordingBus();

  const result = await reserve(buildService(db, recorder.bus), 'candidate');

  assert.equal(result.outcome, 'superseded');
  assertAllParse(recorder.published);
  assert.equal(recorder.of('task.admitted').length, 0);

  const superseded = recorder.of('task.superseded');
  assert.equal(superseded.length, 1);
  assert.equal(
    superseded[0]?.observationPoint,
    'durable_capacity_reservation',
  );
  // What the LOSER held, and nothing about the winner.
  assert.equal(superseded[0]?.fenceToken, 'transition:candidate');
  assert.equal(superseded[0]?.taskId, 'candidate');
  assert.deepEqual(
    Object.keys(superseded[0] ?? {}).filter((key) =>
      /supersed(edBy|erTaskId)|winner/i.test(key),
    ),
    [],
  );
});

test('a reservation that finds the task already at its target publishes nothing', async () => {
  const db = new AdmissionDb();
  seed(db, 'candidate', 'running');
  const recorder = recordingBus();

  // Already `running` at the expected fence: nothing was transitioned here, so
  // this reservation admitted nothing and must not claim it did.
  const result = await reserve(
    buildService(db, recorder.bus),
    'candidate',
    'running',
  );

  assert.equal(result.outcome, 'running');
  assert.equal(recorder.of('task.admitted').length, 0);
  assert.equal(recorder.of('task.superseded').length, 0);
});

test('a reservation with no bus bound behaves identically', async () => {
  const db = new AdmissionDb();
  seed(db, 'candidate');

  const result = await reserve(buildService(db), 'candidate');

  assert.equal(result.outcome, 'running');
  assert.equal(db.tasks.get('candidate')?.status, 'running');
});

test('a throwing bus does not fail a committed reservation', async () => {
  const db = new AdmissionDb();
  seed(db, 'candidate');
  const service = buildService(db);
  Object.assign(service, {
    bus: {
      publish() {
        throw new Error('subscriber storm');
      },
      subscribe() {},
    } as DomainEventBusPort,
  });

  const result = await reserve(service, 'candidate');

  // The reservation had already committed before the publish ran; an observer
  // may not undo it.
  assert.equal(result.outcome, 'running');
  assert.equal(db.tasks.get('candidate')?.status, 'running');
});

test('a superseded admission transition publishes one TaskSuperseded carrying what it observed', async () => {
  const recorder = recordingBus();
  const service = new TasksService({
    task: {
      // Admission owns only pending -> queued/running and queued -> running. A
      // task observed as `failed` has been carried away by someone else.
      async findUnique() {
        return {
          status: 'failed',
          lifecycleVersion: 3,
          queuedAdmissionToken: null,
          runningAdmissionToken: null,
        };
      },
    },
  } as unknown as PrismaService);
  Object.assign(service, { bus: recorder.bus });

  const result = await service.transitionForAdmission(
    'candidate',
    'running',
    undefined,
    TRANSITION_TOKEN,
  );

  assert.equal(result, 'superseded');
  assertAllParse(recorder.published);
  const superseded = recorder.of('task.superseded');
  assert.equal(superseded.length, 1);
  assert.equal(
    superseded[0]?.observationPoint,
    'durable_admission_transition',
  );
  assert.equal(superseded[0]?.fenceToken, TRANSITION_TOKEN);
  // The status this attempt actually read — the most specific true thing an
  // observer of a lost race holds. Still not an identity.
  assert.equal(superseded[0]?.observedStatus, 'failed');
});

test('an admission transition that commits publishes no supersession', async () => {
  const recorder = recordingBus();
  let updated = false;
  const service = new TasksService({
    task: {
      async findUnique() {
        return updated
          ? {
              status: 'running',
              lifecycleVersion: 4,
              queuedAdmissionToken: null,
              runningAdmissionToken: TRANSITION_TOKEN,
            }
          : {
              status: 'pending',
              lifecycleVersion: 3,
              queuedAdmissionToken: null,
              runningAdmissionToken: null,
            };
      },
      async updateMany() {
        updated = true;
        return { count: 1 };
      },
    },
  } as unknown as PrismaService);
  Object.assign(service, { bus: recorder.bus });

  const result = await service.transitionForAdmission(
    'candidate',
    'running',
    undefined,
    TRANSITION_TOKEN,
  );

  assert.equal(result, 'transitioned');
  assert.equal(recorder.of('task.superseded').length, 0);
  // Admission events belong to the reservation seam, not to this CAS.
  assert.equal(recorder.of('task.admitted').length, 0);
});
