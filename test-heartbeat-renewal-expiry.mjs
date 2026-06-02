/**
 * Minimal test: Heartbeat renewal and expiry (write-lock service, D7 §7.2)
 *
 * Scenarios covered:
 *  1. Heartbeat before expiry renews the lease (outcome = 'renewed', leaseExpiry advances).
 *  2. Heartbeat from a non-holder is denied.
 *  3. Heartbeat after the lease has expired is denied and the lease is released
 *     (a new client can then acquire it).
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

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a WriteLockService with a controllable clock. */
function makeService(nowMs, ttlMs = 30_000) {
  const clock = { t: nowMs };
  const svc = new WriteLockService({ leaseTtlMs: ttlMs }, () => clock.t);
  return { svc, clock };
}

// ─── Scenario 1: heartbeat before expiry renews the lease ─────────────────────
console.log('\nScenario 1 — heartbeat before expiry renews the lease');
{
  const ttl = 10_000; // 10 s
  const { svc, clock } = makeService(0, ttl);

  // Acquire at t=0
  const acquired = svc.acquire('s1', 'c1');
  assert(acquired.outcome === LeaseOutcome.Acquired, 'Initial acquire succeeds');
  const firstExpiry = acquired.lease.leaseExpiry; // should be 0 + 10_000 = 10_000
  assert(firstExpiry === ttl, `First leaseExpiry = now(0) + ttl(${ttl}) = ${firstExpiry}`);

  // Advance to t=5_000 (halfway through the lease) and send a heartbeat
  clock.t = 5_000;
  const hb = svc.heartbeat('s1', 'c1');
  assert(hb.outcome === LeaseOutcome.Renewed, 'Heartbeat returns Renewed before expiry');
  assert(hb.lease !== null, 'Renewed lease is not null');
  const renewedExpiry = hb.lease.leaseExpiry; // should be 5_000 + 10_000 = 15_000
  assert(
    renewedExpiry === clock.t + ttl,
    `Renewed leaseExpiry = now(${clock.t}) + ttl(${ttl}) = ${renewedExpiry}`,
  );
  assert(renewedExpiry > firstExpiry, 'Renewed expiry is later than original expiry');

  // isWriter should still confirm c1 as the writer
  assert(svc.isWriter('s1', 'c1'), 'c1 is still writer after heartbeat');
}

// ─── Scenario 2: heartbeat from a non-holder is denied ────────────────────────
console.log('\nScenario 2 — heartbeat from a non-holder is denied');
{
  const { svc, clock } = makeService(0, 10_000);

  svc.acquire('s2', 'c1'); // c1 holds the lease

  clock.t = 3_000;
  const hb = svc.heartbeat('s2', 'c2'); // c2 is not the holder
  assert(hb.outcome === LeaseOutcome.Denied, 'Non-holder heartbeat is denied');
  // The existing lease must be unchanged
  assert(svc.isWriter('s2', 'c1'), 'c1 still holds the lease after non-holder heartbeat');
}

// ─── Scenario 3: heartbeat after expiry releases the lease ────────────────────
console.log('\nScenario 3 — heartbeat after expiry releases the lease (new client can acquire)');
{
  const ttl = 10_000;
  const { svc, clock } = makeService(0, ttl);

  svc.acquire('s3', 'c1'); // c1 holds, leaseExpiry = 10_000

  // Jump past expiry
  clock.t = ttl + 1; // t = 10_001 — lease has expired
  const hb = svc.heartbeat('s3', 'c1');
  assert(hb.outcome === LeaseOutcome.Denied, 'Expired heartbeat is denied');
  assert(hb.lease === null, 'Expired heartbeat returns null lease');

  // The session is now free — c2 should be able to acquire it
  const acquired = svc.acquire('s3', 'c2');
  assert(acquired.outcome === LeaseOutcome.Acquired, 'New client acquires after expiry');
  assert(acquired.lease.writerClientId === 'c2', 'New lease is held by c2');
  assert(acquired.demotedClientId === null, 'No demotion reported (old lease was already gone)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All heartbeat renewal/expiry scenarios PASSED.');
}
