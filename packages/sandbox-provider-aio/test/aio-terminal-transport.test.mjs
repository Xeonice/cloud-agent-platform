import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mock } from 'node:test';

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
  throwOnSendCall = null;
  callbackErrorOnSendCall = null;
  sendCalls = 0;
  sentRaw = [];
  listeners = new Map();

  on(event, listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  send(data, callback) {
    this.sendCalls += 1;
    if (this.throwOnSendCall === this.sendCalls) {
      throw new Error('sensitive synchronous write failure');
    }
    this.sentRaw.push(data);
    this.sent.push(JSON.parse(data));
    if (this.callbackErrorOnSendCall === this.sendCalls) {
      queueMicrotask(() => callback?.(new Error('sensitive async write failure')));
    }
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

const MARKER_NONCES = {
  main: 'main00000001',
  injector: 'injector00000001',
  loop: 'loop00000001',
  ownership: 'ownership00000001',
};

const EXPECTED_MARKERS = {
  main: `CAP_AIO_MAIN_SHELL_READY_${MARKER_NONCES.main}`,
  injector: `CAP_AIO_INJECTOR_SHELL_READY_${MARKER_NONCES.injector}`,
  loopReady: `CAP_AIO_INJECTOR_READY_${MARKER_NONCES.loop}`,
  loopFailed: `CAP_AIO_INJECTOR_FAILED_${MARKER_NONCES.loop}`,
  loopClose: `: CAP_AIO_INJECTOR_CLOSE_${MARKER_NONCES.loop}`,
  loopReleased: `CAP_AIO_INJECTOR_RELEASED_${MARKER_NONCES.loop}`,
  ownership: `CAP_AIO_OWNERSHIP_READY_${MARKER_NONCES.ownership}`,
};

const TEST_BOOT_ID = '11111111-1111-4111-8111-111111111111';

function providerSessionId(slot) {
  const prefix = Number(slot).toString(16).padStart(8, '0');
  const suffix = Number(slot).toString(16).padStart(12, '0');
  return `${prefix}-0000-4000-8000-${suffix}`;
}

const DEFAULT_MAIN_SESSION_ID = providerSessionId(1);
const DEFAULT_INJECTOR_SESSION_ID = providerSessionId(2);

function guestIdentityLine(marker, tty, pid) {
  return `\r\n${marker} tty=${tty} pid=${pid} sid=${pid} pgid=${pid} start=${pid}00 boot=${TEST_BOOT_ID}\r\n`;
}

function createOpaqueHarness(taskId = 'opaque-alpha', extraOptions = {}) {
  const sockets = {};
  const transport = new mod.AioTerminalTransport(
    taskId,
    'ws://user:URL_SECRET@unused/v1/shell/ws?token=QUERY_SECRET',
    {
      enableOpaqueInput: true,
      markerFactory: (role) => MARKER_NONCES[role],
      socketFactory: (_url, role) => {
        const socket = new FakeSocket();
        sockets[role] = socket;
        return socket;
      },
      guestPairReleaser: async () => ({ kind: 'confirmed', cause: null }),
      ...extraOptions,
    },
  );
  return { transport, sockets };
}

function emitFrame(socket, frame) {
  socket.emit('message', JSON.stringify(frame));
}

function openProviderEndpoint(socket, sessionId) {
  socket.readyState = 1;
  emitFrame(socket, { type: 'session_id', data: sessionId });
  emitFrame(socket, { type: 'ready' });
}

function completeOpaqueHandshake(
  harness,
  {
    mainTty = '/dev/pts/31',
    injectorTty = '/dev/pts/32',
    mainSessionId = DEFAULT_MAIN_SESSION_ID,
    injectorSessionId = DEFAULT_INJECTOR_SESSION_ID,
  } = {},
) {
  const { transport, sockets } = harness;
  openProviderEndpoint(sockets.main, mainSessionId);
  openProviderEndpoint(sockets.injector, injectorSessionId);

  const mainProbe = sockets.main.sent.at(-1).data;
  const injectorProbe = sockets.injector.sent.at(-1).data;
  assert.equal(mainProbe.includes(EXPECTED_MARKERS.main), false);
  assert.equal(injectorProbe.includes(EXPECTED_MARKERS.injector), false);
  assert.equal(spawnSync('bash', ['-n', '-c', mainProbe]).status, 0);
  assert.equal(spawnSync('bash', ['-n', '-c', injectorProbe]).status, 0);

  // Echoing the submitted commands cannot satisfy the marker handshake.
  emitFrame(sockets.main, { type: 'output', data: mainProbe });
  emitFrame(sockets.injector, { type: 'output', data: injectorProbe });
  assert.equal(transport.opaqueInputCapability, 'unsupported');

  emitFrame(sockets.main, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.main, mainTty, '3101').slice(0, 24),
  });
  emitFrame(sockets.main, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.main, mainTty, '3101').slice(24),
  });
  emitFrame(sockets.injector, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.injector, injectorTty, '3201'),
  });

  let loopCommand = sockets.injector.sent.at(-1).data;
  if (loopCommand.includes('.cap-aio-terminal-pairs-v2')) {
    assert.equal(loopCommand.includes(EXPECTED_MARKERS.ownership), false);
    assert.equal(spawnSync('bash', ['-n', '-c', loopCommand]).status, 0);
    emitFrame(sockets.injector, {
      type: 'output',
      data: `\r\n${EXPECTED_MARKERS.ownership}\r\n`,
    });
    loopCommand = sockets.injector.sent.at(-1).data;
  }
  assert.equal(loopCommand.includes(EXPECTED_MARKERS.loopReady), false);
  assert.equal(loopCommand.includes(EXPECTED_MARKERS.loopFailed), false);
  assert.equal(loopCommand.includes(EXPECTED_MARKERS.loopReleased), false);
  assert.equal(spawnSync('bash', ['-n', '-c', loopCommand]).status, 0);
  assert.equal(transport.opaqueInputCapability, 'unsupported');

  emitFrame(sockets.injector, {
    type: 'output',
    data: EXPECTED_MARKERS.loopReady.slice(0, 12),
  });
  emitFrame(sockets.injector, {
    type: 'output',
    data: `${EXPECTED_MARKERS.loopReady.slice(12)}\r\n`,
  });
  return loopCommand;
}

function sessionIdFromCleanupUrl(input) {
  return decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1));
}

function cleanupResponse(sessionId, body = { success: true }) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        ...body,
        data: { session_id: sessionId },
      };
    },
  };
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
  assert.equal(transport.opaqueInputCapability, 'unsupported');
  assert.equal(
    transport.sendTerminalResponseBytes(Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e)),
    'written',
  );
  assert.equal(
    transport.sendInputBytes(Uint8Array.of(0x00, 0x7f, 0x80, 0xff)),
    'unsupported',
  );
  assert.equal(transport.sendResize(120, 40), true);
  assert.equal(transport.sendPong(123), true);
  assert.deepEqual(socket.sent, [
    { type: 'input', data: 'abc' },
    { type: 'input', data: '\u001b[0n' },
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
  assert.deepEqual(errors, ['AIO terminal main WebSocket failed']);
  assert.match(logs[0], /task task-transport: AIO terminal main WebSocket failed/);

  socket.readyState = 2;
  assert.equal(transport.readyState, 'closing');
  socket.readyState = 3;
  assert.equal(transport.sendInputBytes(Uint8Array.of(0xff)), 'closed');
  assert.equal(
    transport.sendTerminalResponseBytes(Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e)),
    'closed',
  );
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
  assert.deepEqual(errors, ['AIO terminal main WebSocket failed']);
});

