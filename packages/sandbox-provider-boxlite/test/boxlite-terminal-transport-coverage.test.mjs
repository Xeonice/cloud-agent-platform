import assert from 'node:assert/strict';

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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function descriptor(metadata = {}) {
  return {
    protocol: 'boxlite-v1',
    wsUrl: 'ws://127.0.0.1:9/',
    metadata: {
      endpoint: 'http://127.0.0.1:9/',
      sandboxId: 'box-task',
      workspacePath: "/workspace/it's",
      ...metadata,
    },
  };
}

class FakeSocket {
  readyState = 1;
  sent = [];
  paused = false;
  resumed = false;
  closeThrows = false;

  send(payload) {
    this.sent.push(payload);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.resumed = true;
  }

  close() {
    if (this.closeThrows) throw new Error('close failed');
  }
}

async function failingTransport(fetchImpl = async () => {
  throw new Error('start failed');
}) {
  const transport = new mod.BoxLiteTerminalTransport('task-fail', descriptor(), {
    fetch: fetchImpl,
    logger: { warn() {} },
  });
  await delay(20);
  return transport;
}

await test('covers manual socket states, subscriptions, and outbound helpers', async () => {
  const transport = await failingTransport();
  const frames = [];
  const closes = [];
  const errors = [];
  const frameSub = transport.onFrame((frame) => frames.push(frame));
  const closeSub = transport.onClose(() => closes.push('closed'));
  const errorSub = transport.onError((error) => errors.push(error.message));

  assert.equal(transport.readyState, 'closed');
  transport.socket = null;
  transport.state = 'connecting';
  transport.closedLatch = false;
  assert.equal(transport.readyState, 'connecting');

  const socket = new FakeSocket();
  transport.socket = socket;
  socket.readyState = 0;
  assert.equal(transport.readyState, 'connecting');
  socket.readyState = 1;
  transport.bridgeReady = true;
  assert.equal(transport.readyState, 'open');
  assert.equal(transport.sendPong(123), true);
  assert.equal(transport.sendInput('abc'), true);
  assert.equal(transport.opaqueInputCapability, 'byte-preserving');
  assert.equal(
    transport.sendInputBytes(Uint8Array.of(0x00, 0x7f, 0x80, 0xff)),
    'written',
  );
  assert.deepEqual(
    Buffer.from(socket.sent.at(-1).toString('ascii').split(' ')[2], 'base64'),
    Buffer.from([0x00, 0x7f, 0x80, 0xff]),
  );
  const response = Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e);
  assert.equal(transport.sendTerminalResponseBytes(response), 'written');
  assert.deepEqual(
    Buffer.from(socket.sent.at(-1).toString('ascii').split(' ')[2], 'base64'),
    Buffer.from(response),
  );
  assert.equal(transport.sendResize(80, 24), true);
  transport.pause();
  transport.resume();
  assert.equal(socket.paused, true);
  assert.equal(socket.resumed, true);
  assert.equal(socket.sent.length, 4);
  assert.equal(transport.sendResize(1.5, 24), false);
  assert.equal(transport.sendResize(80, 1.5), false);
  assert.equal(transport.sendResize(0, 24), false);
  assert.equal(transport.sendResize(80, 0), false);
  assert.equal(transport.sendResize(1_001, 24), false);
  assert.equal(transport.sendResize(80, 1_001), false);
  assert.equal(transport.sendInputBytes(new Uint8Array(0)), 'written');
  const originalSend = socket.send.bind(socket);
  let chunkSends = 0;
  socket.send = (payload) => {
    originalSend(payload);
    chunkSends += 1;
    socket.readyState = 3;
  };
  assert.equal(
    transport.sendInputBytes(new Uint8Array(16_385)),
    'closed',
  );
  assert.equal(chunkSends, 1);
  socket.send = originalSend;

  socket.readyState = 2;
  assert.equal(transport.readyState, 'closing');
  socket.readyState = 3;
  assert.equal(transport.readyState, 'closed');
  assert.equal(transport.sendInput('closed'), false);
  assert.equal(transport.sendInputBytes(Uint8Array.of(0xff)), 'closed');
  assert.equal(transport.sendTerminalResponseBytes(response), 'closed');
  assert.equal(transport.sendResize(1, 1), false);

  socket.readyState = 1;
  socket.closeThrows = true;
  assert.doesNotThrow(() => transport.close());
  transport.onMessage(Buffer.alloc(0), true);
  transport.failBridge('ignored after close');

  transport.emitFrame({ type: 'output', data: 'manual' });
  transport.emitError(new Error('manual error'));
  assert.deepEqual(frames, [{ type: 'output', data: 'manual' }]);
  assert.deepEqual(errors, ['manual error']);

  frameSub.dispose();
  closeSub.dispose();
  errorSub.dispose();
  transport.emitFrame({ type: 'output', data: 'after-dispose' });
  transport.emitError(new Error('after-dispose'));
  transport.emitErrorOnce(new Error('first one-shot error'));
  transport.emitErrorOnce(new Error('duplicate one-shot error'));
  transport.settleExecutionCreation({ kind: 'failed' });
  transport.settleCleanup(transport.indeterminateCleanup('cleanup-unconfirmed'));
  assert.equal(
    await transport.fetchExecutionCleanup('past-deadline', 'GET', Date.now() - 1),
    null,
  );

  let closeTimerCallback;
  let connectingTerminateCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    closeTimerCallback = callback;
    return { unref() {} };
  };
  try {
    transport.closeSocketWithEof({
      readyState: 0,
      once() {},
      terminate() {
        connectingTerminateCalls += 1;
      },
    });
    closeTimerCallback();
    transport.closeSocketWithEof({
      readyState: 0,
      once() {},
      terminate() {
        throw new Error('connecting terminate failed');
      },
    });
    assert.doesNotThrow(() => closeTimerCallback());
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(connectingTerminateCalls, 1);

  const originalDateNow = Date.now;
  let fakeNow = 1_000;
  Date.now = () => {
    fakeNow += 10;
    return fakeNow;
  };
  transport.cleanupPolicy = { ...transport.cleanupPolicy, timeoutMs: 1 };
  try {
    assert.equal(
      (await transport.cleanupExactExecution()).cause,
      'identity-unavailable',
    );
  } finally {
    Date.now = originalDateNow;
  }
  assert.deepEqual(frames, [{ type: 'output', data: 'manual' }]);
  assert.deepEqual(errors, ['manual error']);
  assert.deepEqual(closes, []);
});

