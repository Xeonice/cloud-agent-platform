/** Owner-recording/readoption regressions for the native viewer topology. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CAP_TERMINAL_RESIZE_REPAINT_QUIESCE_MS = '15';
process.env.CAP_TERMINAL_RESIZE_REPAINT_MAX_MS = '50';
process.env.CAP_TERMINAL_RAW_LOG_RECORDING_ENABLED = 'true';
process.env.CAP_TERMINAL_RAW_CAST_RECORDING_ENABLED = 'true';
process.env.CAP_TERMINAL_RAW_LOG_MAX_BYTES = '4096';
process.env.CAP_TERMINAL_RAW_CAST_MAX_BYTES = '4096';
process.env.CAP_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES = '32';

const RAW_LOG_BUDGET = Number(process.env.CAP_TERMINAL_RAW_LOG_MAX_BYTES);
const RAW_PENDING_WRITE_BUDGET = Number(
  process.env.CAP_TERMINAL_RAW_RECORDING_MAX_PENDING_WRITES,
);

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/terminal');
const { TerminalGateway } = await import(path.join(dist, 'terminal.gateway.js'));
const { SESSION_LOG_FILENAME, SESSION_CAST_FILENAME } = await import(
  path.join(dist, 'snapshot.js')
);
const { parseCast } = await import('@cap-console/contracts');

function makeOwner() {
  const resizes = [];
  const writes = [];
  return {
    resizes,
    writes,
    launchDecision: Promise.resolve({ kind: 'attached' }),
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
    close() {},
  };
}

function makeAttachment() {
  const writes = [];
  const resizes = [];
  return {
    writes,
    resizes,
    opaqueInputCapability: 'byte-preserving',
    attachmentDecision: Promise.resolve({ kind: 'ready' }),
    onData() {
      return { dispose() {} };
    },
    onClose() {
      return { dispose() {} };
    },
    onError() {
      return { dispose() {} };
    },
    write(bytes) {
      writes.push(Buffer.from(bytes));
      return 'written';
    },
    resize(cols, rows) {
      resizes.push([cols, rows]);
    },
    pause() {},
    resume() {},
    close() {},
  };
}

function installSession(gateway, taskId, owner = makeOwner()) {
  const session = {
    taskId,
    ownerPty: owner,
    viewerFactory: { open: () => { throw new Error('not used'); } },
    geometry: { cols: 80, rows: 24 },
    launchDecision: owner.launchDecision,
  };
  gateway.sessions.set(taskId, session);
  return { session, owner };
}

function makeAttachedClient(taskId, attachment = makeAttachment()) {
  const frames = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send: (text) => frames.push(JSON.parse(text)),
    close() {},
  };
  const state = {
    clientId: 'client-readoption-meta',
    kind: 'operator',
    authenticated: true,
    principalIdentity: { kind: 'session', userId: 'user-1', keyId: null },
    requestedTaskId: taskId,
    phase: 'attached',
    binding: {
      principalIdentity: { kind: 'session', userId: 'user-1', keyId: null },
      boundTaskId: taskId,
      generation: 1,
    },
    generation: 1,
    authAttemptEpoch: 1,
    abortController: new AbortController(),
    attachment,
    attachmentSubscriptions: [],
    sentBytes: 0,
    desiredGeometry: { cols: 80, rows: 24 },
    queryObserver: {
      accountForWriterBurst() {
        return { inspected: true, candidateCount: 0, consumed: [] };
      },
      close() {},
    },
    backpressure: {
      reset() {},
      setPty() {},
      onSent() { return 'none'; },
      onAck() { return 'none'; },
    },
  };
  return { socket, state, frames, attachment };
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

test('readoption bootstrap is suppressed and owner bytes are never fanned to browsers', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-readoption-history-'));
  const taskId = 'task-readoption-meta';
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    installSession(gateway, taskId);
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
      reservedBytes: 0,
      maxBytes: RAW_LOG_BUDGET,
      pendingWrites: 0,
      maxPendingWrites: RAW_PENDING_WRITE_BUDGET,
      truncated: false,
    });
    const client = makeAttachedClient(taskId);
    gateway.clients.set(client.socket, client.state);
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onPtyOutput(taskId, 'duplicate current-frame repaint\r\n', {
      recordable: false,
      source: 'attach-bootstrap',
    });
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(existsSync(logPath), false);
    const cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.equal(parseCast(cast).events.length, 0);
    assert.deepEqual(client.frames, [], 'owner output must never enter a browser socket');

    gateway.onPtyOutput(taskId, 'recordable owner output\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);
    assert.equal(await readFile(logPath, 'utf8'), 'recordable owner output\r\n');
    assert.deepEqual(client.frames, [], 'recording remains topologically browser-free');
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('recording omits real settle-window delta, may include late repaint, then appends normally', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-recording-uncertainty-'));
  const taskId = 'task-recording-uncertainty';
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    installSession(gateway, taskId);
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
      reservedBytes: 0,
      maxBytes: RAW_LOG_BUDGET,
      pendingWrites: 0,
      maxPendingWrites: RAW_PENDING_WRITE_BUDGET,
      truncated: false,
    });
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onPtyOutput(
      taskId,
      'real live delta inside indistinguishable settle window\r\n',
      { recordable: false, source: 'attach-bootstrap' },
    );
    gateway.onPtyOutput(
      taskId,
      'late indistinguishable repaint after hard deadline\r\n',
    );
    gateway.onPtyOutput(taskId, 'later observed real append\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(
      await readFile(logPath, 'utf8'),
      [
        'late indistinguishable repaint after hard deadline\r\n',
        'later observed real append\r\n',
      ].join(''),
    );
    const cast = parseCast(
      await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8'),
    );
    assert.deepEqual(
      cast.events.map((event) => event[2]),
      [
        'late indistinguishable repaint after hard deadline\r\n',
        'later observed real append\r\n',
      ],
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('opt-in raw artifact budgets truncate before enqueueing unbounded output', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-recording-budget-'));
  const taskId = 'task-recording-budget';
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    installSession(gateway, taskId);
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
      reservedBytes: 0,
      maxBytes: RAW_LOG_BUDGET,
      pendingWrites: 0,
      maxPendingWrites: RAW_PENDING_WRITE_BUDGET,
      truncated: false,
    });
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onPtyOutput(taskId, 'x'.repeat(RAW_LOG_BUDGET * 2));
    gateway.onPtyOutput(taskId, 'this later chunk must not enqueue');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    const log = await readFile(logPath);
    const cast = await readFile(
      path.join(workspaceDir, SESSION_CAST_FILENAME),
      'utf8',
    );
    assert.ok(log.byteLength <= RAW_LOG_BUDGET);
    assert.match(log.toString('utf8'), /recording truncated/);
    assert.equal(
      log.toString('utf8').split('recording truncated').length - 1,
      1,
    );
    assert.ok(Buffer.byteLength(cast, 'utf8') <= RAW_LOG_BUDGET);
    assert.match(cast, /recording truncated/);
    assert.equal(cast.split('recording truncated').length - 1, 1);
    assert.doesNotThrow(() => parseCast(cast));
    assert.equal(gateway.sessionLogs.get(taskId).truncated, true);
    assert.equal(gateway.sessionCasts.get(taskId).truncated, true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('opt-in raw artifact pending-write budgets bound a stalled filesystem backlog', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-recording-backlog-'));
  const taskId = 'task-recording-backlog';
  let releaseLog;
  let releaseCast;
  const blockedLog = new Promise((resolve) => {
    releaseLog = resolve;
  });
  const blockedCast = new Promise((resolve) => {
    releaseCast = resolve;
  });
  try {
    const gateway = new TerminalGateway();
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    installSession(gateway, taskId);
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: blockedLog,
      ensured: false,
      reservedBytes: 0,
      maxBytes: RAW_LOG_BUDGET,
      pendingWrites: 0,
      maxPendingWrites: 4,
      truncated: false,
    });
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);
    const castEntry = gateway.sessionCasts.get(taskId);
    castEntry.tail = blockedCast;
    castEntry.maxPendingWrites = 4;

    for (let index = 0; index < 100; index += 1) {
      gateway.onPtyOutput(taskId, `q${index}\r\n`);
    }

    const logEntry = gateway.sessionLogs.get(taskId);
    assert.equal(logEntry.pendingWrites, 4);
    assert.equal(castEntry.pendingWrites, 4);
    assert.equal(logEntry.truncated, true);
    assert.equal(castEntry.truncated, true);
    assert.ok(logEntry.reservedBytes <= logEntry.maxBytes);
    assert.ok(castEntry.reservedBytes <= castEntry.maxBytes);

    const saturatedLogTail = logEntry.tail;
    const saturatedCastTail = castEntry.tail;
    gateway.onPtyOutput(taskId, 'later payload must not allocate another closure\r\n');
    assert.equal(logEntry.tail, saturatedLogTail);
    assert.equal(castEntry.tail, saturatedCastTail);

    releaseLog();
    releaseCast();
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.equal(logEntry.pendingWrites, 0);
    assert.equal(castEntry.pendingWrites, 0);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /recording truncated/);
    assert.equal(log.split('recording truncated').length - 1, 1);
    const cast = await readFile(
      path.join(workspaceDir, SESSION_CAST_FILENAME),
      'utf8',
    );
    assert.match(cast, /recording truncated/);
    assert.equal(cast.split('recording truncated').length - 1, 1);
    assert.doesNotThrow(() => parseCast(cast));
  } finally {
    releaseLog?.();
    releaseCast?.();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('writer geometry resizes owner/viewers once and resize repaint stays transient', async () => {
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'cap-resize-history-'));
  const taskId = 'task-resize-history';
  try {
    const gateway = new TerminalGateway({
      isWriter: (sessionId, clientId) =>
        sessionId === taskId && clientId === 'client-readoption-meta',
    });
    const logPath = path.join(workspaceDir, SESSION_LOG_FILENAME);
    const { owner } = installSession(gateway, taskId);
    gateway.sessionLogs.set(taskId, {
      logPath,
      tail: Promise.resolve(),
      ensured: false,
      reservedBytes: 0,
      maxBytes: RAW_LOG_BUDGET,
      pendingWrites: 0,
      maxPendingWrites: RAW_PENDING_WRITE_BUDGET,
      truncated: false,
    });
    const client = makeAttachedClient(taskId);
    gateway.clients.set(client.socket, client.state);
    gateway.armCast(taskId, workspaceDir, 80, 24);
    await flushCast(gateway, taskId);

    gateway.onResize({ cols: 120, rows: 20 }, client.state);
    gateway.onPtyOutput(taskId, 'resize repaint\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);

    assert.deepEqual(owner.resizes, [[120, 20]]);
    assert.deepEqual(client.attachment.resizes, [[120, 20]]);
    assert.equal(existsSync(logPath), false);
    let cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(parseCast(cast).events.map((event) => [event[1], event[2]]), [
      ['r', '120x20'],
    ]);

    await delay(25);
    gateway.onPtyOutput(taskId, 'real output after resize\r\n');
    await flushLog(gateway, taskId);
    await flushCast(gateway, taskId);
    assert.equal(await readFile(logPath, 'utf8'), 'real output after resize\r\n');
    cast = await readFile(path.join(workspaceDir, SESSION_CAST_FILENAME), 'utf8');
    assert.deepEqual(parseCast(cast).events.map((event) => event[1]), ['r', 'o']);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test('writer input targets only its viewer PTY and preserves opaque bytes', () => {
  const taskId = 'task-input-target';
  const gateway = new TerminalGateway({
    isWriter: (sessionId, clientId) =>
      sessionId === taskId && clientId === 'client-readoption-meta',
  });
  const { owner } = installSession(gateway, taskId);
  const client = makeAttachedClient(taskId);
  gateway.clients.set(client.socket, client.state);
  const bytes = Buffer.from([0x00, 0x1b, 0x80, 0xff]);

  gateway.onKeystroke(
    {
      channel: 'control',
      type: 'keystroke',
      sessionId: taskId,
      data: bytes.toString('base64'),
    },
    client.socket,
    client.state,
  );

  assert.deepEqual(client.attachment.writes, [bytes]);
  assert.deepEqual(owner.writes, [], 'browser input must never target the owner PTY');
});

test('session.cast resume preserves one header and monotonic event time', async () => {
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
    const headerCount = cast.split('\n').filter((line) => line.includes('"version":2')).length;
    const parsed = parseCast(cast);
    assert.equal(headerCount, 1);
    assert.deepEqual(parsed.events.map((event) => event[2]), ['first\r\n', 'second\r\n']);
    assert.ok(parsed.events[1][0] >= parsed.events[0][0]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