await test('viewer opt-in gates readiness on two distinct AIO sessions and an echo-safe loop marker', async () => {
  const releasedPairs = [];
  const harness = createOpaqueHarness('opaque-alpha', {
    baseUrl: 'http://aio.test',
    fetch: async (input, init) => {
      assert.equal(init.method, 'DELETE');
      return cleanupResponse(sessionIdFromCleanupUrl(input));
    },
    cleanupRetryDelayMs: 0,
    guestPairReleaser: async ({ pair }) => {
      releasedPairs.push(pair);
      return { kind: 'confirmed', cause: null };
    },
  });
  const { transport, sockets } = harness;
  const frames = [];
  const errors = [];
  const closes = [];
  transport.onFrame((frame) => frames.push(frame));
  transport.onError((error) => errors.push(error.message));
  transport.onClose(() => closes.push('closed'));

  assert.equal(transport.readyState, 'connecting');
  assert.equal(transport.opaqueInputCapability, 'unsupported');
  assert.equal(transport.sendInput('premature'), false);
  assert.equal(transport.sendInputBytes(Uint8Array.of(0xff)), 'unsupported');

  sockets.main.readyState = 1;
  sockets.injector.readyState = 1;
  assert.equal(transport.sendInputBytes(Uint8Array.of(0xff)), 'unsupported');
  const loopCommand = completeOpaqueHandshake(harness);

  assert.equal(transport.readyState, 'open');
  assert.equal(transport.opaqueInputCapability, 'byte-preserving');
  assert.deepEqual(frames, [
    { type: 'session_id', data: DEFAULT_MAIN_SESSION_ID },
    { type: 'ready' },
  ]);
  assert.match(loopCommand, /tmux send-keys -H -t '=taskopaque-alpha:' "\$@"/u);
  assert.match(loopCommand, /CAP_AIO_INJECTOR_CLOSE_loop00000001/u);
  assert.match(loopCommand, /: CAP_AIO_INJECTOR_CLOSE_loop00000001/u);
  assert.ok(Buffer.byteLength(loopCommand, 'utf8') <= 1_024);
  assert.equal(loopCommand.endsWith('\n'), true);
  assert.equal(loopCommand.slice(0, -1).includes('\n'), false);
  assert.match(
    loopCommand,
    /CAP_AIO_INJECTOR_RELEASED_%s\\r\\n' 'loop00000001'/u,
  );
  assert.doesNotMatch(loopCommand, /detach-client|list-clients|\/dev\/pts\/31/u);
  assert.doesNotMatch(loopCommand, /kill-session|kill-server|display-message|TMUX_PANE/u);

  emitFrame(sockets.main, { type: 'output', data: 'live-output' });
  emitFrame(sockets.injector, { type: 'output', data: 'injector-noise' });
  emitFrame(sockets.main, { type: 'output', data: '\ufffd\ufffd' });
  assert.deepEqual(frames.slice(2), [
    { type: 'output', data: 'live-output' },
    { type: 'output', data: '\ufffd\ufffd' },
  ]);
  assert.deepEqual(
    [...new TextEncoder().encode(frames.at(-1).data)],
    [0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd],
    'AIO output remains an explicitly characterized UTF-8 text stream',
  );

  assert.equal(transport.sendInput('attach-command'), true);
  assert.equal(transport.sendResize(120, 40), true);
  assert.equal(transport.sendPong(123), true);
  transport.pause();
  transport.resume();
  assert.equal(sockets.main.paused, true);
  assert.equal(sockets.main.resumed, true);
  assert.equal(sockets.injector.paused, false);

  transport.close();
  transport.close();
  assert.deepEqual(closes, ['closed']);
  assert.deepEqual(errors, []);
  assert.equal(sockets.main.closed, true);
  assert.equal(sockets.injector.closed, true);
  assert.equal((await transport.cleanupDecision).kind, 'confirmed');
  assert.equal(releasedPairs.length, 1);
  assert.equal(releasedPairs[0].closeToken, EXPECTED_MARKERS.loopClose);
  const wire = [...sockets.main.sentRaw, ...sockets.injector.sentRaw].join('\n');
  assert.doesNotMatch(wire, /URL_SECRET|QUERY_SECRET|kill-session|kill-server/u);
});

await test('opaque input encodes full-range, UTF-8, mouse, and large bursts as ordered bounded canonical hex', async () => {
  const harness = createOpaqueHarness('bytes');
  const { transport, sockets } = harness;
  completeOpaqueHandshake(harness);
  const start = sockets.injector.sent.length;

  const fullRange = Uint8Array.from({ length: 256 }, (_, index) => index);
  const utf8 = new TextEncoder().encode('中文\ud83d\ude42');
  const legacyMouse = Uint8Array.of(0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x80);
  const large = Uint8Array.from({ length: 300 }, (_, index) => 299 - index);
  assert.equal(transport.sendInputBytes(new Uint8Array()), 'written');
  assert.equal(transport.sendInputBytes(fullRange), 'written');
  assert.equal(transport.sendInputBytes(utf8), 'written');
  assert.equal(transport.sendInputBytes(legacyMouse), 'written');
  assert.equal(transport.sendInputBytes(large), 'written');

  const lines = sockets.injector.sent.slice(start).map((frame) => frame.data);
  assert.equal(lines.length, 5);
  assert.equal(
    lines[0],
    `${Array.from(fullRange, (byte) => byte.toString(16).padStart(2, '0')).join(' ')}\n`,
  );
  assert.equal(
    lines[1],
    `${Array.from(utf8, (byte) => byte.toString(16).padStart(2, '0')).join(' ')}\n`,
  );
  assert.equal(lines[2], '1b 5b 4d 20 ff 80\n');
  assert.equal(lines[3].trim().split(' ').length, 256);
  assert.equal(lines[4].trim().split(' ').length, 44);
  assert.ok(lines.every((line) => /^(?:[0-9a-f]{2})(?: [0-9a-f]{2})*\n$/u.test(line)));
  assert.ok(lines.every((line) => [...line].every((char) => char.charCodeAt(0) < 128)));
  transport.close();
});

