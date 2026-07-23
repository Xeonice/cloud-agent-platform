/**
 * chunk-archive-injection-with-progress (2.2) — the 1s-throttled snapshot
 * writer between per-part upload reports and the durable progress columns.
 *
 * Requirement: "sandbox-provider-port/Archive workspace transfer feeds the
 * provisioning progress snapshot" — writes are time-throttled to at most one
 * per second, and a failing write never propagates (progress is an output
 * stream, never authority). Legacy admission passes NO writer into the
 * progress chain, so silent skipping there is structural; these tests pin the
 * throttling and best-effort semantics of the writer the durable chain uses.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskAdmissionTransferProgress } from './task-admission.types';
import {
  createThrottledTransferProgressWriter,
  TRANSFER_PROGRESS_WRITE_INTERVAL_MS,
} from './transfer-progress-throttle';

function snapshot(receivedBytes: number): TaskAdmissionTransferProgress {
  return {
    percent: null,
    receivedObjects: null,
    totalObjects: null,
    receivedBytes,
    throughputBytesPerSecond: null,
  };
}

test('at most one write goes through per interval window', async () => {
  let nowMs = 0;
  const writes: number[] = [];
  const writer = createThrottledTransferProgressWriter({
    now: () => nowMs,
    write: async (_stage, progress) => {
      writes.push(progress.receivedBytes ?? -1);
    },
  });

  // Many per-part reports inside one second collapse to the first write.
  await writer('workspace_transfer', snapshot(1));
  nowMs = 200;
  await writer('workspace_transfer', snapshot(2));
  nowMs = 999;
  await writer('workspace_transfer', snapshot(3));
  assert.deepEqual(writes, [1]);

  // The next window admits exactly one more.
  nowMs = TRANSFER_PROGRESS_WRITE_INTERVAL_MS;
  await writer('workspace_transfer', snapshot(4));
  nowMs = TRANSFER_PROGRESS_WRITE_INTERVAL_MS + 500;
  await writer('workspace_transfer', snapshot(5));
  assert.deepEqual(writes, [1, 4]);
});

test('a failing write is swallowed and does not poison later windows', async () => {
  let nowMs = 0;
  let calls = 0;
  const writer = createThrottledTransferProgressWriter({
    now: () => nowMs,
    write: async () => {
      calls += 1;
      if (calls === 1) throw new Error('snapshot write lost the lease');
    },
  });

  await writer('workspace_transfer', snapshot(1));
  nowMs = TRANSFER_PROGRESS_WRITE_INTERVAL_MS + 1;
  await writer('workspace_transfer', snapshot(2));
  assert.equal(calls, 2);
});

test('a slow in-flight write suppresses concurrent reports instead of stacking', async () => {
  let nowMs = 0;
  let resolveWrite: (() => void) | null = null;
  const writes: number[] = [];
  const writer = createThrottledTransferProgressWriter({
    now: () => nowMs,
    write: (_stage, progress) =>
      new Promise<void>((resolve) => {
        writes.push(progress.receivedBytes ?? -1);
        resolveWrite = resolve;
      }),
  });

  const first = writer('workspace_transfer', snapshot(1));
  nowMs = TRANSFER_PROGRESS_WRITE_INTERVAL_MS * 2;
  await writer('workspace_transfer', snapshot(2));
  assert.deepEqual(writes, [1], 'no second write while one is in flight');
  (resolveWrite as unknown as () => void)();
  await first;
  nowMs = TRANSFER_PROGRESS_WRITE_INTERVAL_MS * 3;
  // The third report starts a fresh write whose promise must be resolved
  // before awaiting it — the mock hands back a new pending promise each time.
  const third = writer('workspace_transfer', snapshot(3));
  assert.deepEqual(writes, [1, 3]);
  (resolveWrite as unknown as () => void)();
  await third;
});
