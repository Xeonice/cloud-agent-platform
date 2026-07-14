import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OwnerFairProbeScheduler,
  RuntimeModelProbeAbortedError,
  RuntimeModelProbeCapacityError,
} from './owner-fair-probe-scheduler';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test('owner round-robin prevents one owner backlog from starving another', async () => {
  const scheduler = new OwnerFairProbeScheduler({
    globalConcurrency: 1,
    perOwnerConcurrency: 1,
    globalQueueLimit: 16,
    perOwnerQueueLimit: 8,
    queueWaitTimeoutMs: 1_000,
  });
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: string[] = [];
  const run = (owner: string, label: string, index: number) =>
    scheduler.run(owner, async () => {
      started.push(label);
      await gates[index]!.promise;
      return label;
    });

  const a1 = run('owner-a', 'a1', 0);
  await turn();
  const a2 = run('owner-a', 'a2', 1);
  const a3 = run('owner-a', 'a3', 2);
  const b1 = run('owner-b', 'b1', 3);
  gates[0]!.resolve();
  await turn();
  assert.deepEqual(started, ['a1', 'a2']);
  gates[1]!.resolve();
  await turn();
  assert.deepEqual(started, ['a1', 'a2', 'b1']);
  gates[3]!.resolve();
  await turn();
  assert.deepEqual(started, ['a1', 'a2', 'b1', 'a3']);
  gates[2]!.resolve();
  assert.deepEqual(await Promise.all([a1, a2, a3, b1]), [
    'a1',
    'a2',
    'a3',
    'b1',
  ]);
});

test('queued cancellation removes work before an operation is created', async () => {
  const scheduler = new OwnerFairProbeScheduler({
    globalConcurrency: 1,
    perOwnerConcurrency: 1,
    globalQueueLimit: 4,
    perOwnerQueueLimit: 2,
    queueWaitTimeoutMs: 1_000,
  });
  const active = deferred();
  const running = scheduler.run('owner-a', () => active.promise);
  await turn();
  let queuedCalls = 0;
  const controller = new AbortController();
  const queued = scheduler.run(
    'owner-b',
    async () => {
      queuedCalls += 1;
    },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(queued, RuntimeModelProbeAbortedError);
  assert.equal(queuedCalls, 0);
  active.resolve();
  await running;
});

test('owner queue limits and wait timeout return stable scoped capacity', async () => {
  const scheduler = new OwnerFairProbeScheduler({
    globalConcurrency: 1,
    perOwnerConcurrency: 1,
    globalQueueLimit: 4,
    perOwnerQueueLimit: 1,
    queueWaitTimeoutMs: 20,
    retryAfterMs: 50,
  });
  const active = deferred();
  const running = scheduler.run('owner-a', () => active.promise);
  await turn();
  const queued = scheduler.run('owner-a', async () => undefined);
  await assert.rejects(
    scheduler.run('owner-a', async () => undefined),
    (error: unknown) =>
      error instanceof RuntimeModelProbeCapacityError &&
      error.scope === 'owner' &&
      error.retryAfterMs === 50,
  );
  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof RuntimeModelProbeCapacityError &&
      error.scope === 'owner',
  );
  active.resolve();
  await running;
});

test('invalid concurrency configuration cannot let one owner occupy every global slot', () => {
  assert.throws(
    () =>
      new OwnerFairProbeScheduler({
        globalConcurrency: 2,
        perOwnerConcurrency: 2,
        globalQueueLimit: 4,
        perOwnerQueueLimit: 2,
        queueWaitTimeoutMs: 100,
      }),
    /cross-owner slot/,
  );
});