await test('routes ASCII terminal responses through main while operator bytes remain on the injector', async () => {
  const harness = createOpaqueHarness('response-channel');
  const { transport, sockets } = harness;
  completeOpaqueHandshake(harness);
  const mainStart = sockets.main.sent.length;
  const injectorStart = sockets.injector.sent.length;

  const response = Uint8Array.of(0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63);
  const operator = Uint8Array.of(0x00, 0x7f, 0x80, 0xff);
  assert.equal(transport.sendTerminalResponseBytes(response), 'written');
  assert.equal(transport.sendInputBytes(operator), 'written');

  assert.deepEqual(sockets.main.sent.slice(mainStart), [
    { type: 'input', data: '\u001b[?1;2c' },
  ]);
  assert.deepEqual(sockets.injector.sent.slice(injectorStart), [
    { type: 'input', data: '00 7f 80 ff\n' },
  ]);

  const mainAfterValidResponse = sockets.main.sent.length;
  const injectorAfterOperator = sockets.injector.sent.length;
  assert.equal(
    transport.sendTerminalResponseBytes(Uint8Array.of(0x1b, 0x80)),
    'unsupported',
  );
  assert.equal(sockets.main.sent.length, mainAfterValidResponse);
  assert.equal(sockets.injector.sent.length, injectorAfterOperator);
  transport.close();
});

await test('partial injector send failure never reports written and closes the composite transport', async () => {
  const harness = createOpaqueHarness('partial');
  const { transport, sockets } = harness;
  const errors = [];
  transport.onError((error) => errors.push(error.message));
  completeOpaqueHandshake(harness);
  sockets.injector.throwOnSendCall = sockets.injector.sendCalls + 2;

  const outcome = transport.sendInputBytes(
    Uint8Array.from({ length: 300 }, (_, index) => index),
  );
  assert.equal(outcome, 'closed');
  assert.equal(transport.readyState, 'closed');
  assert.equal(transport.opaqueInputCapability, 'unsupported');
  assert.deepEqual(errors, ['AIO terminal WebSocket write failed']);
  assert.equal(sockets.main.closed, true);
  assert.equal(sockets.injector.closed, true);
});

await test('close-before-ready fences late markers and duplicate AIO identities fail closed', async () => {
  const closedHarness = createOpaqueHarness('closed-early');
  const closedFrames = [];
  const closedEvents = [];
  closedHarness.transport.onFrame((frame) => closedFrames.push(frame));
  closedHarness.transport.onClose(() => closedEvents.push('closed'));
  closedHarness.transport.close();
  closedHarness.transport.close();
  openProviderEndpoint(closedHarness.sockets.main, 'late-main');
  openProviderEndpoint(closedHarness.sockets.injector, 'late-injector');
  emitFrame(closedHarness.sockets.main, {
    type: 'output',
    data: EXPECTED_MARKERS.main,
  });
  emitFrame(closedHarness.sockets.injector, {
    type: 'output',
    data: EXPECTED_MARKERS.injector + EXPECTED_MARKERS.loopReady,
  });
  assert.deepEqual(closedFrames, []);
  assert.deepEqual(closedEvents, ['closed']);

  const duplicateHarness = createOpaqueHarness('duplicate');
  const duplicateErrors = [];
  duplicateHarness.transport.onError((error) => duplicateErrors.push(error.message));
  openProviderEndpoint(duplicateHarness.sockets.main, providerSessionId(11));
  openProviderEndpoint(duplicateHarness.sockets.injector, providerSessionId(11));
  emitFrame(duplicateHarness.sockets.main, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.main, '/dev/pts/41', '4101'),
  });
  emitFrame(duplicateHarness.sockets.injector, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.injector, '/dev/pts/42', '4201'),
  });
  assert.deepEqual(duplicateErrors, [
    'AIO terminal sockets did not have distinct session identities',
  ]);
  assert.equal(duplicateHarness.transport.readyState, 'closed');
});

await test('managed pair rejects noncanonical and colliding reconnect identities before publish', async () => {
  const malformed = createOpaqueHarness('malformed-provider-id');
  const malformedErrors = [];
  const malformedFrames = [];
  malformed.transport.onError((error) =>
    malformedErrors.push(error.message),
  );
  malformed.transport.onFrame((frame) => malformedFrames.push(frame));
  openProviderEndpoint(malformed.sockets.main, 'not-a-canonical-uuid');
  assert.deepEqual(malformedErrors, [
    'AIO terminal main session identity was invalid',
  ]);
  assert.deepEqual(malformedFrames, []);
  assert.equal(malformed.sockets.main.sent.length, 0);

  const collision = createOpaqueHarness('colliding-provider-prefix');
  const collisionErrors = [];
  const collisionFrames = [];
  collision.transport.onError((error) =>
    collisionErrors.push(error.message),
  );
  collision.transport.onFrame((frame) => collisionFrames.push(frame));
  openProviderEndpoint(
    collision.sockets.main,
    'abcdef01-0000-4000-8000-000000000001',
  );
  openProviderEndpoint(
    collision.sockets.injector,
    'abcdef01-1111-4111-8111-000000000002',
  );
  assert.deepEqual(collisionErrors, [
    'AIO terminal sockets did not have distinct session identities',
  ]);
  assert.deepEqual(collisionFrames, []);
  assert.equal(collision.sockets.injector.sent.length, 0);
  assert.equal(
    Object.values(collision.sockets).some((socket) =>
      socket.sent.some((frame) =>
        frame.data?.includes('.cap-aio-terminal-pairs-v2'),
      ),
    ),
    false,
  );
});

await test('shell identity accepts only exact pts paths before enabling managed detach', async () => {
  const harness = createOpaqueHarness('invalid-tty');
  const errors = [];
  harness.transport.onError((error) => errors.push(error.message));
  openProviderEndpoint(harness.sockets.main, providerSessionId(12));
  openProviderEndpoint(harness.sockets.injector, providerSessionId(13));
  emitFrame(harness.sockets.main, {
    type: 'output',
    data: guestIdentityLine(EXPECTED_MARKERS.main, '/dev/pts/51', '5101'),
  });
  emitFrame(harness.sockets.injector, {
    type: 'output',
    data:
      `${EXPECTED_MARKERS.injector} tty=/tmp/not-a-pty ` +
      `pid=5201 sid=5201 pgid=5201 start=520100 boot=${TEST_BOOT_ID}\r\n`,
  });
  assert.deepEqual(errors, [
    'AIO terminal injector shell identity was invalid',
  ]);
  assert.equal(harness.transport.readyState, 'closed');
  assert.equal(
    harness.sockets.injector.sent.some((frame) =>
      frame.data?.includes('tmux detach-client'),
    ),
    false,
  );
});

