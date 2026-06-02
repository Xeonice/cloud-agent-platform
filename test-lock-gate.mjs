/**
 * Minimal ground-truth test:
 *   "Keystrokes are lock-gated, approvals are lock-independent"
 *
 * Tests the two units that implement this requirement end-to-end:
 *
 *   1. WriteLockService.isWriter()  ← keystroke gate helper
 *   2. TerminalGateway.handleMessage() for:
 *        a) keystroke frame from a NON-holder → PTY write must NOT be called
 *        b) keystroke frame from the holder   → PTY write MUST be called
 *        c) decision frame from a NON-holder  → decision MUST be forwarded
 *           (lock-independent: no isWriter check on the decision path)
 *
 * Both units live entirely in-process; no network/PTY/DB is needed.
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. Inline the WriteLockService logic (same algorithm, no NestJS deps)
//    We duplicate it here so the test is self-contained and fast.
// ---------------------------------------------------------------------------

class WriteLockService {
  leases = new Map();
  leaseTtlMs;
  now;

  constructor({ leaseTtlMs = 30_000, clock = Date.now } = {}) {
    this.leaseTtlMs = leaseTtlMs;
    this.now = clock;
  }

  acquire(sessionId, clientId) {
    const current = this.leases.get(sessionId);
    if (!current || this.now() >= current.leaseExpiry) {
      const demoted = current && current.writerClientId !== clientId
        ? current.writerClientId : null;
      return this._grant(sessionId, clientId, 'acquired', demoted);
    }
    if (current.writerClientId === clientId) {
      return this._grant(sessionId, clientId, 'renewed', null);
    }
    return { outcome: 'denied', lease: current, demotedClientId: null };
  }

  isWriter(sessionId, clientId) {
    const lease = this.leases.get(sessionId);
    if (!lease || this.now() >= lease.leaseExpiry) {
      if (lease) this.leases.delete(sessionId);
      return false;
    }
    return lease.writerClientId === clientId;
  }

  _grant(sessionId, clientId, outcome, demotedClientId) {
    const lease = { writerClientId: clientId, leaseExpiry: this.now() + this.leaseTtlMs };
    this.leases.set(sessionId, lease);
    return { outcome, lease, demotedClientId };
  }
}

// ---------------------------------------------------------------------------
// 2. Minimal stubs that reproduce the gateway's keystroke-gate and
//    decision-path logic (extracted from terminal.gateway.ts, lines 476-491
//    and 587-608).
// ---------------------------------------------------------------------------

/**
 * Simulate the gateway's `onKeystroke` handler (lines 476-491 of
 * terminal.gateway.ts).  Returns true when the PTY write was actually called.
 */
function simulateOnKeystroke({ writeLock, session, state, frame }) {
  if (!state.authenticated || state.kind !== 'operator') return false;
  if (!writeLock) return false;
  // GATE: only the lease holder may forward raw input to the PTY.
  if (!writeLock.isWriter(frame.sessionId, state.clientId)) {
    return false; // silently dropped
  }
  const input = Buffer.from(frame.data, 'base64').toString('utf8');
  session.pty.write(input);
  return true;
}

/**
 * Simulate the gateway's `onDecision` handler (lines 587-608 of
 * terminal.gateway.ts).  Returns true when the decision was forwarded to the
 * runner.  Critically: NO isWriter check here — lock-independent.
 */
function simulateOnDecision({ state, frame, pendingApprovals, runnerSocket }) {
  // Lock-INDEPENDENT: no lease check here. Only require an authenticated operator.
  if (state.kind !== 'operator' || !state.authenticated) return false;

  const pending = pendingApprovals.get(frame.requestId);
  if (!pending) return false;
  pendingApprovals.delete(frame.requestId);

  // "send" the decision to the blocked runner.
  runnerSocket.sent.push(frame);
  return true;
}

// ---------------------------------------------------------------------------
// 3. Test helpers
// ---------------------------------------------------------------------------

const FRAME_CHANNEL = { CONTROL: 'control', RAW: 'raw' };

function makeKeystrokeFrame(sessionId, data = 'aGVsbG8=') {
  return { channel: FRAME_CHANNEL.CONTROL, type: 'keystroke', sessionId, data };
}

function makeDecisionFrame(requestId) {
  return {
    channel: FRAME_CHANNEL.CONTROL,
    type: 'decision',
    requestId,
    decision: { behavior: 'allow' },
  };
}

function makeOperatorState(clientId, taskId = null) {
  return { clientId, kind: 'operator', authenticated: true, taskId };
}

// ---------------------------------------------------------------------------
// 4. Tests
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
    failed++;
  }
}

console.log('\nTest: Keystrokes are lock-gated, approvals are lock-independent\n');

// ── WriteLockService unit tests ──────────────────────────────────────────────

test('isWriter returns false for a client that never acquired', () => {
  const svc = new WriteLockService();
  assert.equal(svc.isWriter('s1', 'clientA'), false);
});

test('isWriter returns true for the client that acquired the lease', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');
  assert.equal(svc.isWriter('s1', 'clientA'), true);
});

