import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function makePty() {
  const calls = [];
  return {
    calls,
    pty: {
      pause: () => calls.push('pause'),
      resume: () => calls.push('resume'),
    },
  };
}

function makeTerminal() {
  const writes = [];
  return {
    writes,
    terminal: {
      cols: 80,
      rows: 24,
      write: (data) => writes.push(data),
      serialize: () => `snapshot:${writes.map(String).join('|')}`,
    },
  };
}

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cap-sandbox-terminal-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test('backpressure validates water marks and drives pause/resume hysteresis', () => {
  const defaults = new mod.BackpressureController();
  assert.equal(defaults.highWaterMark, mod.DEFAULT_HIGH_WATER_MARK);
  assert.equal(defaults.lowWaterMark, mod.DEFAULT_LOW_WATER_MARK);

  assert.throws(
    () => new mod.BackpressureController(undefined, { highWaterMark: 0 }),
    /highWaterMark must be in/,
  );
  assert.throws(
    () =>
      new mod.BackpressureController(undefined, {
        highWaterMark: 10,
        lowWaterMark: 10,
      }),
    /lowWaterMark must be in/,
  );

  const first = makePty();
  const controller = new mod.BackpressureController(first.pty, {
    highWaterMark: 10,
    lowWaterMark: 4,
  });
  assert.equal(controller.unacknowledgedBytes, 0);
  assert.equal(controller.isPaused, false);
  assert.equal(controller.onSent(5), 'none');
  assert.equal(controller.onSent(10), 'pause');
  assert.deepEqual(first.calls, ['pause']);
  assert.equal(controller.onSent(12), 'none');
  assert.equal(controller.onAck(3), 'none');
  assert.equal(controller.onAck(9), 'resume');
  assert.deepEqual(first.calls, ['pause', 'resume']);
  assert.equal(controller.onAck(8), 'none');
  assert.throws(() => controller.onSent(11), /sent seq must be monotonically/);

  const second = makePty();
  controller.setPty(second.pty);
  assert.equal(controller.onSent(19), 'pause');
  controller.reset();
  assert.deepEqual(second.calls, ['pause', 'resume']);
  assert.equal(controller.unacknowledgedBytes, 0);
  assert.equal(controller.isPaused, false);
});

await test('backpressure rebases reconnect offsets and resumes a paused producer', () => {
  const { calls, pty } = makePty();
  const controller = new mod.BackpressureController(pty, {
    highWaterMark: 8,
    lowWaterMark: 2,
  });
  assert.equal(controller.onSent(8), 'pause');
  controller.rebase(100);
  assert.deepEqual(calls, ['pause', 'resume']);
  assert.equal(controller.unacknowledgedBytes, 0);
  assert.equal(controller.onSent(105), 'none');
  assert.equal(controller.onAck(200), 'none');
  assert.equal(controller.unacknowledgedBytes, 0);
  assert.throws(() => controller.rebase(-1), /rebase seq must be a non-negative number/);
  assert.throws(() => controller.rebase(Number.NaN), /rebase seq must be a non-negative number/);
});

await test('session log tail sampling strips ANSI/control bytes and degrades for missing logs', async () => {
  await withTempWorkspace(async (dir) => {
    assert.equal(await mod.readSessionLogTail(dir), '');
    await writeFile(path.join(dir, mod.SESSION_LOG_FILENAME), '');
    assert.equal(await mod.readSessionLogTail(dir), '');
    await writeFile(
      path.join(dir, mod.SESSION_LOG_FILENAME),
      '\x1b[31mred\x1b[0m\n\n\x1b]0;title\x07named\r\nplain\x00text\n',
    );
    assert.equal(await mod.readSessionLogTail(dir), 'red\nnamed\nplaintext');
    await writeFile(
      path.join(dir, mod.SESSION_LOG_FILENAME),
      `${'x'.repeat(2100)}\n`,
    );
    assert.equal((await mod.readSessionLogTail(dir)).length, 2000);
    assert.equal(mod.stripAnsi('\x1b[32mok\x1b[0m\x07'), 'ok');
  });
});