await test('two byte-preserving transports remain isolated and injector loop failure is explicit', async () => {
  const first = createOpaqueHarness('first');
  const second = createOpaqueHarness('second');
  const secondFrames = [];
  second.transport.onFrame((frame) => secondFrames.push(frame));
  const firstLoop = completeOpaqueHandshake(first, {
    mainTty: '/dev/pts/61',
    injectorTty: '/dev/pts/62',
  });
  const secondLoop = completeOpaqueHandshake(second, {
    mainTty: '/dev/pts/71',
    injectorTty: '/dev/pts/72',
  });
  assert.match(firstLoop, /tmux send-keys -H -t '=taskfirst:'/u);
  assert.doesNotMatch(firstLoop, /=tasksecond:|detach-client|\/dev\/pts\//u);
  assert.match(secondLoop, /tmux send-keys -H -t '=tasksecond:'/u);
  assert.doesNotMatch(secondLoop, /=taskfirst:|detach-client|\/dev\/pts\//u);

  assert.equal(first.transport.sendInputBytes(Uint8Array.of(0xaa)), 'written');
  assert.equal(second.transport.sendInputBytes(Uint8Array.of(0xbb)), 'written');
  assert.equal(first.sockets.injector.sent.at(-1).data, 'aa\n');
  assert.equal(second.sockets.injector.sent.at(-1).data, 'bb\n');
  first.transport.close();
  assert.equal(second.transport.opaqueInputCapability, 'byte-preserving');
  emitFrame(second.sockets.main, { type: 'output', data: 'still-live' });
  assert.deepEqual(secondFrames.at(-1), { type: 'output', data: 'still-live' });

  const errors = [];
  second.transport.onError((error) => errors.push(error.message));
  emitFrame(second.sockets.injector, {
    type: 'output',
    data: `${EXPECTED_MARKERS.loopFailed} status=65\r\n`,
  });
  assert.deepEqual(errors, ['AIO terminal byte injector stopped']);
  assert.equal(second.transport.readyState, 'closed');
});

await test('close confirms both exact provider identities without deleting a peer transport', async () => {
  const firstMain = providerSessionId(21);
  const firstInjector = providerSessionId(22);
  const peerMain = providerSessionId(23);
  const peerInjector = providerSessionId(24);
  const cleanupCalls = [];
  const fetchImpl = async (input, init) => {
    assert.equal(init?.method, 'DELETE');
    const sessionId = sessionIdFromCleanupUrl(input);
    cleanupCalls.push(sessionId);
    return cleanupResponse(sessionId);
  };
  const first = createOpaqueHarness('cleanup-first', {
    baseUrl: 'http://aio.test',
    fetch: fetchImpl,
    cleanupRetryDelayMs: 0,
  });
  const peer = createOpaqueHarness('cleanup-peer', {
    baseUrl: 'http://aio.test',
    fetch: fetchImpl,
    cleanupRetryDelayMs: 0,
  });
  const peerFrames = [];
  peer.transport.onFrame((frame) => peerFrames.push(frame));
  completeOpaqueHandshake(first, {
    mainSessionId: firstMain,
    injectorSessionId: firstInjector,
  });
  completeOpaqueHandshake(peer, {
    mainSessionId: peerMain,
    injectorSessionId: peerInjector,
  });

  first.transport.close();
  assert.deepEqual(await first.transport.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
  assert.deepEqual([...cleanupCalls].sort(), [firstInjector, firstMain].sort());
  assert.equal(peer.transport.opaqueInputCapability, 'byte-preserving');
  emitFrame(peer.sockets.main, { type: 'output', data: 'peer-still-live' });
  assert.deepEqual(peerFrames.at(-1), {
    type: 'output',
    data: 'peer-still-live',
  });

  peer.transport.close();
  assert.equal((await peer.transport.cleanupDecision).kind, 'confirmed');
  assert.deepEqual(
    [...cleanupCalls].sort(),
    [firstInjector, firstMain, peerInjector, peerMain].sort(),
  );
});

await test('already-absent exact sessions are confirmed rather than retried as failures', async () => {
  const mainSessionId = providerSessionId(31);
  const injectorSessionId = providerSessionId(32);
  const attempts = new Map();
  const harness = createOpaqueHarness('cleanup-absent', {
    baseUrl: 'http://aio.test',
    cleanupRetryDelayMs: 0,
    fetch: async (input) => {
      const sessionId = sessionIdFromCleanupUrl(input);
      attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      return cleanupResponse(sessionId, {
        success: false,
        message: `Session ${sessionId} not found`,
      });
    },
  });
  completeOpaqueHandshake(harness, {
    mainSessionId,
    injectorSessionId,
  });

  harness.transport.close();
  assert.deepEqual(await harness.transport.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 2,
    cause: null,
  });
  assert.deepEqual(Object.fromEntries(attempts), {
    [mainSessionId]: 1,
    [injectorSessionId]: 1,
  });
});

await test('close stays idempotent and cleanup is not confirmed before provider replies', async () => {
  const pending = [];
  const harness = createOpaqueHarness('cleanup-pending', {
    baseUrl: 'http://aio.test',
    cleanupRetryDelayMs: 0,
    fetch: async (input) =>
      new Promise((resolve) => {
        const sessionId = sessionIdFromCleanupUrl(input);
        pending.push(() => resolve(cleanupResponse(sessionId)));
      }),
  });
  completeOpaqueHandshake(harness, {
    mainSessionId: providerSessionId(41),
    injectorSessionId: providerSessionId(42),
  });

  let settled = false;
  void harness.transport.cleanupDecision.then(() => {
    settled = true;
  });
  harness.transport.close();
  harness.transport.close();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  assert.equal(settled, false);

  for (const confirm of pending) confirm();
  assert.equal((await harness.transport.cleanupDecision).kind, 'confirmed');
  assert.equal(settled, true);
});

await test('exact cleanup retries each identity three times before confirming deletion', async () => {
  const mainSessionId = providerSessionId(51);
  const injectorSessionId = providerSessionId(52);
  const attempts = new Map();
  const harness = createOpaqueHarness('cleanup-retry', {
    baseUrl: 'http://aio.test',
    cleanupRetryDelayMs: 0,
    fetch: async (input) => {
      const sessionId = sessionIdFromCleanupUrl(input);
      const attempt = (attempts.get(sessionId) ?? 0) + 1;
      attempts.set(sessionId, attempt);
      if (attempt < 3) {
        return {
          ok: false,
          status: 503,
          async json() {
            return {};
          },
        };
      }
      return cleanupResponse(sessionId);
    },
  });
  completeOpaqueHandshake(harness, {
    mainSessionId,
    injectorSessionId,
  });

  harness.transport.close();
  const settlement = await harness.transport.cleanupDecision;
  assert.equal(settlement.kind, 'confirmed');
  assert.deepEqual(Object.fromEntries(attempts), {
    [mainSessionId]: 3,
    [injectorSessionId]: 3,
  });
});

await test('partial provider cleanup failure remains indeterminate with confirmed peer evidence', async () => {
  const mainSessionId = providerSessionId(61);
  const injectorSessionId = providerSessionId(62);
  const attempts = new Map();
  const harness = createOpaqueHarness('cleanup-failure', {
    baseUrl: 'http://aio.test',
    cleanupRetryDelayMs: 0,
    fetch: async (input) => {
      const sessionId = sessionIdFromCleanupUrl(input);
      attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      if (sessionId === mainSessionId) return cleanupResponse(sessionId);
      return {
        ok: false,
        status: 500,
        async json() {
          return { success: false };
        },
      };
    },
  });
  completeOpaqueHandshake(harness, {
    mainSessionId,
    injectorSessionId,
  });

  harness.transport.close();
  assert.deepEqual(await harness.transport.cleanupDecision, {
    kind: 'indeterminate',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 1,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unconfirmed',
  });
  assert.deepEqual(Object.fromEntries(attempts), {
    [mainSessionId]: 1,
    [injectorSessionId]: 3,
  });
});

await test('cleanup settlement is bounded when provider requests ignore abort signals', async () => {
  let attempts = 0;
  const harness = createOpaqueHarness('cleanup-timeout', {
    baseUrl: 'http://aio.test',
    cleanupAttemptTimeoutMs: 5,
    cleanupRetryDelayMs: 0,
    fetch: async () => {
      attempts += 1;
      return new Promise(() => undefined);
    },
  });
  completeOpaqueHandshake(harness, {
    mainSessionId: providerSessionId(71),
    injectorSessionId: providerSessionId(72),
  });

  const startedAt = Date.now();
  harness.transport.close();
  const settlement = await harness.transport.cleanupDecision;
  assert.equal(settlement.kind, 'indeterminate');
  assert.equal(settlement.cause, 'cleanup-unconfirmed');
  assert.equal(settlement.confirmedIdentities, 0);
  assert.equal(attempts, 6);
  assert.ok(Date.now() - startedAt < 500, 'cleanup must settle within its bounded retry budget');
});

await test('injector creation and runtime errors redact endpoint credentials', async () => {
  const main = new FakeSocket();
  assert.throws(
    () =>
      new mod.AioTerminalTransport(
        'redacted',
        'ws://user:OPEN_SECRET@unused?token=QUERY_SECRET',
        {
          enableOpaqueInput: true,
          markerFactory: (role) => MARKER_NONCES[role],
          socketFactory: (_url, role) => {
            if (role === 'main') return main;
            throw new Error('OPEN_SECRET QUERY_SECRET');
          },
        },
      ),
    (error) =>
      error.message === 'AIO terminal injector WebSocket could not be opened' &&
      !/OPEN_SECRET|QUERY_SECRET/u.test(error.message),
  );
  assert.equal(main.closed, true);

  const logs = [];
  const harness = createOpaqueHarness('runtime-redaction', {
    logger: { warn: (message) => logs.push(message) },
  });
  const errors = [];
  harness.transport.onError((error) => errors.push(error.message));
  harness.sockets.injector.emit('error', new Error('URL_SECRET QUERY_SECRET'));
  assert.deepEqual(errors, ['AIO terminal injector WebSocket failed']);
  assert.doesNotMatch(errors.join(' ') + logs.join(' '), /URL_SECRET|QUERY_SECRET/u);
});

await test('owned readiness journals encrypted identities before attach and graceful close removes exact records', async () => {
  const ownershipScope = {
    taskId: 'journal-cleanup-task',
    providerSandboxId: 'PROVIDER_SANDBOX_SECRET',
    ownership: {
      ownerGeneration: 'OWNER_GENERATION_SECRET',
      resourceGeneration: 'RESOURCE_GENERATION_SECRET',
    },
  };
  const mainSessionId = providerSessionId(81);
  const injectorSessionId = providerSessionId(82);
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === '/v1/shell/sessions/create') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: { session_id: body.id, working_dir: '/home/gem' },
          };
        },
      };
    }
    if (url.pathname === '/v1/shell/exec') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: {
              session_id: body.id,
              command: body.command,
              status: 'completed',
              exit_code: 0,
            },
          };
        },
      };
    }
    if (init.method === 'DELETE') {
      return cleanupResponse(sessionIdFromCleanupUrl(input));
    }
    throw new Error('unexpected owned-terminal fetch');
  };
  const harness = createOpaqueHarness(ownershipScope.taskId, {
    baseUrl: 'http://aio.test',
    fetch: fetchImpl,
    cleanupRetryDelayMs: 0,
    ownershipScope,
    processFingerprint: 'a'.repeat(64),
    ownershipIvFactory: () => Uint8Array.from({ length: 12 }, () => 1),
  });
  completeOpaqueHandshake(harness, { mainSessionId, injectorSessionId });

  const probes = [
    harness.sockets.main.sent[0].data,
    harness.sockets.injector.sent[0].data,
  ];
  for (const probe of probes) {
    assert.equal(spawnSync('bash', ['-n', '-c', probe]).status, 0);
    assert.match(probe, /stty -echo/u);
    for (const secret of [
      mainSessionId,
      injectorSessionId,
      ownershipScope.providerSandboxId,
      ownershipScope.ownership.ownerGeneration,
      ownershipScope.ownership.resourceGeneration,
    ]) {
      assert.equal(probe.includes(secret), false);
    }
  }
  const registrationCommand = harness.sockets.injector.sent.find(({ data }) =>
    data.includes('/tmp/.cap-aio-terminal-pairs-v2/'),
  )?.data;
  assert.equal(typeof registrationCommand, 'string');
  assert.equal(spawnSync('bash', ['-n', '-c', registrationCommand]).status, 0);
  for (const secret of [
    mainSessionId,
    injectorSessionId,
    ownershipScope.providerSandboxId,
    ownershipScope.ownership.ownerGeneration,
    ownershipScope.ownership.resourceGeneration,
  ]) {
    assert.equal(registrationCommand.includes(secret), false);
  }

  harness.transport.close();
  assert.deepEqual(await harness.transport.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
  const rmCommand = calls.find((call) => call.path === '/v1/shell/exec').body
    .command;
  assert.match(
    rmCommand,
    /^rm -f -- '(?:\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner)'$/u,
  );
  assert.equal(rmCommand.includes(mainSessionId), false);
  assert.equal(rmCommand.includes(injectorSessionId), false);
  const exactDeletes = calls
    .filter((call) => call.method === 'DELETE')
    .map((call) =>
      decodeURIComponent(call.path.slice('/v1/shell/sessions/'.length)),
    );
  assert.equal(exactDeletes.includes(mainSessionId), true);
  assert.equal(exactDeletes.includes(injectorSessionId), true);
  assert.equal(exactDeletes.length, 3, 'journal rm REST session is also exactly deleted');
});

