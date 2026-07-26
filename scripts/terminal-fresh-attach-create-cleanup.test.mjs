import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AioProductViewerConnection,
  confirmAioSessionAbsence,
  createAioProvider,
  createBoxLiteProvider,
  createCanaryLifecycle,
  drainConnectionRegistry,
  errorMessage,
} from './terminal-fresh-attach-canary.mjs';

const requireFromApi = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { WebSocket, WebSocketServer } = requireFromApi('ws');

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'terminal-fresh-attach-canary.mjs',
);

test('bounded cleanup diagnostics retain nested aggregate causes', () => {
  const error = new AggregateError(
    [new AggregateError([new Error('exact inner cause')], 'provider cleanup')],
    'terminal cleanup',
  );
  const message = errorMessage(error);
  assert.match(message, /terminal cleanup/u);
  assert.match(message, /provider cleanup/u);
  assert.match(message, /exact inner cause/u);
});

test('signal fence waits for run unwind and drains resources added after the first snapshot', async () => {
  const lifecycle = createCanaryLifecycle({
    cleanupAttempts: 2,
    cleanupRetryDelayMs: 0,
  });
  let releaseRun;
  const runPromise = new Promise((resolve) => {
    releaseRun = resolve;
  });
  lifecycle.trackRun(runPromise);

  const registry = new Set();
  let lateCloses = 0;
  let transientCloses = 0;
  const late = {
    async close() {
      lateCloses += 1;
    },
  };
  registry.add({
    async close() {
      registry.add(late);
    },
  });
  registry.add({
    async close() {
      transientCloses += 1;
      if (transientCloses === 1) {
        throw new Error('transient close failure');
      }
    },
  });
  lifecycle.registerCleanup(() => drainConnectionRegistry(registry));

  assert.equal(lifecycle.requestStop('SIGTERM'), true);
  assert.throws(
    () => lifecycle.assertCanCreate('late PTY'),
    /stopping after SIGTERM/u,
  );
  const shutdown = (async () => {
    await lifecycle.waitForRunUnwind();
    await lifecycle.runCleanup();
  })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transientCloses, 0, 'cleanup started before run unwind');

  releaseRun();
  await shutdown;
  assert.equal(transientCloses, 2);
  assert.equal(lateCloses, 1);
  assert.equal(registry.size, 0);
});

