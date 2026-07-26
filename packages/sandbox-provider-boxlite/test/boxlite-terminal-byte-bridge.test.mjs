import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);
const GENERATION = 'edge-generation';

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

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  closed = false;

  send(payload) {
    this.sent.push(payload);
  }

  pause() {}
  resume() {}

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

function bridgeMessage(payload, channel = mod.BOXLITE_TERMINAL_CHANNELS.stdout) {
  return Buffer.concat([Buffer.from([channel]), Buffer.from(payload)]);
}

async function harness({
  executionId = 'edge-execution',
  secret = 'edge-secret',
  handshakeTimeoutMs = 100,
} = {}) {
  const socket = new FakeSocket();
  const fetchCalls = [];
  const frames = [];
  const errors = [];
  const closes = [];
  const logs = [];
  const transport = new mod.BoxLiteTerminalTransport('edge-task', descriptor(), {
    apiToken: secret,
    bridgeGenerationFactory: () => GENERATION,
    bridgeHandshakeTimeoutMs: handshakeTimeoutMs,
    cleanupAttemptTimeoutMs: 25,
    cleanupRetryDelayMs: 0,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      if (init.method === 'POST') {
        return response(200, { execution_id: executionId });
      }
      if (init.method === 'DELETE') return response(204);
      if (init.method === 'GET') return response(404);
      throw new Error('unexpected method');
    },
    logger: { warn: (message) => logs.push(message) },
    webSocketFactory: () => socket,
  });
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error.message));
  transport.onClose(() => closes.push('closed'));
  await delay();
  socket.open();
  return { transport, socket, fetchCalls, frames, errors, closes, logs };
}

function ready(socket, pid = 401) {
  socket.emit(
    'message',
    bridgeMessage(`R ${GENERATION} 1 ${pid} shell 80 24\n`),
    true,
  );
}