await test('concurrent owned pairs keep exact journal identity and allow confirmed REST rm beyond 1.5 seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const taskId = 'journal-concurrent-task';
    const ownershipScope = {
      taskId,
      providerSandboxId: 'provider-concurrent',
      ownership: {
        ownerGeneration: 'owner-concurrent',
        resourceGeneration: 'resource-concurrent',
      },
    };
    const firstIds = [providerSessionId(201), providerSessionId(202)];
    const secondIds = [providerSessionId(203), providerSessionId(204)];
    const calls = [];
    const releasedPairs = [];
    const delayedResponse = (delayMs, createResponse) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(createResponse()), delayMs);
      });
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, method: init.method, body });
      if (url.pathname === '/v1/shell/sessions/create') {
        return delayedResponse(800, () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: { session_id: body.id, working_dir: '/home/gem' },
            };
          },
        }));
      }
      if (url.pathname === '/v1/shell/exec') {
        return delayedResponse(800, () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: {
                session_id: body.id,
                command: body.command,
                status: 'completed',
                exit_code: 0,
              },
            };
          },
        }));
      }
      if (init.method === 'DELETE') {
        return cleanupResponse(sessionIdFromCleanupUrl(input));
      }
      throw new Error('unexpected concurrent journal fetch');
    };
    const transportOptions = {
      baseUrl: 'http://aio.test',
      fetch: fetchImpl,
      cleanupRetryDelayMs: 0,
      ownershipScope,
      processFingerprint: 'a'.repeat(64),
      guestPairReleaser: async ({ pair }) => {
        releasedPairs.push(pair);
        return { kind: 'confirmed', cause: null };
      },
    };
    const first = createOpaqueHarness(taskId, {
      ...transportOptions,
      ownershipIvFactory: () => Uint8Array.from({ length: 12 }, () => 1),
    });
    const second = createOpaqueHarness(taskId, {
      ...transportOptions,
      ownershipIvFactory: () => Uint8Array.from({ length: 12 }, () => 2),
    });
    completeOpaqueHandshake(first, {
      mainSessionId: firstIds[0],
      injectorSessionId: firstIds[1],
      mainTty: '/dev/pts/81',
      injectorTty: '/dev/pts/82',
    });
    completeOpaqueHandshake(second, {
      mainSessionId: secondIds[0],
      injectorSessionId: secondIds[1],
      mainTty: '/dev/pts/83',
      injectorTty: '/dev/pts/84',
    });
    const registrationPaths = [first, second].map((harness) => {
      const registrationCommand = harness.sockets.injector.sent.find(
        ({ data }) => data.includes('/tmp/.cap-aio-terminal-pairs-v2/'),
      )?.data;
      const path = registrationCommand?.match(
        /\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner/u,
      )?.[0];
      assert.equal(typeof path, 'string');
      return path;
    });
    assert.equal(new Set(registrationPaths).size, 2);

    let settlements;
    const cleanup = Promise.all([
      first.transport.cleanupDecision,
      second.transport.cleanupDecision,
    ]).then((value) => {
      settlements = value;
      return value;
    });
    first.transport.close();
    second.transport.close();
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/sessions/create').length,
      0,
    );

    mock.timers.tick(25);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/sessions/create').length,
      1,
    );

    mock.timers.tick(800);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      1,
    );
    mock.timers.tick(674);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    assert.equal(settlements, undefined, 'journal cleanup must remain pending at 1499ms');

    mock.timers.tick(126);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    assert.notEqual(settlements, undefined);
    assert.deepEqual(await cleanup, [
      {
        kind: 'confirmed',
        expectedIdentities: 2,
        observedIdentities: 2,
        confirmedIdentities: 2,
        deletedIdentities: 2,
        alreadyAbsentIdentities: 0,
        cause: null,
      },
      {
        kind: 'confirmed',
        expectedIdentities: 2,
        observedIdentities: 2,
        confirmedIdentities: 2,
        deletedIdentities: 2,
        alreadyAbsentIdentities: 0,
        cause: null,
      },
    ]);

    assert.deepEqual(
      releasedPairs.map((pair) => [pair.mainSessionId, pair.injectorSessionId]),
      [firstIds, secondIds],
    );
    const rmCommands = calls
      .filter((call) => call.path === '/v1/shell/exec')
      .map((call) => call.body.command);
    assert.equal(rmCommands.length, 1);
    const removedPaths = [...rmCommands[0].matchAll(
      /'(\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner)'/gu,
    )].map((match) => match[1]);
    assert.deepEqual(
      removedPaths,
      [...registrationPaths].sort(),
    );
    assert.equal(rmCommands[0], `rm -f -- ${removedPaths.map((path) => `'${path}'`).join(' ')}`);
    const deletedIds = calls
      .filter((call) => call.method === 'DELETE')
      .map((call) => sessionIdFromCleanupUrl(`http://aio.test${call.path}`));
    for (const sessionId of [...firstIds, ...secondIds]) {
      assert.equal(deletedIds.filter((value) => value === sessionId).length, 1);
    }
    const temporarySessionIds = calls
      .filter((call) => call.path === '/v1/shell/sessions/create')
      .map((call) => call.body.id);
    assert.equal(new Set(temporarySessionIds).size, 1);
    for (const sessionId of temporarySessionIds) {
      assert.equal(deletedIds.filter((value) => value === sessionId).length, 1);
    }
  } finally {
    mock.timers.reset();
  }
});

