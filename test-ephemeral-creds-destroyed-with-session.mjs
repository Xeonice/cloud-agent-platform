/**
 * Minimal test: "Ephemeral credentials destroyed with the session"
 *
 * Requirements exercised (from session-credential.ts / session-credentials.service.ts,
 * design D8 / spec 8.4):
 *
 *   1. A provisioned credential authenticates while the session is alive.
 *   2. After destroyForSession() is called the credential can NO LONGER authenticate.
 *   3. After destroyForSession() hasActiveCredential() returns false.
 *   4. Attempting to reveal() a destroyed credential throws.
 *   5. A credential is never shared across sessions — two sessions get distinct secrets.
 *   6. destroyAll() (module teardown path) revokes every outstanding credential.
 *   7. Provisioning the same session twice throws (single-session invariant).
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SessionCredential } = require(
  './apps/api/dist/creds/session-credential.js',
);
const { SessionCredentialsService } = require(
  './apps/api/dist/creds/session-credentials.service.js',
);

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertThrows(label, fn) {
  try {
    fn();
    console.error(`  FAIL  ${label} (expected throw, but none thrown)`);
    failed++;
  } catch {
    console.log(`  PASS  ${label}`);
    passed++;
  }
}

// ── Scenario 1: live credential authenticates ────────────────────────────────
{
  const svc = new SessionCredentialsService();
  const cred = svc.provisionForSession('sess-1');
  const secret = cred.reveal();
  assert(
    'live credential authenticates via service.verify()',
    svc.verify('sess-1', secret),
  );
  assert(
    'hasActiveCredential() is true while session is live',
    svc.hasActiveCredential('sess-1'),
  );
}

// ── Scenario 2: credential can no longer authenticate after session ends ─────
{
  const svc = new SessionCredentialsService();
  const cred = svc.provisionForSession('sess-2');
  const secret = cred.reveal();

  // Simulate session completion
  svc.destroyForSession('sess-2', 'completed');

  assert(
    'service.verify() returns false after session ends',
    !svc.verify('sess-2', secret),
  );
}

// ── Scenario 3: hasActiveCredential() is false after destroy ─────────────────
{
  const svc = new SessionCredentialsService();
  svc.provisionForSession('sess-3');
  svc.destroyForSession('sess-3', 'failed');
  assert(
    'hasActiveCredential() is false after session ends',
    !svc.hasActiveCredential('sess-3'),
  );
}

// ── Scenario 4: reveal() throws on a destroyed credential ────────────────────
{
  const svc = new SessionCredentialsService();
  const cred = svc.provisionForSession('sess-4');
  svc.destroyForSession('sess-4', 'teardown');
  assertThrows(
    'reveal() throws after credential is destroyed',
    () => cred.reveal(),
  );
}

// ── Scenario 5: credentials are not shared across sessions ───────────────────
{
  const svc = new SessionCredentialsService();
  const credA = svc.provisionForSession('sess-A');
  const credB = svc.provisionForSession('sess-B');
  const secretA = credA.reveal();
  const secretB = credB.reveal();
  assert(
    'two sessions receive distinct secrets (not shared)',
    secretA !== secretB,
  );
  // Cross-verify: session A's secret must not work for session B
  assert(
    'session A secret does not authenticate session B',
    !svc.verify('sess-B', secretA),
  );
}

// ── Scenario 6: destroyAll() revokes every outstanding credential ─────────────
{
  const svc = new SessionCredentialsService();
  const credX = svc.provisionForSession('sess-X');
  const credY = svc.provisionForSession('sess-Y');
  const secretX = credX.reveal();
  const secretY = credY.reveal();

  svc.destroyAll('teardown');

  assert(
    'session X secret no longer authenticates after destroyAll()',
    !svc.verify('sess-X', secretX),
  );
  assert(
    'session Y secret no longer authenticates after destroyAll()',
    !svc.verify('sess-Y', secretY),
  );
  assert(
    'activeCount is 0 after destroyAll()',
    svc.activeCount === 0,
  );
}

// ── Scenario 7: provisioning the same session twice throws ───────────────────
{
  const svc = new SessionCredentialsService();
  svc.provisionForSession('sess-dup');
  assertThrows(
    'provisioning same session twice throws (single-session invariant)',
    () => svc.provisionForSession('sess-dup'),
  );
}

// ── Scenario 8: destroyed credential's matches() always returns false ─────────
{
  const cred = SessionCredential.mint('sess-raw');
  const secret = cred.reveal();
  cred.destroy();
  assert(
    'matches() returns false after destroy()',
    !cred.matches(secret),
  );
  assert(
    'isDestroyed is true after destroy()',
    cred.isDestroyed,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
