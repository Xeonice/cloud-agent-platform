import assert from 'node:assert/strict';

const mod = await import(new URL('../dist/index.js', import.meta.url).href);

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

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeTransport {
  readyState = 'open';
  opaqueInputCapability = 'byte-preserving';
  frames = new Set();
  closes = new Set();
  errors = new Set();
  operations = [];
  bytes = [];
  terminalResponses = [];
  paused = false;
  closed = false;

  onFrame(listener) {
    this.frames.add(listener);
    return { dispose: () => this.frames.delete(listener) };
  }

  onClose(listener) {
    this.closes.add(listener);
    return { dispose: () => this.closes.delete(listener) };
  }

  onError(listener) {
    this.errors.add(listener);
    return { dispose: () => this.errors.delete(listener) };
  }

  sendInput(data) {
    if (this.closed) return false;
    this.operations.push(['input', data]);
    return true;
  }

  sendInputBytes(data) {
    if (this.closed) return 'closed';
    this.bytes.push(Uint8Array.from(data));
    return 'written';
  }

  sendTerminalResponseBytes(data) {
    if (this.closed) return 'closed';
    this.terminalResponses.push(Uint8Array.from(data));
    return 'written';
  }

  sendResize(cols, rows) {
    if (this.closed) return false;
    this.operations.push(['resize', cols, rows]);
    return true;
  }

  sendPong(timestamp) {
    this.operations.push(['pong', timestamp]);
    return !this.closed;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closes]) listener();
  }

  emit(frame) {
    for (const listener of [...this.frames]) listener(frame);
  }

  emitError(error) {
    for (const listener of [...this.errors]) listener(error);
  }
}

class FakeTransportFactory {
  transports = [];

  constructor(seed = {}) {
    this.seed = seed;
  }

  open() {
    const transport = new FakeTransport();
    Object.assign(transport, this.seed);
    this.transports.push(transport);
    return transport;
  }
}

function result(exitCode, timedOut = false) {
  return { exitCode, output: '', stdout: '', stderr: '', timedOut };
}

function viewerFactory({ executor, policy, transportSeed } = {}) {
  const transports = new FakeTransportFactory(transportSeed);
  const factory = new mod.SandboxTerminalViewerAttachmentFactory({
    taskId: 'viewer-1',
    transportFactory: transports,
    commandExecutor: executor ?? { exec: async () => result(0) },
    policy: {
      firstOutputTimeoutMs: 60,
      quietMs: 5,
      maxSettleMs: 30,
      probeTimeoutMs: 50,
      ...policy,
    },
  });
  return { factory, transports };
}

await test('opens a distinct transport, ignores pre-attach output, and attaches exactly after resize', async () => {
  let resolveProbe;
  const probe = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const calls = [];
  const { factory, transports } = viewerFactory({
    executor: {
      async exec(request) {
        calls.push(request);
        return probe;
      },
    },
  });
  const attachment = factory.open({ cols: 120, rows: 40 });
  const transport = transports.transports[0];
  const output = [];
  attachment.onData((chunk) => output.push(Buffer.from(chunk)));

  transport.emit({ type: 'ready' });
  transport.emit({ type: 'output', data: 'HISTORY_MUST_NOT_BE_INJECTED' });
  resolveProbe(result(0));
  await delay();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'tmux -u has-session -t =taskviewer-1');
  assert.deepEqual(transport.operations[0], ['resize', 120, 40]);
  assert.equal(transport.operations[1][0], 'input');
  assert.equal(
    transport.operations[1][1],
    'tmux -u set-window-option -t =taskviewer-1: window-size manual \\; set-option -t =taskviewer-1: status off \\; attach-session -f ignore-size -t =taskviewer-1\r',
  );
  assert.doesNotMatch(transport.operations[1][1], /new-session|(?:^|\s)-L(?:\s|$)/u);
  assert.equal(output.length, 0);

  const redraw = Buffer.from('\u001b[?1049h\u001b[2J\u001b[H原生界面');
  transport.emit({ type: 'output', data: redraw.toString('utf8') });
  assert.deepEqual(await attachment.attachmentDecision, { kind: 'ready' });
  transport.emit({ type: 'output', data: 'LIVE_DELTA' });
  assert.equal(Buffer.concat(output).toString('utf8'), `${redraw.toString('utf8')}LIVE_DELTA`);
});