await test('journal coalescing is isolated by normalized endpoint, task, and fetch identity', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = [];
    const createFetch = (fetchIdentity) => async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ fetchIdentity, origin: url.origin, path: url.pathname, method: init.method, body });
      if (url.pathname === '/v1/shell/sessions/create') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: { session_id: body.id, working_dir: '/home/gem' },
            };
          },
        };
      }
      if (url.pathname === '/v1/shell/exec') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: {
                session_id: body.id,
                command: body.command,
                status: 'completed',
                exit_code: 0,
              },
            };
          },
        };
      }
      if (init.method === 'DELETE') {
        return cleanupResponse(sessionIdFromCleanupUrl(input));
      }
      throw new Error('unexpected isolated journal fetch');
    };
    const firstFetch = createFetch('first-fetch');
    const secondFetch = createFetch('second-fetch');
    const specs = [
      {
        taskId: 'journal-key-alpha',
        baseUrl: 'http://aio-one.test/',
        fetch: firstFetch,
        slot: 211,
      },
      {
        taskId: 'journal-key-alpha',
        baseUrl: 'http://aio-one.test',
        fetch: firstFetch,
        slot: 213,
      },
      {
        taskId: 'journal-key-beta',
        baseUrl: 'http://aio-one.test',
        fetch: firstFetch,
        slot: 215,
      },
      {
        taskId: 'journal-key-alpha',
        baseUrl: 'http://aio-two.test',
        fetch: firstFetch,
        slot: 217,
      },
      {
        taskId: 'journal-key-alpha',
        baseUrl: 'http://aio-one.test',
        fetch: secondFetch,
        slot: 219,
      },
    ];
    const harnesses = specs.map((spec, index) => {
      const harness = createOpaqueHarness(spec.taskId, {
        baseUrl: spec.baseUrl,
        fetch: spec.fetch,
        cleanupRetryDelayMs: 0,
        ownershipScope: {
          taskId: spec.taskId,
          providerSandboxId: `provider-${spec.taskId}`,
          ownership: {
            ownerGeneration: `owner-${spec.taskId}`,
            resourceGeneration: `resource-${spec.taskId}`,
          },
        },
        processFingerprint: 'a'.repeat(64),
        ownershipIvFactory: () =>
          Uint8Array.from({ length: 12 }, () => index + 1),
      });
      completeOpaqueHandshake(harness, {
        mainSessionId: providerSessionId(spec.slot),
        injectorSessionId: providerSessionId(spec.slot + 1),
        mainTty: `/dev/pts/${spec.slot}`,
        injectorTty: `/dev/pts/${spec.slot + 1}`,
      });
      return harness;
    });
    const registrationPaths = harnesses.map((harness) =>
      harness.sockets.injector.sent.find(
        ({ data }) => data.includes('/tmp/.cap-aio-terminal-pairs-v2/'),
      )?.data.match(
        /\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner/u,
      )?.[0],
    );
    assert.equal(registrationPaths.every((path) => typeof path === 'string'), true);
    assert.equal(new Set(registrationPaths).size, specs.length);

    for (const harness of harnesses) harness.transport.close();
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    mock.timers.tick(25);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    const settlements = await Promise.all(
      harnesses.map((harness) => harness.transport.cleanupDecision),
    );
    assert.equal(settlements.every(({ kind }) => kind === 'confirmed'), true);

    const execCalls = calls.filter((call) => call.path === '/v1/shell/exec');
    assert.equal(execCalls.length, 4);
    const removedPathGroups = execCalls.map((call) => ({
      fetchIdentity: call.fetchIdentity,
      origin: call.origin,
      paths: [...call.body.command.matchAll(
        /'(\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner)'/gu,
      )].map((match) => match[1]),
    }));
    assert.deepEqual(
      removedPathGroups.map(({ paths }) => paths.length).sort(),
      [1, 1, 1, 2],
    );
    const coalesced = removedPathGroups.find(({ paths }) => paths.length === 2);
    assert.deepEqual(coalesced, {
      fetchIdentity: 'first-fetch',
      origin: 'http://aio-one.test',
      paths: [registrationPaths[0], registrationPaths[1]].sort(),
    });
    assert.deepEqual(
      removedPathGroups.flatMap(({ paths }) => paths).sort(),
      [...registrationPaths].sort(),
    );
  } finally {
    mock.timers.reset();
  }
});

