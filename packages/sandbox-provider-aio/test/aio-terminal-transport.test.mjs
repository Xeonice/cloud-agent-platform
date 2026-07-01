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

class FakeSocket {
  readyState = 0;
  sent = [];
  paused = false;
  resumed = false;
  closed = false;
  throwOnClose = false;
  listeners = new Map();

  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.resumed = true;
  }

  close() {
    this.closed = true;
    if (this.throwOnClose) throw new Error('already closed');
    this.emit('close');
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

await test('normalizes ready states and parses supported frame payloads', async () => {
  assert.equal(mod.normalizeAioWebSocketReadyState(0), 'connecting');
  assert.equal(mod.normalizeAioWebSocketReadyState(1), 'open');
  assert.equal(mod.normalizeAioWebSocketReadyState(2), 'closing');
  assert.equal(mod.normalizeAioWebSocketReadyState(3), 'closed');
  assert.equal(mod.normalizeAioWebSocketReadyState(99), 'closed');

  assert.deepEqual(mod.parseAioTerminalFrame('{"type":"ready"}'), {
    type: 'ready',
  });
  assert.deepEqual(mod.parseAioTerminalFrame(Buffer.from('{"type":"output","data":"x"}')), {
    type: 'output',
    data: 'x',
  });
  assert.deepEqual(
    mod.parseAioTerminalFrame([Buffer.from('{"type":"'), Buffer.from('ping"}')]),
    { type: 'ping' },
  );
  assert.deepEqual(
    mod.parseAioTerminalFrame(
      new TextEncoder().encode('{"type":"session_id","data":"s"}').buffer,
    ),
    { type: 'session_id', data: 's' },
  );
  assert.equal(mod.parseAioTerminalFrame('not-json'), null);
  assert.equal(mod.parseAioTerminalFrame('null'), null);
  assert.equal(mod.parseAioTerminalFrame('{"type":7}'), null);
});

await test('wraps socket events and outbound frames', async () => {
  const socket = new FakeSocket();
  const logs = [];
  const transport = new mod.AioTerminalTransport('task-transport', 'ws://unused', {
    socketFactory: () => socket,
    logger: { warn: (message) => logs.push(message) },
  });
  const frames = [];
  const closes = [];
  const errors = [];
  const frameSub = transport.onFrame((frame) => frames.push(frame));
  const closeSub = transport.onClose(() => closes.push('closed'));
  const errorSub = transport.onError((err) => errors.push(err.message));

  assert.equal(transport.readyState, 'connecting');
  assert.equal(transport.sendInput('queued'), false);
  socket.readyState = 1;
  assert.equal(transport.readyState, 'open');
  assert.equal(transport.sendInput('abc'), true);
  assert.equal(transport.sendResize(120, 40), true);
  assert.equal(transport.sendPong(123), true);
  assert.deepEqual(socket.sent, [
    { type: 'input', data: 'abc' },
    { type: 'resize', data: { cols: 120, rows: 40 } },
    { type: 'pong', timestamp: 123 },
  ]);

  transport.pause();
  transport.resume();
  assert.equal(socket.paused, true);
  assert.equal(socket.resumed, true);

  socket.emit('message', '{"type":"output","data":"hello"}');
  socket.emit('message', 'not-json');
  assert.deepEqual(frames, [{ type: 'output', data: 'hello' }]);

  const err = new Error('boom');
  socket.emit('error', err);
  assert.deepEqual(errors, ['boom']);
  assert.match(logs[0], /task task-transport: sandbox terminal WS error: boom/);

  socket.readyState = 2;
  assert.equal(transport.readyState, 'closing');
  socket.readyState = 3;
  transport.close();
  assert.equal(socket.closed, true);
  assert.deepEqual(closes, ['closed']);

  frameSub.dispose();
  closeSub.dispose();
  errorSub.dispose();
  socket.emit('message', '{"type":"output","data":"after"}');
  socket.emit('close');
  socket.emit('error', new Error('after'));
  assert.deepEqual(frames, [{ type: 'output', data: 'hello' }]);
  assert.deepEqual(closes, ['closed']);
  assert.deepEqual(errors, ['boom']);
});

await test('factory creates transports and close is best-effort', async () => {
  const socket = new FakeSocket();
  socket.readyState = 1;
  socket.throwOnClose = true;
  const factory = mod.createAioTerminalTransportFactory({
    taskId: 'task-factory',
    wsUrl: 'ws://127.0.0.1:9',
    logger: { warn: () => undefined },
  });
  assert.equal(typeof factory.open, 'function');
  const realTransport = factory.open();
  realTransport.close();

  const transport = new mod.AioTerminalTransport('task-factory', 'ws://unused', {
    socketFactory: () => socket,
  });
  assert.doesNotThrow(() => transport.close());
  assert.equal(socket.closed, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
