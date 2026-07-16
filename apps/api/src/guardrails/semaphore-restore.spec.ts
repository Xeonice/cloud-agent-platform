import assert from 'node:assert/strict';
import test from 'node:test';
import { ConcurrencySemaphore } from './semaphore';

test('restoreRunning preserves every survivor even above a lowered ceiling', () => {
  const admitted: string[] = [];
  const semaphore = new ConcurrencySemaphore({
    maxConcurrentTasks: 1,
    onAdmit: (taskId) => admitted.push(taskId),
  });

  semaphore.restoreRunning('survivor-1');
  semaphore.restoreRunning('survivor-2');

  assert.deepEqual(semaphore.snapshotRunning(), ['survivor-1', 'survivor-2']);
  assert.equal(semaphore.runningCount, 2);
  assert.equal(semaphore.hasCapacity, false);
  assert.deepEqual(admitted, [], 'recovery must not invoke fresh-admission work');
});

test('restoreRunning removes a stale queued copy and converges before FIFO resumes', () => {
  const admitted: string[] = [];
  const semaphore = new ConcurrencySemaphore({
    maxConcurrentTasks: 1,
    onAdmit: (taskId) => admitted.push(taskId),
  });

  assert.equal(semaphore.offer('current'), 'running');
  assert.equal(semaphore.offer('survivor'), 'queued');
  assert.equal(semaphore.offer('next'), 'queued');

  semaphore.restoreRunning('survivor');

  assert.deepEqual(semaphore.snapshotRunning(), ['current', 'survivor']);
  assert.deepEqual(semaphore.snapshotQueue(), ['next']);
  assert.deepEqual(admitted, []);

  assert.equal(semaphore.release('current'), null);
  assert.deepEqual(semaphore.snapshotRunning(), ['survivor']);
  assert.deepEqual(semaphore.snapshotQueue(), ['next']);

  assert.equal(semaphore.release('survivor'), 'next');
  assert.deepEqual(semaphore.snapshotRunning(), ['next']);
  assert.deepEqual(admitted, ['next']);
});

test('restoreRunning is idempotent', () => {
  const semaphore = new ConcurrencySemaphore({ maxConcurrentTasks: 1 });

  semaphore.restoreRunning('survivor');
  semaphore.restoreRunning('survivor');

  assert.equal(semaphore.runningCount, 1);
  assert.deepEqual(semaphore.snapshotRunning(), ['survivor']);
});
