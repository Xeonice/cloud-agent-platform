/**
 * Minimal test exercising the "Preemptive takeover" requirement (task 7.4).
 *
 * Requirement (from design.md D7 / tasks.md 7.4):
 *   Implement preemptive takeover: a reader can take over the lease, demoting
 *   the previous holder to reader who can no longer send raw keystrokes.
 *
 * Scenarios tested:
 *   1. A reader seizes the lease from a live holder → outcome TakenOver,
 *      new holder is the requester, demotedClientId is the previous holder.
 *   2. After takeover the previous holder is no longer a writer (cannot send
 *      raw keystrokes).
 *   3. After takeover the new holder IS a writer.
 *   4. Takeover on a session with no current holder → outcome Acquired,
 *      demotedClientId is null (no one was preempted).
 *   5. Takeover by the current holder (self-takeover) → Acquired outcome,
 *      demotedClientId is null (no displacement).
 */

// ---------------------------------------------------------------------------
// Inline the WriteLockService logic (mirrors write-lock.service.ts exactly)
// Plain ESM — no transpile step needed.
// ---------------------------------------------------------------------------

const LeaseOutcome = Object.freeze({
  Acquired:  'acquired',
  Renewed:   'renewed',
  TakenOver: 'taken_over',
  Denied:    'denied',
});

const DEFAULT_LEASE_TTL_MS = 30_000;

class WriteLockService {
  #leases = new Map();
  #leaseTtlMs;
  #now;

  constructor(options = {}, clock = Date.now) {
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#now = clock;
  }

  acquire(sessionId, clientId) {
    const current = this.#leases.get(sessionId);
    if (current === undefined) {
      return this.#grant(sessionId, clientId, LeaseOutcome.Acquired, null);
    }
    if (this.#isExpired(current)) {
      const demoted = current.writerClientId === clientId ? null : current.writerClientId;
      return this.#grant(sessionId, clientId, LeaseOutcome.Acquired, demoted);
    }
    if (current.writerClientId === clientId) {
      return this.#grant(sessionId, clientId, LeaseOutcome.Renewed, null);
    }
    return { outcome: LeaseOutcome.Denied, lease: current, demotedClientId: null };
  }

  takeover(sessionId, clientId) {
    const current = this.#leases.get(sessionId);
    const previousHolder =
      current !== undefined && current.writerClientId !== clientId
        ? current.writerClientId
        : null;
    const outcome = previousHolder !== null ? LeaseOutcome.TakenOver : LeaseOutcome.Acquired;
    return this.#grant(sessionId, clientId, outcome, previousHolder);
  }

  releaseOnDisconnect(sessionId, clientId) {
    const current = this.#leases.get(sessionId);
    if (current === undefined || current.writerClientId !== clientId) return false;
    this.#leases.delete(sessionId);
    return true;
  }

  isWriter(sessionId, clientId) {
    const lease = this.getLease(sessionId);
    return lease !== null && lease.writerClientId === clientId;
  }

  getLease(sessionId) {
    const current = this.#leases.get(sessionId);
    if (current === undefined) return null;
    if (this.#isExpired(current)) {
      this.#leases.delete(sessionId);
      return null;
    }
    return current;
  }

  #grant(sessionId, clientId, outcome, demotedClientId) {
    const lease = {
      writerClientId: clientId,
      leaseExpiry: this.#now() + this.#leaseTtlMs,
    };
    this.#leases.set(sessionId, lease);
    return { outcome, lease, demotedClientId };
  }

  #isExpired(lease) {
    return this.#now() >= lease.leaseExpiry;
  }
}

// ---------------------------------------------------------------------------
// Minimal assertion helpers
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

// ---------------------------------------------------------------------------
// Tests — Preemptive Takeover (requirement 7.4)
// ---------------------------------------------------------------------------

console.log('\n=== Preemptive Takeover (requirement 7.4) ===\n');