await test('snapshot manager captures geometry and returns bounded fresh replay frames', async () => {
  await withTempWorkspace(async (dir) => {
    const { terminal, writes } = makeTerminal();
    const manager = new mod.SnapshotManager(terminal, dir, {
      now: () => 1234,
      freshReplayBytes: 5,
    });
    manager.feed('hello');
    manager.feed(new Uint8Array([0xe4, 0xb8, 0xad]));
    manager.feed('wide', 10);
    assert.equal(manager.currentOffset, 18);
    assert.deepEqual(writes.map((entry) => String(entry)), ['hello', '228,184,173', 'wide']);

    manager.resizeHeadless(100, 30);
    assert.equal(manager.cols, 100);
    assert.equal(manager.rows, 30);
    const snapshot = manager.capture();
    assert.deepEqual(mod.toSnapshotFrame(snapshot), {
      channel: 'control',
      type: 'snapshot',
      data: 'snapshot:hello|228,184,173|wide',
      cols: 100,
      rows: 30,
      seq: 18,
    });
    assert.equal(manager.latestSnapshot.seq, 18);

    await writeFile(path.join(dir, mod.SESSION_LOG_FILENAME), '0123456789');
    const fresh = await manager.buildReconnectFrames({ fromSeq: 0, chunkBytes: 2 });
    assert.deepEqual(
      fresh.map((frame) => [
        frame.type,
        Buffer.from(frame.data, 'base64').toString('utf8'),
        frame.seq,
        frame.final,
      ]),
      [
        ['tail_replay', '56', 7, false],
        ['tail_replay', '78', 9, false],
        ['tail_replay', '9', 10, true],
      ],
    );

    manager.start();
    manager.start();
    manager.stop();
    manager.stop();
  });
});

await test('snapshot reconnect uses latest snapshot for incremental clients and empty finals when logs are absent', async () => {
  await withTempWorkspace(async (dir) => {
    const { terminal } = makeTerminal();
    const defaultManager = new mod.SnapshotManager(terminal, dir);
    assert.deepEqual(await defaultManager.buildReconnectFrames(), [
      {
        channel: 'control',
        type: 'tail_replay',
        data: '',
        seq: 0,
        final: true,
      },
    ]);

    const manager = new mod.SnapshotManager(terminal, dir, {
      now: () => 5678,
    });
    assert.deepEqual(await manager.readTailFrames(50), [
      {
        channel: 'control',
        type: 'tail_replay',
        data: '',
        seq: 50,
        final: true,
      },
    ]);

    await writeFile(path.join(dir, mod.SESSION_LOG_FILENAME), 'abcdefghij');
    manager.feed('abcd');
    manager.capture();
    const incremental = await manager.buildReconnectFrames({ fromSeq: 2, chunkBytes: 3 });
    assert.equal(incremental[0].type, 'snapshot');
    assert.equal(incremental[0].seq, 4);
    assert.deepEqual(
      incremental.slice(1).map((frame) => [
        Buffer.from(frame.data, 'base64').toString('utf8'),
        frame.seq,
        frame.final,
      ]),
      [
        ['efg', 7, false],
        ['hij', 10, true],
      ],
    );

    const alreadyPastSnapshot = await manager.buildReconnectFrames({
      fromSeq: 8,
      chunkBytes: 16,
    });
    assert.deepEqual(
      alreadyPastSnapshot.map((frame) => [
        frame.type,
        Buffer.from(frame.data, 'base64').toString('utf8'),
        frame.seq,
        frame.final,
      ]),
      [['tail_replay', 'ij', 10, true]],
    );
    assert.deepEqual(await manager.readTailFrames(20), [
      {
        channel: 'control',
        type: 'tail_replay',
        data: '',
        seq: 10,
        final: true,
      },
    ]);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