await test('covers open failures, invalid exec responses, and factory creation', async () => {
  const delayedFailure = new mod.BoxLiteTerminalTransport('task-delayed-fail', descriptor(), {
    fetch: async () => {
      await delay(10);
      throw new Error('delayed start failed');
    },
    logger: { warn() {} },
  });
  const delayedCloses = [];
  delayedFailure.onClose(() => delayedCloses.push('closed'));
  await delay(30);
  assert.deepEqual(delayedCloses, ['closed']);

  const httpFail = await failingTransport(async () => ({
    ok: false,
    status: 503,
    async json() {
      return {};
    },
  }));
  assert.equal(httpFail.readyState, 'closed');

  const invalidJson = await failingTransport(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {};
    },
  }));
  assert.equal(invalidJson.readyState, 'closed');

  const invalidData = await failingTransport(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { data: null };
    },
  }));
  assert.equal(invalidData.readyState, 'closed');

  const dataExecutionId = new mod.BoxLiteTerminalTransport(
    'task-data-execution',
    descriptor({ workspacePath: undefined }),
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: { execution_id: 'exec-data' } };
        },
      }),
      logger: { warn() {} },
    },
  );
  await delay(20);
  assert.equal(dataExecutionId.readyState, 'closed');
  dataExecutionId.close();

  const endpointWsFallback = new mod.BoxLiteTerminalTransport(
    'task-endpoint-ws-fallback',
    {
      protocol: 'boxlite-v1',
      metadata: {
        endpoint: 'http://127.0.0.1:9/',
        sandboxId: 'box-task',
      },
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { execution_id: 'exec-endpoint-ws' };
        },
      }),
      logger: { warn() {} },
    },
  );
  await delay(20);
  assert.equal(endpointWsFallback.readyState, 'closed');
  endpointWsFallback.close();

  const idFallback = new mod.BoxLiteTerminalTransport(
    'task-id-fallback',
    descriptor({ pathPrefix: '/custom/path/' }),
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { id: 'exec-id-fallback' };
        },
      }),
      logger: { warn() {} },
    },
  );
  await delay(20);
  assert.equal(idFallback.readyState, 'closed');
  idFallback.close();

  const factory = mod.createBoxLiteTerminalTransportFactory({
    taskId: 'task-factory',
    descriptor: descriptor({ pathPrefix: '' }),
    apiToken: 'token',
    fetch: async () => {
      throw 'factory failure';
    },
    logger: { warn() {} },
  });
  const factoryTransport = factory.open();
  await delay(20);
  assert.equal(factoryTransport.readyState, 'closed');

  assert.throws(
    () =>
      new mod.BoxLiteTerminalTransport('task-missing-endpoint', {
        protocol: 'boxlite-v1',
      }),
    /missing endpoint/,
  );
  assert.throws(
    () =>
      new mod.BoxLiteTerminalTransport('task-missing-endpoint', {
        protocol: 'boxlite-v1',
        metadata: { sandboxId: 'box' },
      }),
    /missing endpoint/,
  );
  assert.throws(
    () =>
      new mod.BoxLiteTerminalTransport('task-missing-sandbox', {
        protocol: 'boxlite-v1',
        metadata: { endpoint: 'http://127.0.0.1:9' },
      }),
    /missing sandboxId/,
  );
  assert.throws(
    () =>
      new mod.BoxLiteTerminalTransport('task-invalid-generation', descriptor(), {
        bridgeGenerationFactory: () => 'invalid generation',
      }),
    /generation was invalid/,
  );
});

