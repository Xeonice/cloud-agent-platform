/**
 * Minimal ground-truth test: "Single-writer multi-reader lease" (D7 §7.1)
 *
 * Core requirement: at most ONE client holds the write lease for a session at
 * any given time.  All other connected clients are readers — they can still
 * receive the output stream but are denied the raw-write lease.
 *
 * Scenarios tested:
 *   1. First client to acquire becomes the writer (Acquired).
 *   2. A second client's acquire is denied (Denied); the existing lease
 *      is unchanged — the first client is STILL the writer.
 *   3. Multiple additional readers are all denied; the single writer never
 *      changes regardless of how many readers try to acquire.
 *   4. After the writer explicitly releases (releaseOnDisconnect), a new
 *      client can become the writer (single-writer rotates, not accumulates).
 *   5. A reader is confirmed to NOT be a writer via isWriter().
 *   6. Only one writer exists per session even after multiple concurrent
 *      acquire attempts from different readers.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// NestJS decorators need reflect-metadata.
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

// ─── assertion helper ─────────────────────────────────────────────────────────
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

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== Single-writer / multi-reader lease (D7 §7.1) ===\n');

// ── Scenario 1: First acquirer becomes the writer ────────────────────────────
console.log('Scenario 1 — first client becomes the writer');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });
  const session = 'sess-1';

  const result = svc.acquire(session, 'clientA');

  assert(result.outcome === LeaseOutcome.Acquired,
    'S1a: outcome is Acquired for the first requester');
  assert(result.lease !== null,
    'S1b: a lease object is returned');
  assert(result.lease.writerClientId === 'clientA',
    'S1c: lease.writerClientId is clientA');
  assert(result.demotedClientId === null,
    'S1d: no prior holder was demoted');
  assert(svc.isWriter(session, 'clientA'),
    'S1e: isWriter confirms clientA is the writer');
}

// ── Scenario 2: Second client's acquire is denied; first client still holds ──
console.log('\nScenario 2 — second client is denied; first client remains writer');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });
  const session = 'sess-2';

  svc.acquire(session, 'clientA');   // clientA is the writer

  const result = svc.acquire(session, 'clientB'); // clientB tries to acquire

  assert(result.outcome === LeaseOutcome.Denied,
    'S2a: clientB outcome is Denied');
  assert(result.lease !== null,
    'S2b: existing lease is returned with the Denied response');
  assert(result.lease.writerClientId === 'clientA',
    'S2c: existing lease still belongs to clientA');
  assert(result.demotedClientId === null,
    'S2d: no demotion on Denied (live lease unchanged)');

  // Confirm the original writer is unaffected
  assert(svc.isWriter(session, 'clientA'),
    'S2e: clientA is STILL the writer after clientB is denied');
  assert(!svc.isWriter(session, 'clientB'),
    'S2f: clientB is NOT a writer (it is a reader)');
}

// ── Scenario 3: Many readers all denied; exactly one writer at all times ─────
console.log('\nScenario 3 — multiple readers all denied; single writer persists');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });
  const session = 'sess-3';
  const writer = 'clientWriter';
  const readers = ['r1', 'r2', 'r3', 'r4', 'r5'];

  svc.acquire(session, writer);

  for (const reader of readers) {
    const result = svc.acquire(session, reader);
    assert(result.outcome === LeaseOutcome.Denied,
      `S3-${reader}: reader ${reader} is denied`);
    assert(!svc.isWriter(session, reader),
      `S3-${reader}: ${reader} is NOT a writer (remains a reader)`);
  }

  // After all readers tried (and failed), writer still holds the lease
  assert(svc.isWriter(session, writer),
    'S3-final: original writer still holds the single write lease after all reader attempts');

  // Sanity: exactly zero readers became writers
  const writerCount = [writer, ...readers].filter(c => svc.isWriter(session, c)).length;
  assert(writerCount === 1,
    `S3-count: exactly 1 writer across all clients (got ${writerCount})`);
}

// ── Scenario 4: After writer releases, a reader can become the new writer ────
console.log('\nScenario 4 — writer releases; reader can then acquire');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });
  const session = 'sess-4';

  svc.acquire(session, 'clientA');

  // Verify clientB is denied while clientA holds
  const denied = svc.acquire(session, 'clientB');
  assert(denied.outcome === LeaseOutcome.Denied,
    'S4a: clientB denied while clientA holds the lease');

  // clientA disconnects → lease is released immediately
  const released = svc.releaseOnDisconnect(session, 'clientA');
  assert(released === true,
    'S4b: releaseOnDisconnect returns true when the writer disconnects');
  assert(!svc.isWriter(session, 'clientA'),
    'S4c: clientA is no longer a writer after disconnect');

  // Now clientB (a former reader) can acquire
  const acquired = svc.acquire(session, 'clientB');
  assert(acquired.outcome === LeaseOutcome.Acquired,
    'S4d: clientB acquires the lease after the writer released');
  assert(svc.isWriter(session, 'clientB'),
    'S4e: clientB is now the single writer');
}

// ── Scenario 5: A reader disconnect is a no-op ───────────────────────────────
console.log('\nScenario 5 — reader disconnect is a no-op (lease unaffected)');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });
  const session = 'sess-5';

  svc.acquire(session, 'clientA');  // clientA is the writer; clientB is a reader

  const released = svc.releaseOnDisconnect(session, 'clientB'); // reader disconnects
  assert(released === false,
    'S5a: reader disconnect returns false (no lease to release)');
  assert(svc.isWriter(session, 'clientA'),
    'S5b: writer (clientA) is unaffected by a reader disconnect');
}

// ── Scenario 6: Session isolation — leases for different sessions independent ─
console.log('\nScenario 6 — sessions are isolated (writer in s6a does not block s6b)');
{
  const svc = new WriteLockService({ leaseTtlMs: 30_000 });

  svc.acquire('s6a', 'clientA');
  const result = svc.acquire('s6b', 'clientB');

  assert(result.outcome === LeaseOutcome.Acquired,
    'S6a: clientB can acquire a different session while clientA holds s6a');
  assert(svc.isWriter('s6a', 'clientA'),
    'S6b: clientA is writer for s6a');
  assert(svc.isWriter('s6b', 'clientB'),
    'S6c: clientB is writer for s6b');
  assert(!svc.isWriter('s6a', 'clientB'),
    'S6d: clientB is NOT a writer for s6a (cross-session isolation)');
  assert(!svc.isWriter('s6b', 'clientA'),
    'S6e: clientA is NOT a writer for s6b (cross-session isolation)');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED — Single-writer multi-reader lease requirement SATISFIED.');
  process.exit(0);
}
