/**
 * Minimal test: Auto-release on disconnect (write-lock service, D7 §7.3)
 *
 * Requirement: The orchestrator SHALL release a session's write lease immediately
 * when the writer client's connection drops, without waiting for leaseExpiry.
 *
 * Scenario: Writer disconnect frees the lease
 *  - WHEN the connection of the client holding the write lease drops
 *  - THEN the orchestrator releases that session's lease promptly rather than
 *    waiting for leaseExpiry
 *
 * Sub-cases covered:
 *  1. Writer disconnects → lease is released immediately (not waiting for expiry).
 *  2. After the writer disconnects, a second client can acquire the freed lease.
 *  3. A non-holder (reader) disconnect is a no-op — the lease is not disturbed.
 *  4. Disconnecting when no lease exists is a no-op and returns false.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load compiled output; reflect-metadata must come first for NestJS decorators.
require(path.join(
  __dirname,
  'node_modules/.pnpm/reflect-metadata@0.2.2/node_modules/reflect-metadata',
));
const { WriteLockService } = require(path.join(
  __dirname,
  'apps/api/dist/write-lock/write-lock.service.js',
));
const { LeaseOutcome } = require(path.join(
  __dirname,
  'apps/api/dist/write-lock/write-lock.types.js',
));

// ─── tiny assertion helper ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS  ${msg}`);
    passed++;
  } else {
    console.error(`  FAIL  ${msg}`);
    failed++;
  }
}

/** Build a WriteLockService with a controllable clock (defaults to t=0). */
function makeService(nowMs = 0, ttlMs = 30_000) {
  const clock = { t: nowMs };
  const svc = new WriteLockService({ leaseTtlMs: ttlMs }, () => clock.t);
  return { svc, clock };
}

// ─── Scenario 1: writer disconnect releases the lease immediately ─────────────
console.log('\nScenario 1 — writer disconnect releases the lease immediately');
{
  const ttl = 30_000;
  const { svc } = makeService(0, ttl);

  // c1 acquires the write lease; leaseExpiry is well in the future
  const acquired = svc.acquire('s1', 'c1');
  assert(acquired.outcome === LeaseOutcome.Acquired, 'c1 acquires the lease');
  assert(svc.isWriter('s1', 'c1'), 'c1 is confirmed as writer before disconnect');

  // c1's WebSocket drops — simulate with releaseOnDisconnect
  const released = svc.releaseOnDisconnect('s1', 'c1');
  assert(released === true, 'releaseOnDisconnect returns true when the writer disconnects');

  // The lease must be gone immediately — no need to wait for leaseExpiry
  const leaseAfter = svc.getLease('s1');
  assert(leaseAfter === null, 'Lease is null immediately after writer disconnects');
  assert(!svc.isWriter('s1', 'c1'), 'c1 is no longer the writer after disconnect');
}

// ─── Scenario 2: a new client can acquire the freed lease immediately ─────────
console.log('\nScenario 2 — a second client can acquire the lease after writer disconnects');
{
  const ttl = 30_000;
  const { svc } = makeService(0, ttl);

  svc.acquire('s2', 'c1'); // c1 holds the lease with 30 s remaining

  // c1 disconnects
  svc.releaseOnDisconnect('s2', 'c1');

  // c2 connects and tries to acquire — should succeed without waiting for TTL
  const result = svc.acquire('s2', 'c2');
  assert(result.outcome === LeaseOutcome.Acquired, 'c2 acquires the lease after c1 disconnects');
  assert(result.lease !== null, 'Returned lease is not null');
  assert(result.lease.writerClientId === 'c2', 'New lease is held by c2');
  assert(svc.isWriter('s2', 'c2'), 'c2 is now confirmed as writer');
}

// ─── Scenario 3: reader (non-holder) disconnect is a no-op ───────────────────
console.log('\nScenario 3 — reader disconnect does not affect the existing lease');
{
  const ttl = 30_000;
  const { svc } = makeService(0, ttl);

  svc.acquire('s3', 'c1'); // c1 holds the lease; c2 is just a reader

  const released = svc.releaseOnDisconnect('s3', 'c2'); // c2 was never the writer
  assert(released === false, 'releaseOnDisconnect returns false for a non-holder');
  assert(svc.isWriter('s3', 'c1'), 'c1 still holds the lease after reader disconnects');
  const lease = svc.getLease('s3');
  assert(lease !== null && lease.writerClientId === 'c1', 'Lease record is unchanged');
}

// ─── Scenario 4: disconnect with no lease at all is a no-op ──────────────────
console.log('\nScenario 4 — disconnect when no lease exists returns false');
{
  const { svc } = makeService(0);

  const released = svc.releaseOnDisconnect('s4', 'c1'); // no lease has ever been acquired
  assert(released === false, 'releaseOnDisconnect returns false when no lease exists');
  assert(svc.getLease('s4') === null, 'getLease still returns null');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All auto-release-on-disconnect scenarios PASSED.');
}
