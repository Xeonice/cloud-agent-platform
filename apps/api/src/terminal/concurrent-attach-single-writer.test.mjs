/**
 * Dynamic test: "Concurrent attach to a task session is single-writer"
 *
 * Spec (survive-api-redeploy/specs/sandbox-readoption/spec.md, Requirement 4):
 *   The system SHALL allow multiple operators to ATTACH to the same task's named
 *   tmux session as viewers, but SHALL permit only the write-lease holder (via the
 *   existing write-lock mechanism) to inject input; non-holders attached to the
 *   shared pane are read-only and SHALL NOT inject keystrokes.
 *
 * Scenario exercised:
 *   WHEN two operators are attached to the same task's named tmux session and one
 *        holds the write lease
 *   THEN both see the live output, but only the lease holder's keystrokes are
 *        injected into the session and the non-holder's input is suppressed.
 *
 * Strategy: drive the compiled WriteLockService (the pure lease state machine)
 * and the gateway's keystroke-gate logic (isWriter check gating pty.write) with
 * two simulated operator clients on the same session.  No NestJS DI, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distWriteLock = path.resolve(here, '../../dist/write-lock');

// Load compiled artefacts (CJS modules).
const { WriteLockService } = await import(path.join(distWriteLock, 'write-lock.service.js'));
const { LeaseOutcome } = await import(path.join(distWriteLock, 'write-lock.types.js'));

// ---------------------------------------------------------------------------
// Minimal keystroke-gate harness mirroring terminal.gateway.ts onKeystroke()
// ---------------------------------------------------------------------------

/**
 * Simulates the gateway's per-keystroke gate:
 *   if (!writeLock.isWriter(sessionId, clientId)) return;  // suppressed
 *   pty.write(input);                                       // forwarded
 *
 * Returns the list of strings that reached pty.write, i.e. the injected keystrokes.
 */
function simulateKeystroke(writeLock, sessionId, clientId, input) {
  const injected = [];
  const ptyWriteMock = (data) => injected.push(data);

  if (!writeLock.isWriter(sessionId, clientId)) {
    // Non-holder: keystroke suppressed (never reaches pty.write).
    return injected; // empty
  }
  ptyWriteMock(input);
  return injected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('first operator acquires the write lease (single-writer grant)', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // first to connect

  const result = svc.acquire(SESSION, CLIENT_A);
  assert.equal(result.outcome, LeaseOutcome.Acquired, 'first acquire must succeed');
  assert.equal(result.lease?.writerClientId, CLIENT_A, 'lease holder is CLIENT_A');
});

test('second concurrent operator is denied the write lease (at-most-one-writer invariant)', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // writer
  const CLIENT_B = 'c2'; // viewer

  svc.acquire(SESSION, CLIENT_A);
  const result = svc.acquire(SESSION, CLIENT_B);

  assert.equal(result.outcome, LeaseOutcome.Denied,
    'second acquire while lease is live must be denied');
  assert.equal(result.lease?.writerClientId, CLIENT_A,
    'existing holder is unchanged after denial');
});

test('isWriter returns true only for the actual lease holder', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // writer
  const CLIENT_B = 'c2'; // viewer

  svc.acquire(SESSION, CLIENT_A);
  svc.acquire(SESSION, CLIENT_B); // denied

  assert.equal(svc.isWriter(SESSION, CLIENT_A), true, 'CLIENT_A (holder) is writer');
  assert.equal(svc.isWriter(SESSION, CLIENT_B), false, 'CLIENT_B (viewer) is NOT writer');
});

test('SCENARIO — lease holder keystroke reaches PTY; non-holder keystroke is suppressed', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // writer (first to connect)
  const CLIENT_B = 'c2'; // viewer (second to connect, denied)

  // Both operators "attach" to the same session.
  svc.acquire(SESSION, CLIENT_A); // granted
  svc.acquire(SESSION, CLIENT_B); // denied — CLIENT_B stays reader

  // Lease holder sends a keystroke.
  const holderInjected = simulateKeystroke(svc, SESSION, CLIENT_A, 'ls\n');
  // Non-holder sends a keystroke.
  const viewerInjected = simulateKeystroke(svc, SESSION, CLIENT_B, 'rm -rf /\n');

  assert.deepEqual(holderInjected, ['ls\n'],
    'lease holder keystroke MUST be forwarded to the PTY');
  assert.deepEqual(viewerInjected, [],
    'non-holder keystroke MUST be suppressed (not reach PTY)');
});

test('takeover transfers single-writer right; former holder is demoted', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // original writer
  const CLIENT_B = 'c2'; // takes over

  svc.acquire(SESSION, CLIENT_A);

  const takeoverResult = svc.takeover(SESSION, CLIENT_B);
  assert.equal(takeoverResult.outcome, LeaseOutcome.TakenOver, 'takeover outcome');
  assert.equal(takeoverResult.lease?.writerClientId, CLIENT_B, 'CLIENT_B is new holder');
  assert.equal(takeoverResult.demotedClientId, CLIENT_A, 'CLIENT_A reported as demoted');

  // After takeover: exactly one writer, and it is CLIENT_B.
  assert.equal(svc.isWriter(SESSION, CLIENT_B), true, 'new holder is writer');
  assert.equal(svc.isWriter(SESSION, CLIENT_A), false, 'former holder is no longer writer');

  // Keystroke gate reflects the new ownership.
  const newHolderInjected = simulateKeystroke(svc, SESSION, CLIENT_B, 'whoami\n');
  const demotedInjected   = simulateKeystroke(svc, SESSION, CLIENT_A, 'secret\n');
  assert.deepEqual(newHolderInjected, ['whoami\n'], 'new holder keystrokes pass through');
  assert.deepEqual(demotedInjected,   [],           'demoted client keystrokes are suppressed');
});

test('auto-release on disconnect hands lease to remaining operator', () => {
  const svc = new WriteLockService();
  const SESSION = 'task-abc';
  const CLIENT_A = 'c1'; // original writer — then disconnects
  const CLIENT_B = 'c2'; // viewer — should acquire after A leaves

  svc.acquire(SESSION, CLIENT_A); // A is writer
  svc.acquire(SESSION, CLIENT_B); // B is denied

  // A disconnects.
  const released = svc.releaseOnDisconnect(SESSION, CLIENT_A);
  assert.equal(released, true, 'releaseOnDisconnect must return true for the holder');
  assert.equal(svc.getLease(SESSION), null, 'lease is now free');

  // B can now acquire (simulating gateway regrantWriteLeaseToRemaining).
  const reacquire = svc.acquire(SESSION, CLIENT_B);
  assert.equal(reacquire.outcome, LeaseOutcome.Acquired, 'B acquires after A leaves');
  assert.equal(svc.isWriter(SESSION, CLIENT_B), true, 'B is now the single writer');
});
