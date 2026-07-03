/**
 * Focused regression coverage for fix-terminal-readoption-history.
 *
 * Drives the compiled TerminalGateway private append seams directly: these are
 * TypeScript-private (not #private) methods, so the built JS still exposes them.
 * The test avoids Nest networking and asserts the durable files that users see
 * after refresh/re-enter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CAP_TERMINAL_RESIZE_REPAINT_QUIESCE_MS = '15';
process.env.CAP_TERMINAL_RESIZE_REPAINT_MAX_MS = '50';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');
const { TerminalGateway } = await import(path.join(dist, 'terminal.gateway.js'));
const { SESSION_LOG_FILENAME, SESSION_CAST_FILENAME } = await import(
  path.join(dist, 'snapshot.js')
);
const { parseCast } = await import('@cap/contracts');

function makePty() {
  const resizes = [];
  const writes = [];
  return {
    resizes,
    writes,
    onData() {
      return { dispose() {} };
    },
    write(data) {
      writes.push(data);
    },
    resize(cols, rows) {
      resizes.push([cols, rows]);
    },
    pause() {},
    resume() {},
  };
}

function makeSnapshots() {
  const feeds = [];
  return {
    feeds,
    manager: {
      cols: 80,
      rows: 24,
      feed: (chunk, byteLen) => feeds.push({ chunk, byteLen }),
      resizeHeadless() {},
      start() {},
      stop() {},
      buildReconnectFrames: async () => [],
    },
  };
}

function makeClient() {
  const frames = [];
  return {
    frames,
    socket: {
      readyState: 1,
      OPEN: 1,
      send: (text) => frames.push(JSON.parse(text)),
    },
  };
}

function makeClientState(taskId) {
  const sent = [];
  return {
    sent,
    state: {
      clientId: 'client-readoption-meta',
      kind: 'operator',
      authenticated: true,
      taskId,
      ptySubscription: null,
      sentBytes: 0,
      backpressure: {
        onSent: (seq) => {
          sent.push(seq);
          return undefined;
        },
        onAck: () => undefined,
        rebase() {},
        setPty() {},
      },
    },
  };
}

async function flushLog(gateway, taskId) {
  const entry = gateway.sessionLogs.get(taskId);
  if (entry) await entry.tail;
}

async function flushCast(gateway, taskId) {
  const entry = gateway.sessionCasts.get(taskId);
  if (entry) await entry.tail;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('non-recordable re-adoption output is streamed-only and does not advance durable history', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-readoption-history-'));
  const taskId = 'task-readoption-meta';
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    const { manager, feeds } = makeSnapshots();
    gateway.sessions.set(taskId, {
      taskId,
      pty: makePty(),
      snapshots: manager,
    });
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
    });
    const { frames, socket } = makeClient();
    const { sent, state } = makeClientState(taskId);
    gateway.clients.set(socket, state);
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onPtyOutput(taskId, 'duplicate session\r\n', {
      recordable: false,
      source: 'attach-bootstrap',
    });
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(existsSync(logPath), false);
    let cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.equal(parseCast(cast).events.length, 0);
    assert.deepEqual(feeds, [
      { chunk: 'duplicate session\r\n', byteLen: 0 },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].seq, 0);
    assert.equal(Buffer.from(frames[0].data, 'base64').toString('utf8'), 'duplicate session\r\n');
    assert.deepEqual(sent, []);

    gateway.onPtyOutput(taskId, 'real output\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(await readFile(logPath, 'utf8'), 'real output\r\n');
    cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(parseCast(cast).events.map((event) => event[2]), [
      'real output\r\n',
    ]);
    assert.deepEqual(feeds, [
      { chunk: 'duplicate session\r\n', byteLen: 0 },
      { chunk: 'real output\r\n', byteLen: Buffer.byteLength('real output\r\n') },
    ]);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].seq, Buffer.byteLength('real output\r\n'));
    assert.equal(Buffer.from(frames[1].data, 'base64').toString('utf8'), 'real output\r\n');
    assert.deepEqual(sent, [Buffer.byteLength('real output\r\n')]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('resize repaint output is streamed-only and does not advance durable history', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-resize-repaint-history-'));
  const taskId = 'task-resize-repaint';
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    const { manager, feeds } = makeSnapshots();
    const pty = makePty();
    gateway.sessions.set(taskId, {
      taskId,
      pty,
      snapshots: manager,
    });
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
    });
    const { frames, socket } = makeClient();
    const { sent, state } = makeClientState(taskId);
    gateway.clients.set(socket, state);
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onResize({ cols: 120, rows: 20 }, state);
    gateway.onPtyOutput(taskId, 'old visible screen repaint\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.deepEqual(pty.resizes, [[120, 20]]);
    assert.equal(existsSync(logPath), false);
    let cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(
      parseCast(cast).events.map((event) => [event[1], event[2]]),
      [['r', '120x20']],
    );
    assert.deepEqual(feeds, [
      { chunk: 'old visible screen repaint\r\n', byteLen: 0 },
    ]);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].seq, 0);
    assert.equal(
      Buffer.from(frames[0].data, 'base64').toString('utf8'),
      'old visible screen repaint\r\n',
    );
    assert.deepEqual(sent, []);

    await delay(25);
    gateway.onPtyOutput(taskId, 'real output after resize\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(await readFile(logPath, 'utf8'), 'real output after resize\r\n');
    cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(
      parseCast(cast).events.map((event) => [event[1], event[2]]),
      [
        ['r', '120x20'],
        ['o', 'real output after resize\r\n'],
      ],
    );
    assert.deepEqual(feeds, [
      { chunk: 'old visible screen repaint\r\n', byteLen: 0 },
      {
        chunk: 'real output after resize\r\n',
        byteLen: Buffer.byteLength('real output after resize\r\n'),
      },
    ]);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].seq, Buffer.byteLength('real output after resize\r\n'));
    assert.deepEqual(sent, [Buffer.byteLength('real output after resize\r\n')]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('operator input ends resize repaint suppression before durable output resumes', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-resize-input-history-'));
  const taskId = 'task-resize-input';
  try {
    const gateway = new TerminalGateway({
      isWriter: (sessionId, clientId) =>
        sessionId === taskId && clientId === 'client-readoption-meta',
    });
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    const { manager, feeds } = makeSnapshots();
    const pty = makePty();
    gateway.sessions.set(taskId, {
      taskId,
      pty,
      snapshots: manager,
    });
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
    });
    const { frames, socket } = makeClient();
    const { sent, state } = makeClientState(taskId);
    gateway.clients.set(socket, state);
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onResize({ cols: 120, rows: 20 }, state);
    gateway.onPtyOutput(taskId, 'old visible screen repaint\r\n');
    gateway.onKeystroke(
      {
        sessionId: taskId,
        data: Buffer.from('soak-01\r').toString('base64'),
      },
      socket,
      state,
    );
    gateway.onPtyOutput(taskId, 'PROVIDER_STORY_ECHO:soak-01\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.deepEqual(pty.resizes, [[120, 20]]);
    assert.deepEqual(pty.writes, ['soak-01\r']);
    assert.equal(await readFile(logPath, 'utf8'), 'PROVIDER_STORY_ECHO:soak-01\r\n');
    const cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(
      parseCast(cast).events.map((event) => [event[1], event[2]]),
      [
        ['r', '120x20'],
        ['o', 'PROVIDER_STORY_ECHO:soak-01\r\n'],
      ],
    );
    assert.deepEqual(feeds, [
      { chunk: 'old visible screen repaint\r\n', byteLen: 0 },
      {
        chunk: 'PROVIDER_STORY_ECHO:soak-01\r\n',
        byteLen: Buffer.byteLength('PROVIDER_STORY_ECHO:soak-01\r\n'),
      },
    ]);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].seq, 0);
    assert.equal(frames[1].seq, Buffer.byteLength('PROVIDER_STORY_ECHO:soak-01\r\n'));
    assert.deepEqual(sent, [Buffer.byteLength('PROVIDER_STORY_ECHO:soak-01\r\n')]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('session.cast resumes without appending a second header and keeps monotonic event time', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-cast-resume-'));
  const taskId = 'task-cast-resume';
  try {
    const first = new TerminalGateway();
    first.armCast(taskId, workspaceDir, 80, 24);
    first.appendCast(taskId, 'first\r\n');
    await flushCast(first, taskId);

    const second = new TerminalGateway();
    second.armCast(taskId, workspaceDir, 120, 40);
    second.appendCast(taskId, 'second\r\n');
    await flushCast(second, taskId);

    const cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    const headerCount = cast
      .split('\n')
      .filter((line) => line.includes('"version":2')).length;
    const parsed = parseCast(cast);

    assert.equal(headerCount, 1);
    assert.deepEqual(parsed.events.map((event) => event[2]), [
      'first\r\n',
      'second\r\n',
    ]);
    assert.ok(parsed.events[1][0] >= parsed.events[0][0]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
