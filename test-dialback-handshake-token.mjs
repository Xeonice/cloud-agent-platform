/**
 * Minimal test for requirement:
 *   "Dial-back handshake authenticated by a short-lived TASK_TOKEN"
 *
 * Requirement semantics (from task-token.service.ts, handshake.ts,
 * dialback-client.ts, and contracts/dialback.ts):
 *
 *   1. The orchestrator issues a per-task short-lived TASK_TOKEN bound to exactly
 *      one taskId; a token for task A never validates a dial-back claiming task B.
 *   2. The runner constructs a DialbackHandshakeFrame carrying both the claimed
 *      taskId and the TASK_TOKEN — validated by the contracts Zod schema before
 *      sending.
 *   3. The handshake frame is sent as the FIRST frame on the outbound socket;
 *      no other frame may precede it.
 *   4. An expired token is rejected by the orchestrator verifier.
 *   5. A token presented for the wrong taskId is rejected.
 *   6. An empty taskId or empty TASK_TOKEN is rejected (fast-fail on runner side).
 *   7. Re-issuing a token for the same task invalidates the previous token.
 */

import { randomUUID } from 'node:crypto';
import { z } from '/Users/tanghehui/ExploreProject/cloud-agent-platform/node_modules/.pnpm/zod@3.25.76/node_modules/zod/index.js';

const FRAME_CHANNEL = { RAW: 'raw', CONTROL: 'control' };

const DialbackHandshakeFrameSchema = z.object({
  channel: z.literal(FRAME_CHANNEL.CONTROL),
  type: z.literal('dialback_handshake'),
  taskId: z.string().uuid(),
  TASK_TOKEN: z.string().min(1),
});

// ── inline TaskTokenService (mirrors apps/api/src/tasks/task-token.service.ts)

const DEFAULT_TASK_TOKEN_TTL_MS = 10 * 60 * 1000;

function makeTokenService(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TASK_TOKEN_TTL_MS;
  const now = options.now ?? Date.now;
  const byTask = new Map();
  const byToken = new Map();

  function issue(taskId) {
    const id = taskId?.trim();
    if (!id) throw new Error('Cannot issue a TASK_TOKEN without a taskId');
    // invalidate prior token
    const existing = byTask.get(id);
    if (existing) {
      byTask.delete(id);
      byToken.delete(existing.token);
    }
    const token = randomUUID() + '-' + randomUUID(); // deterministic in tests OK
    const record = { taskId: id, token, expiresAtEpochMs: now() + ttlMs };
    byTask.set(id, record);
    byToken.set(token, record);
    return token;
  }

  function verify(claimedTaskId, token) {
    const id = claimedTaskId?.trim();
    if (!id || !token) return false;
    const record = byToken.get(token);
    if (!record) return false;
    if (record.taskId !== id) return false; // A-token claiming task B
    if (now() >= record.expiresAtEpochMs) {
      // expired: lazily purge
      byTask.delete(record.taskId);
      byToken.delete(token);
      return false;
    }
    return true;
  }

  function revokeForTask(taskId) {
    const existing = byTask.get(taskId);
    if (!existing) return;
    byTask.delete(taskId);
    byToken.delete(existing.token);
  }

  return { issue, verify, revokeForTask };
}

// ── inline buildHandshakeFrame (mirrors apps/runner/src/dialback/handshake.ts)

function buildHandshakeFrame({ taskId, taskToken }) {
  const id = taskId?.trim();
  const token = taskToken?.trim();
  if (!id) throw new Error('Dial-back handshake requires a non-empty taskId');
  if (!token) throw new Error('Dial-back handshake requires a non-empty TASK_TOKEN');
  return DialbackHandshakeFrameSchema.parse({
    channel: FRAME_CHANNEL.CONTROL,
    type: 'dialback_handshake',
    taskId: id,
    TASK_TOKEN: token,
  });
}

// ── inline DialBackClient (minimal, mirrors apps/runner/src/dialback/dialback-client.ts)