await test('covers binary, control, decoder, and raw payload edge cases', async () => {
  const transport = await failingTransport();
  const frames = [];
  const errors = [];
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error.message));
  transport.closedLatch = false;
  transport.state = 'connecting';
  transport.socket = new FakeSocket();
  const generation = transport.bridgeGeneration;

  transport.onMessage('not-json', false);
  transport.onMessage('null', false);
  transport.onMessage('{}', false);
  transport.onMessage(
    [
      Buffer.from([mod.BOXLITE_TERMINAL_CHANNELS.stdout]),
      Buffer.from(`R ${generation} 1 500 shell 80 24\n`, 'ascii'),
    ],
    true,
  );
  const split = Buffer.from('中', 'utf8');
  const firstOutput = Buffer.concat([
    Buffer.from([mod.BOXLITE_TERMINAL_CHANNELS.stdout]),
    Buffer.from(`O ${generation} 1 ${split.subarray(0, 1).toString('base64')}\n`),
  ]);
  transport.onMessage(
    new Uint8Array(firstOutput).buffer,
    true,
  );
  transport.onMessage(
    Buffer.concat([
      Buffer.from([mod.BOXLITE_TERMINAL_CHANNELS.stdout]),
      Buffer.from(`O ${generation} 2 ${split.subarray(1).toString('base64')}\n`),
      Buffer.from(`X ${generation} child_exit 0\n`),
    ]),
    true,
  );
  transport.onMessage('{"type":"exit","exit_code":0}', false);
  transport.onMessage('{"type":"error","message":"bad control"}', false);

  assert.deepEqual(errors, ['BoxLite terminal control error']);
  assert.equal(errors.includes('bad control'), false);
  assert.ok(frames.some((frame) => frame.type === 'exit' && frame.data === '0'));
  assert.equal(
    frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame.data)
      .join(''),
    '中',
  );
});

await test('late cleanup response cannot settle an attempt twice', async () => {
  let resolveLateCleanup;
  const transport = await failingTransport(async (_url, init = {}) => {
    if (init.method === 'GET') {
      return new Promise((resolve) => {
        resolveLateCleanup = resolve;
      });
    }
    throw new Error('start failed');
  });
  const attempt = transport.fetchExecutionCleanup(
    'late-cleanup',
    'GET',
    Date.now() + 20,
  );
  assert.equal(await attempt, null);
  resolveLateCleanup({ status: 404 });
  await delay(10);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
