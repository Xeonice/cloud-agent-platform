/**
 * Minimal test for requirement:
 *   "Single-writer multi-reader lease"
 *
 * Spec scenario under test (write-lock-and-takeover/spec.md):
 *   Scenario: Only one writer holds the lease
 *     WHEN  two clients are connected to the same session and one already holds
 *           the write lease
 *     THEN  the second client is denied and is not granted concurrent raw write
 *           access
 *     AND   both clients continue to receive the read stream (modelled here as
 *           both being able to call getLease and observe the current writer)
 *
 *   Scenario: Lease records writer and expiry
 *     WHEN  the lease state for an active session is inspected
 *     THEN  it records the current writerClientId and a leaseExpiry timestamp
 */

// ---------------------------------------------------------------------------
// Inline the WriteLockService logic (mirrors write-lock.service.ts + types)
// No transpile step — plain ESM.
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

    // A different client holds a live lease — requester stays a reader.
    return { outcome: LeaseOutcome.Denied, lease: current, demotedClientId: null };
  }

  heartbeat(sessionId, clientId) {
    const current = this.#leases.get(sessionId);

    if (current === undefined || current.writerClientId !== clientId) {
      return { outcome: LeaseOutcome.Denied, lease: current ?? null, demotedClientId: null };
    }

    if (this.#isExpired(current)) {
      this.#leases.delete(sessionId);
      return { outcome: LeaseOutcome.Denied, lease: null, demotedClientId: null };
    }

    return this.#grant(sessionId, clientId, LeaseOutcome.Renewed, null);
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
// Assertion helpers
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
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== Single-writer multi-reader lease ===\n');

// T1: Scenario "Only one writer holds the lease"
//   clientA acquires first → clientB is denied and remains a reader
{
  const svc = new WriteLockService();
  const session = 'session-1';
  const clientA = 'client-A';
  const clientB = 'client-B';

  const resultA = svc.acquire(session, clientA);
  assert(resultA.outcome === LeaseOutcome.Acquired, 'T1a: clientA acquires the lease (Acquired)');
  assert(resultA.lease.writerClientId === clientA, 'T1b: lease.writerClientId is clientA');

  const resultB = svc.acquire(session, clientB);
  assert(resultB.outcome === LeaseOutcome.Denied, 'T1c: clientB is denied the lease while clientA holds it');
  assert(!svc.isWriter(session, clientB), 'T1d: clientB is NOT a writer (isWriter returns false)');

  // Both clients can still observe the lease (read stream modelled as getLease access)
  const leaseSeenByA = svc.getLease(session);
  const leaseSeenByB = svc.getLease(session);
  assert(leaseSeenByA !== null, 'T1e: clientA can observe the lease (read access)');
  assert(leaseSeenByB !== null, 'T1f: clientB can observe the lease (read access)');
  assert(svc.isWriter(session, clientA), 'T1g: clientA remains the single writer');
}

// T2: Scenario "Lease records writer and expiry"
//   After acquiring, the lease state contains writerClientId and leaseExpiry
{
  const t0 = Date.now();
  const svc = new WriteLockService({ leaseTtlMs: 30_000 }, () => t0);
  const session = 'session-2';
  const clientC = 'client-C';

  const result = svc.acquire(session, clientC);
  const lease = svc.getLease(session);

  assert(lease !== null, 'T2a: lease is recorded after acquire');
  assert(lease.writerClientId === clientC, 'T2b: lease.writerClientId matches the acquiring client');
  assert(typeof lease.leaseExpiry === 'number', 'T2c: lease.leaseExpiry is a number');
  assert(lease.leaseExpiry > t0, 'T2d: lease.leaseExpiry is in the future relative to acquisition time');
  assert(lease.leaseExpiry === t0 + 30_000, 'T2e: lease.leaseExpiry equals now + leaseTtlMs');
  assert(result.lease.writerClientId === clientC, 'T2f: acquire result carries lease with correct writerClientId');
}

// T3: only one writer across multiple acquire attempts from different clients
{
  const svc = new WriteLockService();
  const session = 'session-3';
  const clients = ['c1', 'c2', 'c3', 'c4'];

  // c1 acquires
  svc.acquire(session, clients[0]);

  // All others must be denied
  for (let i = 1; i < clients.length; i++) {
    const r = svc.acquire(session, clients[i]);
    assert(r.outcome === LeaseOutcome.Denied, `T3-${clients[i]}: ${clients[i]} denied while c1 holds lease`);
  }

  // Exactly one writer
  const writers = clients.filter(c => svc.isWriter(session, c));
  assert(writers.length === 1, 'T3: exactly one writer at a time');
  assert(writers[0] === clients[0], 'T3: writer is the first acquirer (c1)');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