test('lost BoxLite create response is reconciled by its unique name', async () => {
  const baseline = {
    box_id: 'baseline-box',
    name: 'unrelated-box',
    status: 'stopped',
  };
  const boxes = [baseline];
  let resolveCreateSeen;
  const createSeen = new Promise((resolve) => {
    resolveCreateSeen = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/default/boxes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ boxes }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/default/boxes') {
      request.resume();
      boxes.push({
        box_id: 'late-created-box',
        name: 'cap-terminal-fresh-attach-lostresponse',
        status: 'created',
      });
      resolveCreateSeen();
      // Deliberately withhold the response after the backend create committed.
      return;
    }
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/default/boxes/late-created-box'
    ) {
      const index = boxes.findIndex((box) => box.box_id === 'late-created-box');
      if (index >= 0) boxes.splice(index, 1);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/default/boxes/late-created-box'
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  let registeredCleanup;
  try {
    const provider = createBoxLiteProvider(
      {
        endpoint: `http://127.0.0.1:${address.port}`,
        pathPrefix: 'default',
        rootfs: '/unused-test-rootfs',
        image: null,
      },
      'lostresponse',
      (cleanup) => {
        registeredCleanup = cleanup;
      },
    );
    await createSeen;
    assert.equal(typeof registeredCleanup, 'function');
    await registeredCleanup();
    await assert.rejects(provider);
    assert.deepEqual(boxes, [baseline]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SIGTERM during a committed lost create response exits 143 after cleanup', async () => {
  const baseline = {
    box_id: 'baseline-signal-box',
    name: 'unrelated-signal-box',
    status: 'stopped',
  };
  const boxes = [baseline];
  let resolveCreateSeen;
  let deleteAttempts = 0;
  const createSeen = new Promise((resolve) => {
    resolveCreateSeen = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/default/boxes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ boxes }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/default/boxes') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        boxes.push({
          box_id: 'late-signal-box',
          name: body.name,
          status: 'created',
        });
        resolveCreateSeen();
      });
      return;
    }
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/default/boxes/late-signal-box'
    ) {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        response.statusCode = 503;
        response.end('transient cleanup failure');
        return;
      }
      const index = boxes.findIndex((box) => box.box_id === 'late-signal-box');
      if (index >= 0) boxes.splice(index, 1);
      response.statusCode = 204;
      response.end();
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname === '/v1/default/boxes/late-signal-box'
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const child = spawn(
    process.execPath,
    [
      SCRIPT_PATH,
      'boxlite',
      '--endpoint',
      `http://127.0.0.1:${address.port}`,
      '--rootfs',
      '/unused-test-rootfs',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await createSeen;
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await exit, { code: 143, signal: null });
    assert.equal(deleteAttempts, 2);
    assert.deepEqual(boxes, [baseline]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('signal cleanup failure exits non-success and reports bounded evidence', async () => {
  const secretToken = 'boxlite-signal-secret-must-not-leak';
  const baseline = {
    box_id: 'baseline-failed-cleanup-box',
    name: 'unrelated-failed-cleanup-box',
    status: 'stopped',
  };
  const boxes = [baseline];
  let resolveCreateSeen;
  const createSeen = new Promise((resolve) => {
    resolveCreateSeen = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/default/boxes') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ boxes }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/default/boxes') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        boxes.push({
          box_id: 'failed-cleanup-box',
          name: body.name,
          status: 'created',
        });
        resolveCreateSeen();
      });
      return;
    }
    if (
      request.method === 'DELETE' &&
      url.pathname === '/v1/default/boxes/failed-cleanup-box'
    ) {
      response.statusCode = 503;
      response.end('persistent cleanup failure');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const child = spawn(
    process.execPath,
    [
      SCRIPT_PATH,
      'boxlite',
      '--endpoint',
      `http://127.0.0.1:${address.port}`,
      '--rootfs',
      '/unused-test-rootfs',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BOXLITE_API_TOKEN: secretToken },
    },
  );
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  try {
    await createSeen;
    assert.equal(child.kill('SIGTERM'), true);
    assert.deepEqual(await exit, { code: 1, signal: null });
    const failureOutput = Buffer.concat(stderr).toString('utf8');
    assert.match(failureOutput, /cleanup failed after SIGTERM/u);
    assert.match(failureOutput, /failed after 3 attempts/u);
    assert.equal(failureOutput.includes(secretToken), false);
    assert.deepEqual(
      boxes.map(({ box_id: boxId }) => boxId),
      ['baseline-failed-cleanup-box', 'failed-cleanup-box'],
      'persistent failure was incorrectly reported as absent',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('AIO signal cleanup fences pending opens, closes active listeners, and proves exact REST absence', async () => {
  const nonce = 'signalrace';
  const fixture = await createAioLifecycleFixture(nonce);
  const lifecycle = createCanaryLifecycle({
    cleanupAttempts: 2,
    cleanupRetryDelayMs: 0,
  });
  const provider = createAioProvider(fixture.endpoint, nonce, lifecycle);
  try {
    await provider.prepareCleanupControl();
    const active = await provider.openTerminal(80, 24);
    const pending = provider.openTerminal(80, 24);
    await fixture.waitForConnectionCount(3);
    await new Promise((resolve) => setImmediate(resolve));

    provider.markBusinessResourcesMayExist();
    lifecycle.trackRun(pending);
    assert.equal(lifecycle.requestStop('SIGTERM'), true);
    await assert.rejects(pending, /stopping after SIGTERM/u);
    await lifecycle.waitForRunUnwind();
    lifecycle.registerCleanup(() =>
      provider.execCleanup({
        tmuxMode: 'isolated',
        socketName: `capfresh${nonce}`,
        sessionNames: ['fixture', 'pressure'],
        exactTempFiles: [],
      }),
    );
    await lifecycle.runCleanup();

    assert.equal(active.closed, true);
    assert.equal(fixture.connectionCount, 3, 'cleanup opened a new AIO PTY');
    await assert.rejects(
      provider.openTerminal(80, 24),
      /stopping after SIGTERM/u,
    );
    assert.equal(fixture.connectionCount, 3, 'stopping fence admitted a late PTY');
    assert.deepEqual([...fixture.sessions], [fixture.unrelatedSessionId]);
    assert.equal(provider.cleanupEvidence.result, 'PASS');
    assert.equal(provider.cleanupEvidence.providerSessionAbsence.length, 3);
    const cleanupControlFrames = fixture.inputFrames.filter(
      (data) =>
        data.includes('CAP_AIO_CLEANUP_VERIFY_%s') ||
        data.includes('CAP_AIO_POST_ABSENCE_%s'),
    );
    assert.equal(cleanupControlFrames.length, 2);
    assert(
      cleanupControlFrames.every(
        (data) => data.endsWith('\n') && !data.endsWith('\\n'),
      ),
      'cleanup-control commands were not submitted as complete shell lines',
    );
    assert(
      provider.cleanupEvidence.providerSessionAbsence.every(
        ({ absent }) => absent === 'already-absent',
      ),
    );
    assert.equal(
      fixture.deleteAttempts.get(fixture.activeSessionId),
      3,
      'transient DELETE was not retried before the final absence proof',
    );
    assert(
      fixture.sockets.every(
        (socket) => socket.readyState === WebSocket.CLOSED,
      ),
      'an AIO viewer/listener remained open after cleanup',
    );
  } finally {
    await fixture.close();
  }
});

test('AIO cleanup preserves its control PTY until a later outer retry proves business absence', async () => {
  const nonce = 'retrycontrol';
  const fixture = await createAioLifecycleFixture(nonce, {
    suppressedCleanupVerifyFrames: 3,
  });
  const lifecycle = createCanaryLifecycle({
    cleanupAttempts: 2,
    cleanupRetryDelayMs: 0,
  });
  const provider = createAioProvider(fixture.endpoint, nonce, lifecycle, {
    cleanupControlTimeoutMs: 100,
  });
  try {
    await provider.prepareCleanupControl();
    await provider.openTerminal(80, 24);
    provider.markBusinessResourcesMayExist();
    lifecycle.registerCleanup(() =>
      provider.execCleanup({
        tmuxMode: 'isolated',
        socketName: `capfresh${nonce}`,
        sessionNames: ['fixture', 'pressure'],
        exactTempFiles: [],
      }),
    );

    await lifecycle.runCleanup();

    assert.equal(fixture.connectionCount, 2, 'cleanup replaced its control PTY');
    assert.equal(fixture.cleanupVerifyFrameCount, 4);
    assert.equal(provider.cleanupEvidence.result, 'PASS');
    assert.equal(
      fixture.deleteAttempts.get(
        provider.cleanupEvidence.cleanupControlTerminalId,
      ),
      2,
      'cleanup-control identity was deleted before the successful proof phase',
    );
    assert.deepEqual([...fixture.sessions], [fixture.unrelatedSessionId]);
  } finally {
    await fixture.close();
  }
});

test('AIO product viewer close awaits exact main/injector cleanup and disposes listeners', async () => {
  const mainId = '44444444-4444-4444-8444-444444444444';
  const injectorId = '55555555-5555-4555-8555-555555555555';
  const mainSocket = createFakeSocket();
  const injectorSocket = createFakeSocket();
  let settleCleanup;
  const cleanupDecision = new Promise((resolve) => {
    settleCleanup = resolve;
  });
  let disposedListeners = 0;
  let closeSettled = false;
  const attachment = {
    attachmentDecision: Promise.resolve({ kind: 'ready' }),
    cleanupDecision,
    opaqueInputCapability: 'byte-preserving',
    onData() {
      return { dispose: () => (disposedListeners += 1) };
    },
    onError() {
      return { dispose: () => (disposedListeners += 1) };
    },
    onClose() {
      return { dispose: () => (disposedListeners += 1) };
    },
    close() {
      mainSocket.readyState = WebSocket.CLOSED;
      injectorSocket.readyState = WebSocket.CLOSED;
    },
  };
  const connection = new AioProductViewerConnection({
    attachment,
    transport: {
      main: { socket: mainSocket, sessionFrame: { data: mainId } },
      injector: {
        socket: injectorSocket,
        sessionFrame: { data: injectorId },
      },
    },
    cols: 80,
    rows: 24,
  });
  await connection.waitForReady(1_000);
  const closing = connection.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeSettled, false, 'close ignored provider cleanupDecision');

  settleCleanup({
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 1,
    cause: null,
  });
  await closing;
  assert.equal(disposedListeners, 3);
  assert.equal(connection.closeEvidence.result, 'PASS');
  assert.equal(connection.closeEvidence.mainTerminalId, mainId);
  assert.equal(connection.closeEvidence.injectorTerminalId, injectorId);
  assert.equal(connection.closeEvidence.providerSessionCleanup.kind, 'confirmed');

  const fixture = await createAioLifecycleFixture('productids');
  try {
    fixture.sessions.add(mainId);
    fixture.sessions.add(injectorId);
    const restProof = await Promise.all([
      confirmAioSessionAbsence(fixture.endpoint, {
        role: 'product-main',
        terminalId: mainId,
      }),
      confirmAioSessionAbsence(fixture.endpoint, {
        role: 'product-injector',
        terminalId: injectorId,
      }),
    ]);
    assert.deepEqual(
      restProof.map(({ role, absent }) => ({ role, absent })),
      [
        { role: 'product-main', absent: 'already-absent' },
        { role: 'product-injector', absent: 'already-absent' },
      ],
    );
    assert.deepEqual([...fixture.sessions], [fixture.unrelatedSessionId]);
  } finally {
    await fixture.close();
  }
});

function createFakeSocket() {
  return {
    readyState: WebSocket.OPEN,
    terminate() {
      this.readyState = WebSocket.CLOSED;
    },
  };
}

async function createAioLifecycleFixture(
  nonce,
  { suppressedCleanupVerifyFrames = 0 } = {},
) {
  const terminalIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const unrelatedSessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sessions = new Set([unrelatedSessionId]);
  const sockets = [];
  const inputFrames = [];
  let cleanupVerifyFrameCount = 0;
  const deleteAttempts = new Map();
  const connectionWaiters = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const prefix = '/v1/shell/sessions/';
    if (request.method === 'DELETE' && url.pathname.startsWith(prefix)) {
      const terminalId = decodeURIComponent(url.pathname.slice(prefix.length));
      const attempts = (deleteAttempts.get(terminalId) ?? 0) + 1;
      deleteAttempts.set(terminalId, attempts);
      if (terminalId === terminalIds[1] && attempts === 1) {
        response.statusCode = 503;
        response.end('transient cleanup failure');
        return;
      }
      const deleted = sessions.delete(terminalId);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          success: deleted,
          ...(deleted ? {} : { message: `Session ${terminalId} not found` }),
          data: { session_id: terminalId },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/v1/shell/ws') {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, request);
    });
  });
  websocketServer.on('connection', (socket) => {
    const index = sockets.length;
    const terminalId = terminalIds[index];
    if (!terminalId) {
      socket.close();
      return;
    }
    sockets.push(socket);
    sessions.add(terminalId);
    socket.send(JSON.stringify({ type: 'session_id', data: terminalId }));
    if (index < 2) socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('message', (raw) => {
      const frame = JSON.parse(Buffer.from(raw).toString('utf8'));
      if (frame.type !== 'input' || typeof frame.data !== 'string') return;
      inputFrames.push(frame.data);
      if (!frame.data.endsWith('\n') || frame.data.endsWith('\\n')) return;
      if (frame.data.includes('CAP_AIO_CLEANUP_VERIFY_%s')) {
        cleanupVerifyFrameCount += 1;
        if (cleanupVerifyFrameCount <= suppressedCleanupVerifyFrames) return;
        socket.send(
          JSON.stringify({
            type: 'output',
            data: `\r\nCAP_AIO_CLEANUP_VERIFY_${nonce} business=absent temp=absent\r\n`,
          }),
        );
      }
      if (frame.data.includes('CAP_AIO_POST_ABSENCE_%s')) {
        socket.send(
          JSON.stringify({
            type: 'output',
            data: `\r\nCAP_AIO_POST_ABSENCE_${nonce} business=absent temp=absent\r\n`,
          }),
        );
      }
    });
    for (const waiter of connectionWaiters) waiter();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    sessions,
    sockets,
    inputFrames,
    get cleanupVerifyFrameCount() {
      return cleanupVerifyFrameCount;
    },
    deleteAttempts,
    unrelatedSessionId,
    activeSessionId: terminalIds[1],
    get connectionCount() {
      return sockets.length;
    },
    waitForConnectionCount(count) {
      if (sockets.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          connectionWaiters.delete(check);
          reject(new Error(`timed out waiting for ${count} AIO connections`));
        }, 2_000);
        const check = () => {
          if (sockets.length < count) return;
          clearTimeout(timeout);
          connectionWaiters.delete(check);
          resolve();
        };
        connectionWaiters.add(check);
      });
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => websocketServer.close(resolve));
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
