/**
 * Minimal test: "Runner dials back to the orchestrator" requirement.
 *
 * Requirement (design D8 / runner dialback-client spec):
 *   1. The runner opens an OUTBOUND (client) WebSocket to the orchestrator URL —
 *      it never binds or listens on an inbound port.
 *   2. The FIRST frame sent on that socket MUST be the dial-back handshake frame
 *      containing the per-task TASK_TOKEN and taskId.
 *   3. The handshake frame validates against DialbackHandshakeFrameSchema (channel
 *      + type discriminators + UUID taskId + non-empty TASK_TOKEN).
 *   4. The client MUST NOT send any other frame before the handshake.
 *   5. Any frame sent after connect() resolves MUST still be blocked until the
 *      handshake has been written (guard: hasSentHandshake).
 *   6. An empty/missing orchestratorUrl throws immediately (fail-fast).
 *   7. An empty taskId or TASK_TOKEN throws before the socket is even opened.
 */

import { DialBackClient, buildHandshakeFrame } from './apps/runner/dist/dialback/index.js';
import { DialbackHandshakeFrameSchema, FRAME_CHANNEL } from './packages/contracts/dist/index.js';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Fake outbound socket (no inbound server, no real network)
// ---------------------------------------------------------------------------
function makeFakeSocket(opts = {}) {
  const frames = [];
  const listeners = {};
  let opened = false;

  const socket = {
    _frames: frames,
    _listeners: listeners,
    on(event, cb) {
      listeners[event] = cb;
    },
    send(data) {
      frames.push(data);
    },
    close() {},
    // simulate open event
    triggerOpen() {
      if (!opened) {
        opened = true;
        listeners['open']?.();
      }
    },
    triggerError(err) {
      listeners['error']?.(err);
    },
  };

  return socket;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

console.log('\n=== Runner dials back to the orchestrator ===\n');

// T1: handshake is the first (and only) frame sent on connect
{
  const taskId = randomUUID();
  const taskToken = 'tok_test_abc123';
  let socket;

  const factory = (url) => {
    socket = makeFakeSocket();
    // Simulate the open event asynchronously (after factory returns)
    Promise.resolve().then(() => socket.triggerOpen());
    return socket;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId, taskToken },
  });

  await client.connect();

  assert(
    socket._frames.length === 1,
    'T1a: exactly one frame is sent on connect (the handshake)',
  );

  const raw = socket._frames[0];
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    frame = null;
  }

  assert(frame !== null, 'T1b: the sent frame is valid JSON');

  const parsed = DialbackHandshakeFrameSchema.safeParse(frame);
  assert(parsed.success, 'T1c: the first frame validates against DialbackHandshakeFrameSchema');
  assert(frame?.channel === FRAME_CHANNEL.CONTROL, 'T1d: channel is "control"');
  assert(frame?.type === 'dialback_handshake', 'T1e: type is "dialback_handshake"');
  assert(frame?.taskId === taskId, 'T1f: taskId matches the provisioned task');
  assert(frame?.TASK_TOKEN === taskToken, 'T1g: TASK_TOKEN matches the provisioned token');
}

// T2: hasSentHandshake is true only after connect() resolves
{
  const taskId = randomUUID();
  let socket;

  const factory = (url) => {
    socket = makeFakeSocket();
    // Open fires asynchronously
    Promise.resolve().then(() => socket.triggerOpen());
    return socket;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId, taskToken: 'tok_sentinel' },
  });

  assert(!client.hasSentHandshake, 'T2a: hasSentHandshake is false before connect()');

  await client.connect();

  assert(client.hasSentHandshake, 'T2b: hasSentHandshake is true after connect() resolves');
}

// T3: send() before handshake throws — no frame can precede the handshake
{
  let socket;
  const factory = (url) => {
    socket = makeFakeSocket();
    // Do NOT trigger open — client is still in connecting state
    return socket;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId: randomUUID(), taskToken: 'tok_sentinel' },
  });

  // Don't await connect — handshake not yet sent
  client.connect().catch(() => {/* ignore — socket never opens in this test */});

  let threw = false;
  try {
    client.send('{"some":"frame"}');
  } catch {
    threw = true;
  }

  assert(threw, 'T3a: send() before handshake throws, blocking any non-handshake frame');
}