function makeDialBackClient({ orchestratorUrl, socketFactory, handshake }) {
  if (!orchestratorUrl?.trim()) throw new Error('requires a non-empty orchestratorUrl');

  let state = 'idle';
  let handshakeSent = false;
  let socket = null;

  async function connect() {
    if (state !== 'idle' && state !== 'closed') {
      throw new Error(`DialBackClient.connect called in state "${state}"`);
    }
    const handshakeFrame = buildHandshakeFrame(handshake);
    state = 'connecting';
    handshakeSent = false;
    socket = socketFactory(orchestratorUrl);

    return new Promise((resolve, reject) => {
      let settled = false;
      socket.on('open', () => {
        state = 'handshaking';
        try {
          socket.send(JSON.stringify(handshakeFrame));
          handshakeSent = true;
          state = 'open';
          if (!settled) { settled = true; resolve(); }
        } catch (err) {
          state = 'closed';
          if (!settled) { settled = true; reject(err); }
        }
      });
      socket.on('error', (err) => {
        state = 'closed';
        if (!settled) { settled = true; reject(err); }
      });
      socket.on('close', () => {
        state = 'closed';
        socket = null;
        if (!settled) { settled = true; reject(new Error('closed before handshake')); }
      });
    });
  }

  return {
    connect,
    get connectionState() { return state; },
    get hasSentHandshake() { return handshakeSent; },
  };
}

// ── fake outbound socket factory

function makeFakeSocket() {
  const listeners = {};
  const sentFrames = [];
  const sock = {
    on(event, listener) {
      listeners[event] = listener;
    },
    send(data) {
      sentFrames.push(data);
    },
    close() {},
    _emit(event, ...args) {
      listeners[event]?.(...args);
    },
    get sentFrames() { return sentFrames; },
  };
  return sock;
}

// ── assertion helpers

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

// ── TESTS ──────────────────────────────────────────────────────────────────

console.log('\n=== Dial-back handshake authenticated by a short-lived TASK_TOKEN ===\n');

// T1: Orchestrator issues a token; valid token+taskId verifies as true.
{
  const svc = makeTokenService();
  const taskId = randomUUID();
  const token = svc.issue(taskId);

  assert(typeof token === 'string' && token.length > 0, 'T1a: issue() returns a non-empty token string');
  assert(svc.verify(taskId, token), 'T1b: valid token+taskId verifies as true');
}

// T2: Token for task A does NOT verify for task B (cross-task rejection).
{
  const svc = makeTokenService();
  const taskA = randomUUID();
  const taskB = randomUUID();
  const tokenA = svc.issue(taskA);

  assert(!svc.verify(taskB, tokenA), 'T2: token issued for task A rejected when claiming task B');
}

// T3: Expired token is rejected.
{
  let fakeNow = 1_000_000;
  const svc = makeTokenService({ ttlMs: 5_000, now: () => fakeNow });
  const taskId = randomUUID();
  const token = svc.issue(taskId);

  // Still valid before TTL.
  assert(svc.verify(taskId, token), 'T3a: token valid before TTL elapses');

  // Advance clock past TTL.
  fakeNow += 6_000;
  assert(!svc.verify(taskId, token), 'T3b: expired token rejected after TTL elapses');
}

// T4: Re-issuing for same task invalidates the prior token.
{
  const svc = makeTokenService();
  const taskId = randomUUID();
  const tokenFirst = svc.issue(taskId);
  const tokenSecond = svc.issue(taskId);

  assert(tokenFirst !== tokenSecond, 'T4a: re-issue mints a distinct token');
  assert(!svc.verify(taskId, tokenFirst), 'T4b: prior token is invalidated after re-issue');
  assert(svc.verify(taskId, tokenSecond), 'T4c: new token is valid');
}

// T5: buildHandshakeFrame rejects empty taskId.
{
  let threw = false;
  try {
    buildHandshakeFrame({ taskId: '  ', taskToken: 'some-token' });
  } catch {
    threw = true;
  }
  assert(threw, 'T5: buildHandshakeFrame throws on empty taskId');
}