async function cleanup(h) {
  if (h.transport.readyState !== 'closed') h.transport.close();
  return h.transport.cleanupDecision;
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

await test('WebSocket open is gated until one matching bridge R frame', async () => {
  const h = await harness();
  assert.equal(h.transport.readyState, 'connecting');
  assert.equal(h.transport.sendInput('blocked'), false);
  assert.equal(
    h.transport.sendInputBytes(Uint8Array.of(0x80)),
    'unsupported',
  );
  assert.equal(h.transport.sendResize(80, 24), false);
  const line = Buffer.from(`R ${GENERATION} 1 400 shell 80 24\n`, 'ascii');
  h.socket.emit('message', bridgeMessage(line.subarray(0, 9)), true);
  assert.equal(h.transport.readyState, 'connecting');
  h.socket.emit('message', bridgeMessage(line.subarray(9)), true);
  assert.equal(h.transport.readyState, 'open');
  assert.equal(h.frames.filter((frame) => frame.type === 'ready').length, 1);
  assert.equal((await cleanup(h)).kind, 'confirmed');
});

for (const [name, frame] of [
  ['stale generation', `O stale-generation 1 YQ==\n`],
  ['wrong sequence', `O ${GENERATION} 2 YQ==\n`],
  ['noncanonical base64', `O ${GENERATION} 1 Zh==\n`],
]) {
  await test(`${name} fails closed without emitting guessed bytes`, async () => {
    const h = await harness();
    ready(h.socket);
    h.socket.emit('message', bridgeMessage(frame), true);
    assert.equal(h.transport.readyState, 'closed');
    assert.equal(h.errors.length, 1);
    assert.equal(h.frames.some((item) => item.type === 'output'), false);
    assert.equal(h.closes.length, 1);
    assert.equal((await h.transport.cleanupDecision).kind, 'confirmed');
  });
}

await test('oversized and non-ASCII bridge envelopes fail closed', async () => {
  const oversized = await harness();
  ready(oversized.socket);
  oversized.socket.emit(
    'message',
    bridgeMessage(Buffer.alloc(24_001, 0x41)),
    true,
  );
  assert.equal(oversized.transport.readyState, 'closed');
  assert.equal(oversized.errors.length, 1);
  assert.equal((await oversized.transport.cleanupDecision).kind, 'confirmed');

  const nonAscii = await harness();
  ready(nonAscii.socket);
  nonAscii.socket.emit(
    'message',
    bridgeMessage(Buffer.from([0xef, 0xbf, 0xbd])),
    true,
  );
  assert.equal(nonAscii.transport.readyState, 'closed');
  assert.equal(nonAscii.errors.length, 1);
  assert.equal((await nonAscii.transport.cleanupDecision).kind, 'confirmed');
});

for (const [name, prepare, send] of [
  [
    'empty native binary frame',
    () => {},
    (h) => h.socket.emit('message', Buffer.alloc(0), true),
  ],
  [
    'unknown native binary channel',
    ready,
    (h) => h.socket.emit('message', bridgeMessage('x', 99), true),
  ],
  [
    'native exit before bridge exit',
    () => {},
    (h) => h.socket.emit('message', '{"type":"exit","exit_code":127}', false),
  ],
  [
    'oversized terminated line',
    ready,
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(Buffer.concat([Buffer.alloc(24_001, 0x41), Buffer.from('\n')])),
        true,
      ),
  ],
  [
    'valid bridge rejection frame',
    ready,
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`E ${GENERATION} frame_invalid\n`),
        true,
      ),
  ],
  [
    'malformed bridge rejection frame',
    ready,
    (h) => h.socket.emit('message', bridgeMessage(`E ${GENERATION}\n`), true),
  ],
  [
    'stale bridge rejection frame',
    ready,
    (h) => h.socket.emit('message', bridgeMessage('E stale frame_invalid\n'), true),
  ],
  [
    'unknown bridge frame',
    ready,
    (h) => h.socket.emit('message', bridgeMessage(`Q ${GENERATION}\n`), true),
  ],
  [
    'invalid ready frame',
    () => {},
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`R ${GENERATION} 1 1 tmux 80 24\n`),
        true,
      ),
  ],
  [
    'truncated ready frame',
    () => {},
    (h) => h.socket.emit('message', bridgeMessage('R\n'), true),
  ],
  [
    'duplicate ready frame',
    ready,
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`R ${GENERATION} 1 1 shell 80 24\n`),
        true,
      ),
  ],
  [
    'output before ready',
    () => {},
    (h) => h.socket.emit('message', bridgeMessage(`O ${GENERATION} 1 YQ==\n`), true),
  ],
  [
    'invalid output sequence grammar',
    ready,
    (h) => h.socket.emit('message', bridgeMessage(`O ${GENERATION} 01 YQ==\n`), true),
  ],
  [
    'empty output payload',
    ready,
    (h) => h.socket.emit('message', bridgeMessage(`O ${GENERATION} 1 \n`), true),
  ],
  [
    'out-of-range exit code',
    ready,
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`X ${GENERATION} child_exit 256\n`),
        true,
      ),
  ],
  [
    'invalid exit grammar',
    ready,
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`X ${GENERATION} CHILD_EXIT 0\n`),
        true,
      ),
  ],
  [
    'output after bridge exit',
    (socket) => {
      ready(socket);
      socket.emit(
        'message',
        bridgeMessage(`X ${GENERATION} child_exit 0\n`),
        true,
      );
    },
    (h) => h.socket.emit('message', bridgeMessage(`O ${GENERATION} 1 YQ==\n`), true),
  ],
  [
    'duplicate bridge exit',
    (socket) => {
      ready(socket);
      socket.emit(
        'message',
        bridgeMessage(`X ${GENERATION} child_exit 0\n`),
        true,
      );
    },
    (h) =>
      h.socket.emit(
        'message',
        bridgeMessage(`X ${GENERATION} child_exit 0\n`),
        true,
      ),
  ],
]) {
  await test(`${name} is rejected without output`, async () => {
    const h = await harness();
    prepare(h.socket);
    send(h);
    assert.equal(h.transport.readyState, 'closed');
    assert.equal(h.errors.length, 1);
    assert.equal(h.frames.some((frame) => frame.type === 'output'), false);
    assert.equal((await h.transport.cleanupDecision).kind, 'confirmed');
  });
}

