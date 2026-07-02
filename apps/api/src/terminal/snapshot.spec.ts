import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SESSION_LOG_FILENAME,
  SnapshotManager,
  type HeadlessTerminal,
} from './snapshot';

class FakeTerminal implements HeadlessTerminal {
  cols = 80;
  rows = 24;
  private data = '';

  write(data: string | Uint8Array): void {
    this.data += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  }

  serialize(): string {
    return `SNAP:${this.data}`;
  }
}

async function withWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cap-snapshot-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function decodeTail(frames: Awaited<ReturnType<SnapshotManager['buildReconnectFrames']>>): string {
  return frames
    .filter((frame) => frame.type === 'tail_replay')
    .map((frame) => Buffer.from(frame.data, 'base64').toString('utf8'))
    .join('');
}

function lastSeq(
  frames: Awaited<ReturnType<SnapshotManager['buildReconnectFrames']>>,
): number | undefined {
  let seq: number | undefined;
  for (const frame of frames) {
    if ('seq' in frame) seq = frame.seq;
  }
  return seq;
}

test('fresh reconnect without a cast uses latest snapshot instead of raw TUI log history', async () => {
  await withWorkspace(async (dir) => {
    const log = 'line-1\nline-2\nline-3\n';
    await writeFile(path.join(dir, SESSION_LOG_FILENAME), log);

    const manager = new SnapshotManager(new FakeTerminal(), dir, {
      freshReplayBytes: 1024,
    });
    manager.feed(log, Buffer.byteLength(log));
    manager.capture();

    const frames = await manager.buildReconnectFrames({ fromSeq: 0, chunkBytes: 8 });

    assert.equal(frames[0]?.type, 'snapshot');
    assert.equal(frames[0]?.data, `SNAP:${log}`);
    assert.equal(decodeTail(frames), '');
    const last = frames.at(-1);
    assert.equal(last?.type, 'tail_replay');
    if (last?.type !== 'tail_replay') assert.fail('expected final tail_replay');
    assert.equal(last.final, true);
    assert.equal(last.seq, Buffer.byteLength(log));
  });
});

test('fresh reconnect without a cast or snapshot does not replay raw TUI log history', async () => {
  await withWorkspace(async (dir) => {
    await writeFile(path.join(dir, SESSION_LOG_FILENAME), '0123456789');

    const manager = new SnapshotManager(new FakeTerminal(), dir, {
      freshReplayBytes: 4,
    });

    const frames = await manager.buildReconnectFrames({ fromSeq: 0, chunkBytes: 8 });

    assert.equal(frames[0]?.type, 'snapshot');
    assert.equal(decodeTail(frames), '');
    assert.equal(lastSeq(frames), 10);
  });
});

test('fresh reconnect captures the current headless frame immediately before the periodic snapshot', async () => {
  await withWorkspace(async (dir) => {
    const before = 'visible current frame\n';
    await writeFile(path.join(dir, SESSION_LOG_FILENAME), before);

    const manager = new SnapshotManager(new FakeTerminal(), dir);
    manager.feed(before, Buffer.byteLength(before));

    const frames = await manager.buildReconnectFrames({ fromSeq: 0 });

    assert.equal(frames[0]?.type, 'snapshot');
    assert.equal(frames[0]?.data, `SNAP:${before}`);
    assert.equal(decodeTail(frames), '');
    assert.equal(lastSeq(frames), Buffer.byteLength(before));
  });
});

test('incremental reconnect still uses snapshot plus tail', async () => {
  await withWorkspace(async (dir) => {
    const before = 'before snapshot\n';
    const after = 'after snapshot\n';
    await writeFile(path.join(dir, SESSION_LOG_FILENAME), before + after);

    const manager = new SnapshotManager(new FakeTerminal(), dir);
    manager.feed(before, Buffer.byteLength(before));
    const snapshot = manager.capture();

    const frames = await manager.buildReconnectFrames({ fromSeq: 1 });

    assert.equal(frames[0]?.type, 'snapshot');
    assert.equal(frames[0]?.data, snapshot.data);
    assert.equal(decodeTail(frames), after);
  });
});