await test('preserves all input bytes and isolates peer pause and close state', async () => {
  const { factory, transports } = viewerFactory();
  const first = factory.open({ cols: 80, rows: 24 });
  const second = factory.open({ cols: 90, rows: 30 });
  assert.equal(transports.transports.length, 2);

  for (const transport of transports.transports) {
    transport.emit({ type: 'ready' });
  }
  await delay();
  transports.transports[0].emit({ type: 'output', data: 'one' });
  transports.transports[1].emit({ type: 'output', data: 'two' });
  await Promise.all([first.attachmentDecision, second.attachmentDecision]);

  const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
  assert.equal(first.write(everyByte), 'written');
  assert.deepEqual(transports.transports[0].bytes[0], everyByte);
  const response = Uint8Array.of(0x1b, 0x5b, 0x3f, 0x31, 0x3b, 0x32, 0x63);
  assert.equal(first.writeTerminalResponse(response), 'written');
  assert.deepEqual(transports.transports[0].terminalResponses[0], response);
  assert.equal(transports.transports[1].bytes.length, 0);
  assert.equal(transports.transports[1].terminalResponses.length, 0);

  first.pause();
  assert.equal(transports.transports[0].paused, true);
  assert.equal(transports.transports[1].paused, false);
  first.close();
  assert.equal(transports.transports[0].closed, true);
  assert.equal(transports.transports[1].closed, false);
  assert.equal(second.write(Uint8Array.of(0x1b, 0x5b, 0x4d, 0xff)), 'written');
  second.close();
});

await test('settles ready by hard deadline when redraw output never becomes quiet', async () => {
  const { factory, transports } = viewerFactory({
    policy: { quietMs: 100, maxSettleMs: 20, firstOutputTimeoutMs: 80 },
  });
  const attachment = factory.open({ cols: 80, rows: 24 });
  const transport = transports.transports[0];
  transport.emit({ type: 'ready' });
  await delay();
  const interval = setInterval(() => transport.emit({ type: 'output', data: '.' }), 3);
  assert.deepEqual(await attachment.attachmentDecision, { kind: 'ready' });
  clearInterval(interval);
  attachment.close();
});

await test('empty output frames never satisfy or extend redraw readiness', async () => {
  const { factory, transports } = viewerFactory({
    policy: { firstOutputTimeoutMs: 20, quietMs: 5, maxSettleMs: 15 },
  });
  const attachment = factory.open({ cols: 80, rows: 24 });
  const transport = transports.transports[0];
  transport.emit({ type: 'ready' });
  await delay();
  const interval = setInterval(() => {
    transport.emit({ type: 'output', data: '' });
    transport.emit({ type: 'output', bytes: new Uint8Array() });
  }, 2);
  assert.deepEqual(await attachment.attachmentDecision, {
    kind: 'failed',
    reason: 'blank-redraw',
  });
  clearInterval(interval);
});

await test('returns absent or indeterminate and never launches on unsuccessful probes', async () => {
  for (const [probeResult, expected] of [
    [result(1), { kind: 'absent' }],
    [result(2), { kind: 'indeterminate' }],
    [result(0, true), { kind: 'indeterminate' }],
  ]) {
    const { factory, transports } = viewerFactory({
      executor: { exec: async () => probeResult },
    });
    const attachment = factory.open({ cols: 80, rows: 24 });
    transports.transports[0].emit({ type: 'ready' });
    assert.deepEqual(await attachment.attachmentDecision, expected);
    assert.equal(transports.transports[0].operations.length, 0);
    assert.equal(transports.transports[0].closed, true);
  }

  const rejected = viewerFactory({
    executor: { exec: async () => { throw new Error('probe transport failed'); } },
  });
  const attachment = rejected.factory.open({ cols: 80, rows: 24 });
  assert.deepEqual(await attachment.attachmentDecision, { kind: 'indeterminate' });
  assert.equal(rejected.transports.transports[0].operations.length, 0);
});