// T4: socket factory is called with the correct orchestrator URL (outbound dial)
{
  const expectedUrl = 'wss://api.cloud-agent.example/runner';
  let dialledUrl = null;
  let socket;

  const factory = (url) => {
    dialledUrl = url;
    socket = makeFakeSocket();
    Promise.resolve().then(() => socket.triggerOpen());
    return socket;
  };

  const client = new DialBackClient({
    orchestratorUrl: expectedUrl,
    socketFactory: factory,
    handshake: { taskId: randomUUID(), taskToken: 'tok_url_check' },
  });

  await client.connect();

  assert(dialledUrl === expectedUrl, 'T4a: socket factory is called with the orchestrator URL (outbound)');
}

// T5: empty orchestratorUrl throws immediately (fail-fast before any socket is created)
{
  let threw = false;
  try {
    new DialBackClient({
      orchestratorUrl: '   ',
      socketFactory: () => { throw new Error('should not be called'); },
      handshake: { taskId: randomUUID(), taskToken: 'tok_empty_url' },
    });
  } catch {
    threw = true;
  }
  assert(threw, 'T5a: empty/whitespace orchestratorUrl throws in constructor (fail-fast)');
}

// T6: empty taskId throws before socket is opened
{
  let socketCreated = false;
  const factory = (url) => {
    socketCreated = true;
    const s = makeFakeSocket();
    Promise.resolve().then(() => s.triggerOpen());
    return s;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId: '', taskToken: 'tok_some_token' },
  });

  let threw = false;
  try {
    await client.connect();
  } catch {
    threw = true;
  }

  // The spec says "a bad token fails fast and we never open a connection we
  // cannot authenticate" — the DialBackClient builds the handshake frame BEFORE
  // opening the socket, so the factory should NOT have been called.
  assert(threw, 'T6a: empty taskId throws when connect() is called');
  assert(!socketCreated, 'T6b: no socket is opened when taskId is empty (fail-fast before dial)');
}

// T7: empty TASK_TOKEN throws before socket is opened
{
  let socketCreated = false;
  const factory = (url) => {
    socketCreated = true;
    const s = makeFakeSocket();
    Promise.resolve().then(() => s.triggerOpen());
    return s;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId: randomUUID(), taskToken: '' },
  });

  let threw = false;
  try {
    await client.connect();
  } catch {
    threw = true;
  }

  assert(threw, 'T7a: empty TASK_TOKEN throws when connect() is called');
  assert(!socketCreated, 'T7b: no socket is opened when TASK_TOKEN is empty (fail-fast before dial)');
}

// T8: connection state transitions correctly
{
  let socket;
  const factory = (url) => {
    socket = makeFakeSocket();
    Promise.resolve().then(() => socket.triggerOpen());
    return socket;
  };

  const client = new DialBackClient({
    orchestratorUrl: 'ws://orchestrator.example.com/runner',
    socketFactory: factory,
    handshake: { taskId: randomUUID(), taskToken: 'tok_state_check' },
  });

  assert(client.connectionState === 'idle', 'T8a: initial state is "idle"');

  const connecting = client.connect();
  // State immediately transitions to "connecting" after calling connect()
  assert(client.connectionState === 'connecting', 'T8b: state is "connecting" after connect() called');

  await connecting;
  assert(client.connectionState === 'open', 'T8c: state is "open" after handshake sent');

  client.close();
  assert(client.connectionState === 'closed', 'T8d: state is "closed" after close()');
}

// T9: handshake frame's taskId is a valid UUID (schema enforces this)
{
  // Non-UUID taskId should fail the contracts schema even if non-empty
  let threw = false;
  try {
    buildHandshakeFrame({ taskId: 'not-a-uuid', taskToken: 'tok_uuid_check' });
  } catch {
    threw = true;
  }
  assert(threw, 'T9a: buildHandshakeFrame rejects a non-UUID taskId per DialbackHandshakeFrameSchema');

  // Valid UUID + token should succeed
  let frame;
  try {
    frame = buildHandshakeFrame({ taskId: randomUUID(), taskToken: 'tok_uuid_ok' });
  } catch {
    frame = null;
  }
  assert(frame !== null, 'T9b: buildHandshakeFrame accepts a valid UUID taskId');
  assert(
    DialbackHandshakeFrameSchema.safeParse(frame).success,
    'T9c: built frame validates against the contracts schema',
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSome tests FAILED.');
  process.exit(1);
} else {
  console.log('\nAll tests PASSED.');
}