await test('one coalesced journal rm failure fails every participant and does not retain its batch', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const taskId = 'journal-shared-failure';
    const calls = [];
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, method: init.method, body });
      if (url.pathname === '/v1/shell/sessions/create') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: { session_id: body.id, working_dir: '/home/gem' },
            };
          },
        };
      }
      if (url.pathname === '/v1/shell/exec') {
        return {
          ok: false,
          status: 503,
          async json() {
            return { success: false, data: null };
          },
        };
      }
      if (init.method === 'DELETE') {
        return cleanupResponse(sessionIdFromCleanupUrl(input));
      }
      throw new Error('unexpected shared-failure journal fetch');
    };
    const createHarness = (slot, ivByte) => {
      const harness = createOpaqueHarness(taskId, {
        baseUrl: 'http://aio.test',
        fetch: fetchImpl,
        cleanupRetryDelayMs: 0,
        ownershipScope: {
          taskId,
          providerSandboxId: 'provider-shared-failure',
          ownership: {
            ownerGeneration: 'owner-shared-failure',
            resourceGeneration: 'resource-shared-failure',
          },
        },
        processFingerprint: 'a'.repeat(64),
        ownershipIvFactory: () =>
          Uint8Array.from({ length: 12 }, () => ivByte),
      });
      completeOpaqueHandshake(harness, {
        mainSessionId: providerSessionId(slot),
        injectorSessionId: providerSessionId(slot + 1),
        mainTty: `/dev/pts/${slot}`,
        injectorTty: `/dev/pts/${slot + 1}`,
      });
      return harness;
    };
    const first = createHarness(221, 1);
    const second = createHarness(223, 2);
    first.transport.close();
    second.transport.close();
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    mock.timers.tick(25);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    const firstSettlements = await Promise.all([
      first.transport.cleanupDecision,
      second.transport.cleanupDecision,
    ]);
    assert.deepEqual(
      firstSettlements.map(({ kind, cause }) => ({ kind, cause })),
      [
        { kind: 'indeterminate', cause: 'cleanup-unconfirmed' },
        { kind: 'indeterminate', cause: 'cleanup-unconfirmed' },
      ],
    );
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      1,
    );

    const afterFailure = createHarness(225, 3);
    afterFailure.transport.close();
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
    mock.timers.tick(25);
    for (let index = 0; index < 30; index += 1) await Promise.resolve();
    assert.equal((await afterFailure.transport.cleanupDecision).kind, 'indeterminate');
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      2,
      'a completed failed batch must not absorb a later cleanup',
    );
  } finally {
    mock.timers.reset();
  }
});

await test('a flushed pending journal batch cannot absorb or delete its same-key successor', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const taskId = 'journal-successor-race';
    const calls = [];
    const pendingExecs = [];
    const fetchImpl = async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, method: init.method, body });
      if (url.pathname === '/v1/shell/sessions/create') {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              success: true,
              data: { session_id: body.id, working_dir: '/home/gem' },
            };
          },
        };
      }
      if (url.pathname === '/v1/shell/exec') {
        return new Promise((resolve) => {
          pendingExecs.push(() =>
            resolve({
              ok: true,
              status: 200,
              async json() {
                return {
                  success: true,
                  data: {
                    session_id: body.id,
                    command: body.command,
                    status: 'completed',
                    exit_code: 0,
                  },
                };
              },
            }),
          );
        });
      }
      if (init.method === 'DELETE') {
        return cleanupResponse(sessionIdFromCleanupUrl(input));
      }
      throw new Error('unexpected successor-race journal fetch');
    };
    const createHarness = (slot, ivByte) => {
      const harness = createOpaqueHarness(taskId, {
        baseUrl: 'http://aio.test/',
        fetch: fetchImpl,
        cleanupRetryDelayMs: 0,
        ownershipScope: {
          taskId,
          providerSandboxId: 'provider-successor-race',
          ownership: {
            ownerGeneration: 'owner-successor-race',
            resourceGeneration: 'resource-successor-race',
          },
        },
        processFingerprint: 'a'.repeat(64),
        ownershipIvFactory: () =>
          Uint8Array.from({ length: 12 }, () => ivByte),
      });
      completeOpaqueHandshake(harness, {
        mainSessionId: providerSessionId(slot),
        injectorSessionId: providerSessionId(slot + 1),
        mainTty: `/dev/pts/${slot}`,
        injectorTty: `/dev/pts/${slot + 1}`,
      });
      return harness;
    };
    const registrationPath = (harness) => {
      const path = harness.sockets.injector.sent.find(
        ({ data }) => data.includes('/tmp/.cap-aio-terminal-pairs-v2/'),
      )?.data.match(
        /\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner/u,
      )?.[0];
      assert.equal(typeof path, 'string');
      return path;
    };
    const flushMicrotasks = async () => {
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    };

    const first = createHarness(231, 1);
    const firstPath = registrationPath(first);
    let firstSettlement;
    void first.transport.cleanupDecision.then((settlement) => {
      firstSettlement = settlement;
    });
    first.transport.close();
    await flushMicrotasks();
    mock.timers.tick(25);
    await flushMicrotasks();
    assert.equal(pendingExecs.length, 1);
    assert.equal(firstSettlement, undefined);

    const second = createHarness(233, 2);
    const secondPath = registrationPath(second);
    let secondSettlement;
    void second.transport.cleanupDecision.then((settlement) => {
      secondSettlement = settlement;
    });
    second.transport.close();
    await flushMicrotasks();
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      1,
      'the successor batch must wait for its own coalescing window',
    );

    pendingExecs.shift()();
    await flushMicrotasks();
    assert.equal(firstSettlement?.kind, 'confirmed');
    assert.equal(secondSettlement, undefined);

    const third = createHarness(235, 3);
    const thirdPath = registrationPath(third);
    let thirdSettlement;
    void third.transport.cleanupDecision.then((settlement) => {
      thirdSettlement = settlement;
    });
    third.transport.close();
    await flushMicrotasks();
    mock.timers.tick(25);
    await flushMicrotasks();
    assert.equal(pendingExecs.length, 1);
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      2,
      'old batch finalization must preserve the accepting successor batch',
    );

    pendingExecs.shift()();
    await flushMicrotasks();
    assert.equal(secondSettlement?.kind, 'confirmed');
    assert.equal(thirdSettlement?.kind, 'confirmed');
    const rmCommands = calls
      .filter((call) => call.path === '/v1/shell/exec')
      .map((call) => call.body.command);
    assert.deepEqual(
      [...rmCommands[0].matchAll(
        /'(\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner)'/gu,
      )].map((match) => match[1]),
      [firstPath],
    );
    assert.deepEqual(
      [...rmCommands[1].matchAll(
        /'(\/tmp\/\.cap-aio-terminal-pairs-v2\/[0-9a-f]{64}\.owner)'/gu,
      )].map((match) => match[1]),
      [secondPath, thirdPath].sort(),
    );

    const afterBoth = createHarness(237, 4);
    afterBoth.transport.close();
    await flushMicrotasks();
    mock.timers.tick(25);
    await flushMicrotasks();
    assert.equal(pendingExecs.length, 1);
    assert.equal(
      calls.filter((call) => call.path === '/v1/shell/exec').length,
      3,
      'completed batches must be garbage-collected before later cleanup',
    );
    pendingExecs.shift()();
    await flushMicrotasks();
    assert.equal((await afterBoth.transport.cleanupDecision).kind, 'confirmed');
  } finally {
    mock.timers.reset();
  }
});