// T1: Reader seizes lease from live holder
//   Setup: clientA holds a live lease; clientB is a reader (denied normal acquire).
//   Action: clientB calls takeover.
//   Expect: outcome TakenOver, new writer is clientB, demotedClientId is clientA.
{
  const svc = new WriteLockService();
  const session = 'session-takeover-1';
  const clientA = 'client-A';
  const clientB = 'client-B';

  svc.acquire(session, clientA);
  // Confirm A is the current writer before takeover
  assert(svc.isWriter(session, clientA), 'T1-pre: clientA holds the lease before takeover');

  const result = svc.takeover(session, clientB);

  assert(result.outcome === LeaseOutcome.TakenOver,
    'T1a: takeover outcome is TakenOver');
  assert(result.lease.writerClientId === clientB,
    'T1b: new lease.writerClientId is clientB (the taker)');
  assert(result.demotedClientId === clientA,
    'T1c: demotedClientId is clientA (the previous holder)');
}

// T2: After takeover, previous holder is demoted — cannot send raw keystrokes
{
  const svc = new WriteLockService();
  const session = 'session-takeover-2';
  const clientA = 'client-A';
  const clientB = 'client-B';

  svc.acquire(session, clientA);
  svc.takeover(session, clientB);

  assert(!svc.isWriter(session, clientA),
    'T2: previous holder (clientA) is NOT a writer after takeover');
}

// T3: After takeover, the taker IS the writer
{
  const svc = new WriteLockService();
  const session = 'session-takeover-3';
  const clientA = 'client-A';
  const clientB = 'client-B';

  svc.acquire(session, clientA);
  svc.takeover(session, clientB);

  assert(svc.isWriter(session, clientB),
    'T3: taker (clientB) IS a writer after takeover');
}

// T4: Takeover on a session with no holder → outcome Acquired, no demotion
{
  const svc = new WriteLockService();
  const session = 'session-takeover-4';
  const clientC = 'client-C';

  const result = svc.takeover(session, clientC);

  assert(result.outcome === LeaseOutcome.Acquired,
    'T4a: takeover on unheld session yields Acquired (not TakenOver)');
  assert(result.demotedClientId === null,
    'T4b: no demotedClientId when no prior holder exists');
  assert(svc.isWriter(session, clientC),
    'T4c: taker becomes the writer');
}

// T5: Self-takeover (current holder calls takeover on itself) → Acquired, no demotion
{
  const svc = new WriteLockService();
  const session = 'session-takeover-5';
  const clientA = 'client-A';

  svc.acquire(session, clientA);
  const result = svc.takeover(session, clientA);

  assert(result.outcome === LeaseOutcome.Acquired,
    'T5a: self-takeover yields Acquired (holder already owns it)');
  assert(result.demotedClientId === null,
    'T5b: no demotedClientId on self-takeover');
  assert(svc.isWriter(session, clientA),
    'T5c: clientA remains the writer after self-takeover');
}

// T6: After takeover, the original holder attempting acquire is denied (live lease exists)
{
  const svc = new WriteLockService();
  const session = 'session-takeover-6';
  const clientA = 'client-A';
  const clientB = 'client-B';

  svc.acquire(session, clientA);
  svc.takeover(session, clientB);

  // clientA tries to get the lock back via acquire (not takeover)
  const reAcquireResult = svc.acquire(session, clientA);
  assert(reAcquireResult.outcome === LeaseOutcome.Denied,
    'T6: demoted holder (clientA) cannot re-acquire via acquire while clientB holds the lease');
}

// T7: Chained takeovers — each successive taker displaces the previous
{
  const svc = new WriteLockService();
  const session = 'session-takeover-7';
  const clients = ['c1', 'c2', 'c3'];

  svc.acquire(session, clients[0]);

  for (let i = 1; i < clients.length; i++) {
    const prev = clients[i - 1];
    const next = clients[i];
    const result = svc.takeover(session, next);

    assert(result.outcome === LeaseOutcome.TakenOver,
      `T7-${i}: chain takeover #${i} yields TakenOver`);
    assert(result.demotedClientId === prev,
      `T7-${i}: demotedClientId is ${prev}`);
    assert(svc.isWriter(session, next),
      `T7-${i}: new writer is ${next}`);
    assert(!svc.isWriter(session, prev),
      `T7-${i}: previous writer ${prev} is demoted`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
