import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function descriptor() {
  return {
    protocol: 'boxlite-v1',
    wsUrl: 'ws://boxlite.internal',
    metadata: {
      endpoint: 'http://boxlite.internal',
      sandboxId: 'box-one',
      pathPrefix: 'default',
      workspacePath: '/workspace',
    },
  };
}

function response(executionId) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { execution_id: executionId };
    },
  };
}

function statusResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {};
    },
  };
}

function makeBridgeFrame(line) {
  return Buffer.concat([Buffer.from([1]), Buffer.from(line, 'ascii')]);
}

async function withDeadline(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  paused = false;
  closed = false;

  send(payload) {
    this.sent.push(payload);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}

await test('close-before-create waits for the exact late execution then deletes and confirms it', async () => {
  let resolveFetch;
  let requestSignal;
  const pending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const fetchCalls = [];
  const logs = [];
  const secret = 'CAP_BOXLITE_LIFECYCLE_SECRET';
  const transport = new mod.BoxLiteTerminalTransport('late-task', descriptor(), {
    apiToken: secret,
    cleanupTimeoutMs: 250,
    cleanupAttemptTimeoutMs: 25,
    cleanupRetryDelayMs: 0,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (init.method === 'POST') {
        requestSignal = init.signal;
        return pending;
      }
      if (init.method === 'DELETE') return statusResponse(204);
      if (init.method === 'GET') return statusResponse(404);
      throw new Error('unexpected method');
    },
    webSocketFactory: () => {
      throw new Error('a closed late execution must never attach');
    },
    logger: { warn: (message) => logs.push(message) },
  });
  const frames = [];
  const errors = [];
  const closes = [];
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error.message));
  transport.onClose(() => closes.push('closed'));

  transport.close();
  transport.close();
  assert.equal(requestSignal.aborted, false);
  assert.deepEqual(closes, ['closed']);
  resolveFetch(response('late-execution-1'));
  const settlement = await withDeadline(transport.cleanupDecision);

  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(
    fetchCalls.map(({ init }) => init.method),
    ['POST', 'DELETE', 'GET'],
  );
  const cleanupUrl =
    'http://boxlite.internal/v1/default/boxes/box-one/executions/late-execution-1';
  assert.equal(fetchCalls[1].url, cleanupUrl);
  assert.equal(fetchCalls[2].url, cleanupUrl);
  assert.equal(fetchCalls[1].init.headers.authorization, `Bearer ${secret}`);
  assert.equal(fetchCalls[2].init.headers.authorization, `Bearer ${secret}`);
  assert.deepEqual(settlement, {
    kind: 'confirmed',
    expectedIdentities: 1,
    observedIdentities: 1,
    confirmedIdentities: 1,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
  assert.equal(frames.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(
    JSON.stringify({ logs, errors, frames, settlement }).includes(secret),
    false,
  );
  assert.equal(
    JSON.stringify({ logs, errors, frames, settlement }).includes(
      'late-execution-1',
    ),
    false,
  );
});

await test('close-before-create suppresses a late failure and emits close once', async () => {
  let rejectFetch;
  const pending = new Promise((_resolve, reject) => {
    rejectFetch = reject;
  });
  const transport = new mod.BoxLiteTerminalTransport('late-failure', descriptor(), {
    fetch: async () => pending,
    webSocketFactory: () => {
      throw new Error('must not attach after failed create');
    },
  });
  const errors = [];
  const closes = [];
  transport.onError((error) => errors.push(error.message));
  transport.onClose(() => closes.push('closed'));
  transport.close();
  rejectFetch(new Error('late create rejected'));
  const settlement = await withDeadline(transport.cleanupDecision);
  assert.deepEqual(closes, ['closed']);
  assert.deepEqual(errors, []);
  assert.deepEqual(settlement, {
    kind: 'indeterminate',
    expectedIdentities: 1,
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: 'identity-unavailable',
  });
});

await test('cleanup identity timeout ignores a later create settlement', async () => {
  let resolveCreate;
  const pendingCreate = new Promise((resolve) => {
    resolveCreate = resolve;
  });
  let attachCalls = 0;
  const transport = new mod.BoxLiteTerminalTransport(
    'identity-timeout',
    descriptor(),
    {
      cleanupTimeoutMs: 10,
      fetch: async () => pendingCreate,
      webSocketFactory: () => {
        attachCalls += 1;
        return new FakeSocket();
      },
    },
  );
  transport.close();
  const settlement = await withDeadline(transport.cleanupDecision);
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'identity-unavailable');
  resolveCreate(response('too-late-execution'));
  await delay(20);
  assert.equal(attachCalls, 0);
});