await test('owned transport rejects malformed scope and registration failures without leaking ownership material', async () => {
  let socketCreated = false;
  assert.throws(
    () =>
      new mod.AioTerminalTransport('expected-task', 'ws://unused', {
        ownershipScope: {
          taskId: 'wrong-task',
          providerSandboxId: 'PROVIDER_SCOPE_SECRET',
          ownership: {
            ownerGeneration: 'OWNER_SCOPE_SECRET',
            resourceGeneration: 'RESOURCE_SCOPE_SECRET',
          },
        },
        socketFactory: () => {
          socketCreated = true;
          return new FakeSocket();
        },
      }),
    (error) =>
      error.message === 'AIO terminal ownership scope was invalid' &&
      !/PROVIDER_SCOPE_SECRET|OWNER_SCOPE_SECRET|RESOURCE_SCOPE_SECRET/u.test(
        error.message,
      ),
  );
  assert.equal(socketCreated, false);

  const errors = [];
  const harness = createOpaqueHarness('registration-failure', {
    baseUrl: 'http://aio.test',
    fetch: async (input, init) => {
      assert.equal(init.method, 'DELETE');
      return cleanupResponse(sessionIdFromCleanupUrl(input));
    },
    cleanupRetryDelayMs: 0,
    ownershipScope: {
      taskId: 'registration-failure',
      providerSandboxId: 'PROVIDER_REGISTRATION_SECRET',
      ownership: {
        ownerGeneration: 'OWNER_REGISTRATION_SECRET',
        resourceGeneration: 'RESOURCE_REGISTRATION_SECRET',
      },
    },
    processFingerprint: 'invalid',
  });
  harness.transport.onError((error) => errors.push(error.message));
  openProviderEndpoint(harness.sockets.main, providerSessionId(101));
  openProviderEndpoint(
    harness.sockets.injector,
    providerSessionId(102),
  );
  emitFrame(harness.sockets.main, {
    type: 'output',
    data: guestIdentityLine(
      EXPECTED_MARKERS.main,
      '/dev/pts/41',
      '4101',
    ),
  });
  emitFrame(harness.sockets.injector, {
    type: 'output',
    data: guestIdentityLine(
      EXPECTED_MARKERS.injector,
      '/dev/pts/42',
      '4201',
    ),
  });
  assert.deepEqual(errors, ['AIO terminal ownership registration failed']);
  assert.doesNotMatch(
    errors.join(' '),
    /SESSION_REGISTRATION_SECRET|PROVIDER_REGISTRATION_SECRET|OWNER_REGISTRATION_SECRET|RESOURCE_REGISTRATION_SECRET/u,
  );
  assert.equal(harness.transport.readyState, 'closed');
  assert.deepEqual(await harness.transport.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
});

await test('owned close keeps exact session proof but stays indeterminate when journal rm is unconfirmed', async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: url.pathname, method: init.method, body });
    if (url.pathname === '/v1/shell/sessions/create') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            success: true,
            data: { session_id: body.id, working_dir: '/home/gem' },
          };
        },
      };
    }
    if (url.pathname === '/v1/shell/exec') {
      return {
        ok: false,
        status: 503,
        async json() {
          return { success: false, data: null };
        },
      };
    }
    if (init.method === 'DELETE') {
      return cleanupResponse(sessionIdFromCleanupUrl(input));
    }
    throw new Error('unexpected request');
  };
  const harness = createOpaqueHarness('journal-rm-unconfirmed', {
    baseUrl: 'http://aio.test',
    fetch: fetchImpl,
    cleanupRetryDelayMs: 0,
    ownershipScope: {
      taskId: 'journal-rm-unconfirmed',
      providerSandboxId: 'provider-rm',
      ownership: {
        ownerGeneration: 'owner-rm',
        resourceGeneration: 'resource-rm',
      },
    },
    processFingerprint: 'a'.repeat(64),
  });
  completeOpaqueHandshake(harness, {
    mainSessionId: providerSessionId(91),
    injectorSessionId: providerSessionId(92),
  });
  harness.transport.close();
  assert.deepEqual(await harness.transport.cleanupDecision, {
    kind: 'indeterminate',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 2,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unconfirmed',
  });
  assert.equal(calls.some((call) => call.path === '/v1/shell/exec'), true);
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

await test('normalizes the provider wait response behind the exit-status seam', async () => {
  const responses = [
    { ok: true, body: { exitCode: 7 }, expected: 7 },
    { ok: true, body: { exitCode: ' 8 ' }, expected: 8 },
    { ok: true, body: { code: '-3' }, expected: -3 },
    { ok: false, body: { exitCode: 9 }, expected: null },
    { ok: true, body: { exitCode: 1.5 }, expected: null },
    { ok: true, body: { exitCode: 'not-a-code' }, expected: null },
  ];
  const calls = [];
  for (const entry of responses) {
    const resolveExitStatus = mod.createAioTerminalExitStatusResolver({
      baseUrl: 'http://aio.test',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return {
          ok: entry.ok,
          async json() {
            return entry.body;
          },
        };
      },
    });
    assert.equal(await resolveExitStatus(), entry.expected);
  }
  assert.equal(calls.length, responses.length);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url === 'http://aio.test/v1/shell/wait' && init.method === 'POST',
    ),
  );

  const throwing = mod.createAioTerminalExitStatusResolver({
    baseUrl: 'http://aio.test',
    fetch: async () => {
      throw new Error('wait unavailable');
    },
  });
  assert.equal(await throwing(), null);

  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { exitCode: 0 };
      },
    });
    const defaultFetch = mod.createAioTerminalExitStatusResolver({
      baseUrl: 'http://aio.test',
    });
    assert.equal(await defaultFetch(), 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