await test('missing bridge stderr is explicit, exact-cleaned, and identity-free', async () => {
  const secret = 'CAP_BRIDGE_SECRET';
  const executionId = 'CAP_PROVIDER_EXECUTION_ID';
  const h = await harness({ secret, executionId });
  h.socket.emit(
    'message',
    bridgeMessage(
      Buffer.from(`${secret}:${executionId}`),
      mod.BOXLITE_TERMINAL_CHANNELS.stderr,
    ),
    true,
  );
  const settlement = await h.transport.cleanupDecision;
  assert.equal(h.transport.readyState, 'closed');
  assert.deepEqual(h.errors, ['BoxLite terminal byte bridge failed']);
  assert.equal(settlement.kind, 'confirmed');
  assert.equal(h.fetchCalls[1].init.method, 'DELETE');
  assert.equal(h.fetchCalls[2].init.method, 'GET');
  const publicEvidence = JSON.stringify({
    frames: h.frames,
    errors: h.errors,
    closes: h.closes,
    logs: h.logs,
    settlement,
  });
  assert.equal(publicEvidence.includes(secret), false);
  assert.equal(publicEvidence.includes(executionId), false);
  assert.deepEqual(h.frames, [{ type: 'session_id' }]);
});

await test('missing R times out with an explicit bridge error', async () => {
  const h = await harness({ handshakeTimeoutMs: 10 });
  await delay(30);
  assert.equal(h.transport.readyState, 'closed');
  assert.deepEqual(h.errors, [
    'BoxLite terminal byte bridge readiness timed out',
  ]);
  assert.equal((await h.transport.cleanupDecision).kind, 'confirmed');
});

await test('unexpected close before R is explicit and exactly cleaned', async () => {
  const h = await harness();
  h.socket.close();
  assert.equal(h.transport.readyState, 'closed');
  assert.deepEqual(h.errors, [
    'BoxLite terminal byte bridge closed unexpectedly',
  ]);
  assert.equal((await h.transport.cleanupDecision).kind, 'confirmed');
});

await test('close after R requires a complete bridge X frame', async () => {
  const missingExit = await harness();
  ready(missingExit.socket);
  missingExit.socket.close();
  assert.deepEqual(missingExit.errors, [
    'BoxLite terminal byte bridge closed unexpectedly',
  ]);
  assert.equal((await missingExit.transport.cleanupDecision).kind, 'confirmed');

  const cleanExit = await harness();
  ready(cleanExit.socket);
  cleanExit.socket.emit(
    'message',
    bridgeMessage(`X ${GENERATION} child_exit 0\n`),
    true,
  );
  cleanExit.socket.close();
  assert.deepEqual(cleanExit.errors, []);
  assert.equal((await cleanExit.transport.cleanupDecision).kind, 'confirmed');

  const truncatedAfterExit = await harness();
  ready(truncatedAfterExit.socket);
  truncatedAfterExit.socket.emit(
    'message',
    bridgeMessage(`X ${GENERATION} child_exit 0\nO`),
    true,
  );
  truncatedAfterExit.socket.close();
  assert.deepEqual(truncatedAfterExit.errors, [
    'BoxLite terminal byte bridge closed unexpectedly',
  ]);
  assert.equal(
    (await truncatedAfterExit.transport.cleanupDecision).kind,
    'confirmed',
  );
});

await test('close before R emits no false error and confirms exact cleanup', async () => {
  const h = await harness();
  h.transport.close();
  const settlement = await h.transport.cleanupDecision;
  assert.equal(settlement.kind, 'confirmed');
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.closes, ['closed']);
  assert.deepEqual(
    h.fetchCalls.map(({ init }) => init.method),
    ['POST', 'DELETE', 'GET'],
  );
  assert.equal(
    h.socket.sent.some((payload) =>
      Buffer.isBuffer(payload) && payload.toString('ascii').startsWith('C '),
    ),
    false,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