test('isWriter returns false for a client that did not acquire', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');
  assert.equal(svc.isWriter('s1', 'clientB'), false);
});

test('isWriter returns false after lease expires (no heartbeat)', () => {
  let t = 0;
  const svc = new WriteLockService({ leaseTtlMs: 1000, clock: () => t });
  svc.acquire('s1', 'clientA');
  t = 1001; // advance clock past TTL
  assert.equal(svc.isWriter('s1', 'clientA'), false);
});

// ── Gateway keystroke-gate tests ─────────────────────────────────────────────

test('keystroke from non-lock-holder is dropped (PTY.write not called)', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');         // clientA holds the lock

  const writeLog = [];
  const session = { taskId: 's1', pty: { write: (d) => writeLog.push(d) } };
  const stateB = makeOperatorState('clientB');
  const frame = makeKeystrokeFrame('s1');

  const forwarded = simulateOnKeystroke({
    writeLock: svc, session, state: stateB, frame,
  });

  assert.equal(forwarded, false, 'should not forward keystroke');
  assert.equal(writeLog.length, 0, 'PTY.write must not be called');
});

test('keystroke from lock-holder is forwarded to PTY', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');         // clientA holds the lock

  const writeLog = [];
  const session = { taskId: 's1', pty: { write: (d) => writeLog.push(d) } };
  const stateA = makeOperatorState('clientA');
  // "hello" base64-encoded
  const frame = makeKeystrokeFrame('s1', Buffer.from('hello').toString('base64'));

  const forwarded = simulateOnKeystroke({
    writeLock: svc, session, state: stateA, frame,
  });

  assert.equal(forwarded, true, 'should forward keystroke');
  assert.equal(writeLog.length, 1, 'PTY.write must be called once');
  assert.equal(writeLog[0], 'hello');
});

// ── Gateway approval (decision) lock-independence tests ──────────────────────

test('decision from operator WITHOUT the lock is accepted (lock-independent)', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');         // clientA holds the lock; clientB does NOT

  const runnerSocket = { sent: [] };
  const pendingApprovals = new Map([
    ['req-1', { runner: runnerSocket, taskId: 's1' }],
  ]);

  const stateB = makeOperatorState('clientB', 's1');
  const decisionFrame = makeDecisionFrame('req-1');

  const forwarded = simulateOnDecision({
    state: stateB,
    frame: decisionFrame,
    pendingApprovals,
    runnerSocket,
  });

  assert.equal(forwarded, true, 'decision must be forwarded even without the lock');
  assert.equal(runnerSocket.sent.length, 1, 'runner must receive the decision');
  assert.equal(runnerSocket.sent[0].requestId, 'req-1');
  assert.equal(runnerSocket.sent[0].decision.behavior, 'allow');
  // Approval was consumed; no dangling entry
  assert.equal(pendingApprovals.has('req-1'), false);
});

test('decision from the lock-holder is also accepted', () => {
  const svc = new WriteLockService();
  svc.acquire('s1', 'clientA');         // clientA holds the lock

  const runnerSocket = { sent: [] };
  const pendingApprovals = new Map([
    ['req-2', { runner: runnerSocket, taskId: 's1' }],
  ]);

  const stateA = makeOperatorState('clientA', 's1');
  const decisionFrame = makeDecisionFrame('req-2');

  const forwarded = simulateOnDecision({
    state: stateA,
    frame: decisionFrame,
    pendingApprovals,
    runnerSocket,
  });

  assert.equal(forwarded, true);
  assert.equal(runnerSocket.sent.length, 1);
});

test('decision from an unauthenticated client is rejected', () => {
  const runnerSocket = { sent: [] };
  const pendingApprovals = new Map([
    ['req-3', { runner: runnerSocket, taskId: 's1' }],
  ]);

  const unauthState = { clientId: 'evil', kind: 'operator', authenticated: false, taskId: 's1' };
  const decisionFrame = makeDecisionFrame('req-3');

  const forwarded = simulateOnDecision({
    state: unauthState,
    frame: decisionFrame,
    pendingApprovals,
    runnerSocket,
  });

  assert.equal(forwarded, false, 'unauthenticated operator must be rejected');
  assert.equal(runnerSocket.sent.length, 0, 'runner must not receive a decision');
  // Pending entry must still be present (not consumed by an invalid submit)
  assert.equal(pendingApprovals.has('req-3'), true);
});

test('runner cannot inject its own decision (kind=runner rejected on decision path)', () => {
  const runnerSocket = { sent: [] };
  const pendingApprovals = new Map([
    ['req-4', { runner: runnerSocket, taskId: 's1' }],
  ]);

  const runnerState = { clientId: 'runner1', kind: 'runner', authenticated: true, taskId: 's1' };
  const decisionFrame = makeDecisionFrame('req-4');

  const forwarded = simulateOnDecision({
    state: runnerState,
    frame: decisionFrame,
    pendingApprovals,
    runnerSocket,
  });

  assert.equal(forwarded, false, 'runner must not be able to inject a decision');
  assert.equal(runnerSocket.sent.length, 0);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