await test('close after create but before WebSocket open fences bridge readiness', async () => {
  const sockets = [];
  const calls = [];
  const transport = new mod.BoxLiteTerminalTransport(
    'close-before-socket-open',
    descriptor(),
    {
      fetch: async (_url, init = {}) => {
        calls.push(init.method);
        if (init.method === 'POST') return response('connecting-execution');
        if (init.method === 'DELETE') return statusResponse(204);
        if (init.method === 'GET') return statusResponse(404);
        throw new Error('unexpected method');
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  const frames = [];
  const errors = [];
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error.message));
  await delay();
  assert.equal(sockets.length, 1);
  transport.close();
  sockets[0].open();
  assert.equal((await withDeadline(transport.cleanupDecision)).kind, 'confirmed');
  assert.deepEqual(calls, ['POST', 'DELETE', 'GET']);
  assert.equal(frames.some((frame) => frame.type === 'ready'), false);
  assert.deepEqual(errors, []);
  assert.equal(sockets[0].closed, true);
});

await test('factory opens independent executions with isolated bytes, resize, pause, and close', async () => {
  let execution = 0;
  const sockets = [];
  const urls = [];
  const cleanupCalls = [];
  const factory = mod.createBoxLiteTerminalTransportFactory({
    taskId: 'peer-task',
    descriptor: descriptor(),
    cleanupAttemptTimeoutMs: 25,
    cleanupRetryDelayMs: 0,
    bridgeGenerationFactory: () => 'lifecycle-generation',
    fetch: async (url, init = {}) => {
      if (init.method === 'POST') return response(`peer-execution-${++execution}`);
      cleanupCalls.push({ url: String(url), method: init.method });
      if (init.method === 'DELETE') return statusResponse(204);
      if (init.method === 'GET') return statusResponse(404);
      throw new Error('unexpected method');
    },
    webSocketFactory: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const first = factory.open();
  const second = factory.open();
  const firstFrames = [];
  const secondFrames = [];
  first.onFrame((frame) => firstFrames.push(frame));
  second.onFrame((frame) => secondFrames.push(frame));
  await delay();
  assert.equal(sockets.length, 2);
  assert.notEqual(urls[0], urls[1]);
  sockets[0].open();
  sockets[1].open();
  sockets[0].emit(
    'message',
    makeBridgeFrame('R lifecycle-generation 1 101 shell 80 24\n'),
    true,
  );
  sockets[1].emit(
    'message',
    makeBridgeFrame('R lifecycle-generation 1 102 shell 80 24\n'),
    true,
  );
  assert.equal(firstFrames.some((frame) => frame.type === 'ready'), true);
  assert.equal(secondFrames.some((frame) => frame.type === 'ready'), true);

  const binary = Uint8Array.of(0x00, 0x1b, 0x80, 0xff);
  assert.equal(first.sendInputBytes(binary), 'written');
  assert.equal(
    Buffer.from(sockets[0].sent[0]).toString('ascii'),
    'I lifecycle-generation ABuA/w==\n',
  );
  assert.equal(sockets[1].sent.length, 0);
  assert.equal(second.sendResize(132, 43), true);
  assert.equal(
    Buffer.from(sockets[1].sent[0]).toString('ascii'),
    'S lifecycle-generation 132 43\n',
  );
  first.pause();
  assert.equal(sockets[0].paused, true);
  assert.equal(sockets[1].paused, false);
  first.close();
  assert.equal((await withDeadline(first.cleanupDecision)).kind, 'confirmed');
  assert.equal(sockets[0].closed, true);
  assert.equal(sockets[1].closed, false);
  assert.equal(second.sendInputBytes(Uint8Array.of(0xfe)), 'written');
  second.close();
  assert.equal((await withDeadline(second.cleanupDecision)).kind, 'confirmed');
  assert.deepEqual(
    cleanupCalls.map(({ method }) => method),
    ['DELETE', 'GET', 'DELETE', 'GET'],
  );
  assert.equal(cleanupCalls[0].url.includes('peer-execution-1'), true);
  assert.equal(cleanupCalls[2].url.includes('peer-execution-2'), true);
});

await test('DELETE 404 still requires GET 404 before proving already absent', async () => {
  const calls = [];
  const sockets = [];
  const transport = new mod.BoxLiteTerminalTransport(
    'already-absent-task',
    descriptor(),
    {
      cleanupAttemptTimeoutMs: 25,
      cleanupRetryDelayMs: 0,
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), method: init.method });
        if (init.method === 'POST') return response('already-absent-execution');
        if (init.method === 'DELETE') return statusResponse(404);
        if (init.method === 'GET') return statusResponse(404);
        throw new Error('unexpected method');
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  await delay();
  sockets[0].open();
  transport.close();

  assert.deepEqual(await withDeadline(transport.cleanupDecision), {
    kind: 'confirmed',
    expectedIdentities: 1,
    observedIdentities: 1,
    confirmedIdentities: 1,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 1,
    cause: null,
  });
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['POST', 'DELETE', 'GET'],
  );
  assert.equal(
    calls[1].url,
    'http://boxlite.internal/v1/default/boxes/box-one/executions/already-absent-execution',
  );
});

await test('persistent cleanup 5xx exhausts finite retries without false confirmation', async () => {
  const methods = [];
  const sockets = [];
  const transport = new mod.BoxLiteTerminalTransport('cleanup-5xx', descriptor(), {
    cleanupTimeoutMs: 200,
    cleanupAttemptTimeoutMs: 20,
    cleanupRetryDelayMs: 0,
    fetch: async (_url, init = {}) => {
      methods.push(init.method);
      if (init.method === 'POST') return response('cleanup-5xx-execution');
      return statusResponse(503);
    },
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await delay();
  sockets[0].open();
  transport.close();

  assert.deepEqual(await withDeadline(transport.cleanupDecision), {
    kind: 'indeterminate',
    expectedIdentities: 1,
    observedIdentities: 1,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unconfirmed',
  });
  assert.deepEqual(methods, ['POST', 'DELETE', 'DELETE', 'DELETE']);
});

await test('cleanup transport failures are idempotent and secret-free', async () => {
  const secret = 'CAP_BOXLITE_CLEANUP_TOKEN_SECRET';
  const executionId = 'provider-execution-secret-value';
  const logs = [];
  const errors = [];
  const sockets = [];
  let cleanupCalls = 0;
  const transport = new mod.BoxLiteTerminalTransport('cleanup-transport', descriptor(), {
    apiToken: secret,
    cleanupTimeoutMs: 200,
    cleanupAttemptTimeoutMs: 20,
    cleanupRetryDelayMs: 0,
    fetch: async (_url, init = {}) => {
      if (init.method === 'POST') return response(executionId);
      cleanupCalls += 1;
      throw new Error(`${secret}:${executionId}`);
    },
    logger: { warn: (message) => logs.push(message) },
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  transport.onError((error) => errors.push(error.message));
  await delay();
  sockets[0].open();
  sockets[0].emit('error', new Error(`${secret}:${executionId}`));
  transport.close();
  transport.close();
  const cleanupPromise = transport.cleanupDecision;
  assert.equal(cleanupPromise, transport.cleanupDecision);
  const settlement = await withDeadline(cleanupPromise);

  assert.equal(cleanupCalls, 3);
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'cleanup-unconfirmed');
  assert.deepEqual(errors, ['BoxLite terminal WebSocket failed']);
  const publicEvidence = JSON.stringify({ logs, errors, settlement });
  assert.equal(publicEvidence.includes(secret), false);
  assert.equal(publicEvidence.includes(executionId), false);
});

await test('hanging cleanup requests are aborted and settle within the hard bound', async () => {
  const sockets = [];
  const cleanupSignals = [];
  let cleanupCalls = 0;
  const transport = new mod.BoxLiteTerminalTransport('cleanup-hang', descriptor(), {
    cleanupTimeoutMs: 100,
    cleanupAttemptTimeoutMs: 10,
    cleanupRetryDelayMs: 0,
    fetch: async (_url, init = {}) => {
      if (init.method === 'POST') return response('cleanup-hang-execution');
      cleanupCalls += 1;
      cleanupSignals.push(init.signal);
      return new Promise(() => {});
    },
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await delay();
  sockets[0].open();
  const startedAt = Date.now();
  transport.close();
  const settlement = await withDeadline(transport.cleanupDecision, 500);

  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'cleanup-unconfirmed');
  assert.equal(cleanupCalls, 3);
  assert.equal(cleanupSignals.every((signal) => signal.aborted), true);
  assert.equal(Date.now() - startedAt < 300, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