await test('fails explicit blank redraw and fences late probe/provider callbacks after abort', async () => {
  const blank = viewerFactory({ policy: { firstOutputTimeoutMs: 10 } });
  const blankAttachment = blank.factory.open({ cols: 80, rows: 24 });
  blank.transports.transports[0].emit({ type: 'ready' });
  assert.deepEqual(await blankAttachment.attachmentDecision, {
    kind: 'failed',
    reason: 'blank-redraw',
  });

  let resolveProbe;
  const deferred = new Promise((resolve) => {
    resolveProbe = resolve;
  });
  const controller = new AbortController();
  const stale = viewerFactory({ executor: { exec: async () => deferred } });
  const staleAttachment = stale.factory.open({
    cols: 80,
    rows: 24,
    signal: controller.signal,
  });
  const transport = stale.transports.transports[0];
  controller.abort();
  assert.deepEqual(await staleAttachment.attachmentDecision, {
    kind: 'failed',
    reason: 'aborted',
  });
  resolveProbe(result(0));
  transport.emit({ type: 'ready' });
  transport.emit({ type: 'output', data: 'late' });
  await delay();
  assert.equal(transport.operations.length, 0);
});

await test('surfaces transport failure and unsupported opaque input distinctly', async () => {
  const { factory, transports } = viewerFactory();
  const attachment = factory.open({ cols: 80, rows: 24 });
  const transport = transports.transports[0];
  const errors = [];
  attachment.onError((error) => errors.push(error.message));
  transport.emitError(new Error('provider failed'));
  assert.deepEqual(await attachment.attachmentDecision, {
    kind: 'failed',
    reason: 'transport',
  });
  assert.deepEqual(errors, ['provider failed']);

  const unsupported = viewerFactory();
  const unsupportedAttachment = unsupported.factory.open({ cols: 80, rows: 24 });
  const unsupportedTransport = unsupported.transports.transports[0];
  unsupportedTransport.opaqueInputCapability = 'unsupported';
  unsupportedTransport.sendInputBytes = () => 'unsupported';
  unsupportedTransport.sendTerminalResponseBytes = () => 'unsupported';
  unsupportedTransport.emit({ type: 'ready' });
  await delay();
  unsupportedTransport.emit({ type: 'output', data: 'ready' });
  await unsupportedAttachment.attachmentDecision;
  assert.equal(unsupportedAttachment.opaqueInputCapability, 'unsupported');
  assert.equal(unsupportedAttachment.write(Uint8Array.of(0xff)), 'unsupported');
  assert.equal(
    unsupportedAttachment.writeTerminalResponse(Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e)),
    'unsupported',
  );
  unsupportedAttachment.close();
});

await test('forwards provider cleanup evidence and keeps a missing seam indeterminate', async () => {
  const confirmed = {
    kind: 'confirmed',
    expectedIdentities: 2,
    observedIdentities: 2,
    confirmedIdentities: 2,
    deletedIdentities: 1,
    alreadyAbsentIdentities: 1,
    cause: null,
  };
  const supported = viewerFactory({
    transportSeed: { cleanupDecision: Promise.resolve(confirmed) },
  });
  const supportedAttachment = supported.factory.open({ cols: 80, rows: 24 });
  supportedAttachment.close();
  assert.deepEqual(await supportedAttachment.cleanupDecision, confirmed);

  const unsupported = viewerFactory();
  const unsupportedAttachment = unsupported.factory.open({ cols: 80, rows: 24 });
  unsupportedAttachment.close();
  assert.deepEqual(await unsupportedAttachment.cleanupDecision, {
    kind: 'indeterminate',
    expectedIdentities: 1,
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: 'cleanup-unsupported',
  });

  const invalid = viewerFactory().factory.open({ cols: 0, rows: 24 });
  assert.deepEqual(await invalid.cleanupDecision, {
    kind: 'confirmed',
    expectedIdentities: 0,
    observedIdentities: 0,
    confirmedIdentities: 0,
    deletedIdentities: 0,
    alreadyAbsentIdentities: 0,
    cause: null,
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