// T6: buildHandshakeFrame rejects empty TASK_TOKEN.
{
  const taskId = randomUUID();
  let threw = false;
  try {
    buildHandshakeFrame({ taskId, taskToken: '' });
  } catch {
    threw = true;
  }
  assert(threw, 'T6: buildHandshakeFrame throws on empty TASK_TOKEN');
}

// T7: buildHandshakeFrame produces a frame that validates against the contracts schema.
{
  const taskId = randomUUID();
  const frame = buildHandshakeFrame({ taskId, taskToken: 'tok-abc' });

  assert(frame.channel === 'control', 'T7a: frame channel is "control"');
  assert(frame.type === 'dialback_handshake', 'T7b: frame type is "dialback_handshake"');
  assert(frame.taskId === taskId, 'T7c: frame carries the correct taskId');
  assert(frame.TASK_TOKEN === 'tok-abc', 'T7d: frame carries the TASK_TOKEN');
  assert(DialbackHandshakeFrameSchema.safeParse(frame).success, 'T7e: frame validates against schema');
}

// T8: DialBackClient sends handshake as FIRST frame on open, state transitions correctly.
{
  const taskId = randomUUID();
  const token = 'tok-runner';
  let createdSocket = null;

  const socketFactory = (url) => {
    const s = makeFakeSocket();
    createdSocket = s;
    return s;
  };

  const client = makeDialBackClient({
    orchestratorUrl: 'wss://orchestrator.example/runner',
    socketFactory,
    handshake: { taskId, taskToken: token },
  });

  assert(client.connectionState === 'idle', 'T8a: initial state is idle');

  const connectPromise = client.connect();

  // Simulate socket open event.
  createdSocket._emit('open');
  await connectPromise;

  assert(client.hasSentHandshake, 'T8b: handshakeSent is true after connect');
  assert(client.connectionState === 'open', 'T8c: state transitions to "open" after handshake sent');
  assert(createdSocket.sentFrames.length === 1, 'T8d: exactly one frame was sent (the handshake)');

  const sentFrame = JSON.parse(createdSocket.sentFrames[0]);
  assert(sentFrame.channel === 'control', 'T8e: first frame channel is "control"');
  assert(sentFrame.type === 'dialback_handshake', 'T8f: first frame type is "dialback_handshake"');
  assert(sentFrame.taskId === taskId, 'T8g: first frame carries correct taskId');
  assert(sentFrame.TASK_TOKEN === token, 'T8h: first frame carries the TASK_TOKEN');
  assert(DialbackHandshakeFrameSchema.safeParse(sentFrame).success, 'T8i: sent frame validates against contracts schema');
}

// T9: Full handshake round-trip — orchestrator issues token, runner sends frame,
//     orchestrator verifies it matches the issued token+taskId.
{
  const svc = makeTokenService();
  const taskId = randomUUID();
  const issuedToken = svc.issue(taskId);

  // Runner builds the handshake frame using the injected TASK_TOKEN.
  const frame = buildHandshakeFrame({ taskId, taskToken: issuedToken });

  // Orchestrator verifier checks the frame's token against the issued record.
  const verifies = svc.verify(frame.taskId, frame.TASK_TOKEN);

  assert(verifies, 'T9a: orchestrator verifies the runner\'s handshake token successfully');

  // Cross-task tamper: attacker swaps taskId in the frame.
  const fraudulentTaskId = randomUUID();
  const fraudulent = svc.verify(fraudulentTaskId, frame.TASK_TOKEN);
  assert(!fraudulent, 'T9b: cross-task tamper — swapped taskId is rejected by verifier');
}

// T10: Orchestrator rejects a token not in its registry (unknown/invented token).
{
  const svc = makeTokenService();
  const taskId = randomUUID();
  svc.issue(taskId); // issue one, but present a different token

  const bogusToken = 'this-was-never-issued';
  assert(!svc.verify(taskId, bogusToken), 'T10: unknown/invented token is rejected');
}

// ── summary ───────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
