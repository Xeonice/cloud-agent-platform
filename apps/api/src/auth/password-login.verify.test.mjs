/**
 * Minimal verify-phase test for the "Email and password authentication"
 * requirement of add-private-account-identity (spec: password-login).
 *
 * Scenario covered:
 *   1. Correct credentials for an allowed account establish a session.
 *   2. Wrong password is rejected without disclosure.
 *   3. Unknown email returns the same generic failure (never auto-creates account).
 *
 * This test wires the lowest-level pieces that the spec describes directly
 * against the compiled dist outputs:
 *   - hashPassword / verifyPassword (argon2 util — the hash-only store + constant-time check)
 *   - The endpoint: POST /auth/password — requires the password-login controller
 *     (track 4, task 4.1) to be registered in the module graph.
 *
 * If the password-login controller is not yet wired, the endpoint will not
 * exist and the test will fail. This is intentional ground-truth.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_AUTH = path.resolve(here, '../../dist/auth');

// ---- load compiled helpers -------------------------------------------------

const { hashPassword, verifyPassword } = require(path.join(DIST_AUTH, 'argon2.js'));

// ---- minimal harness -------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// ── UNIT LAYER: argon2 hash+verify (the foundation of the login path) ────────

/**
 * Simulates the core path of the password-login service:
 *   resolve user by email → find 'password' IdentityLink → verifyPassword
 *
 * Returns null (generic failure) for unknown email, no password identity,
 * wrong password, or allowed=false — all returning the SAME null response
 * as required by the spec (fail-closed / no disclosure).
 */
async function simulatePasswordLogin(db, email, candidatePassword) {
  // 1. Resolve user by email (fail-closed: unknown email → null, no disclosure)
  const user = db.users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (!user) return null;

  // 2. Must be allowed (fail-closed: disallowed → null, same generic failure)
  if (!user.allowed) return null;

  // 3. Find the password IdentityLink (fail-closed: no password identity → null)
  const passwordLink = user.identities.find((i) => i.provider === 'password');
  if (!passwordLink) return null;

  // 4. Constant-time argon2 verify (fail-closed: wrong password → null)
  const ok = await verifyPassword(passwordLink.secret, candidatePassword);
  if (!ok) return null;

  // 5. Mint session (simulated — the real path calls mintSessionToken + DB insert)
  return { sessionToken: `session-for-${user.id}`, userId: user.id };
}

const run = async () => {
  console.log('\n=== Email and Password Authentication (password-login spec) ===\n');

  // ── Part A: argon2 building-block unit tests ──────────────────────────────

  console.log('── A. argon2 hash + verify (the building block) ──\n');

  {
    const hash = await hashPassword('correct-horse-battery-staple');
    assert(typeof hash === 'string' && hash.startsWith('$argon2id$'),
      'A1: hashPassword produces a PHC argon2id string');

    const ok = await verifyPassword(hash, 'correct-horse-battery-staple');
    assert(ok === true, 'A2: verifyPassword returns true for the correct password');

    const bad = await verifyPassword(hash, 'wrong-password');
    assert(bad === false, 'A3: verifyPassword returns false for a wrong password');

    const corrupt = await verifyPassword('not-a-valid-hash', 'any');
    assert(corrupt === false,
      'A4: verifyPassword returns false (not throws) for a corrupt stored hash');

    // Passwords are NEVER stored as plaintext — confirm the hash ≠ plaintext.
    assert(hash !== 'correct-horse-battery-staple',
      'A5: stored credential is the hash, never the plaintext');
  }

  // ── Part B: password-login service logic (simulated) ─────────────────────

  console.log('\n── B. Password-login service scenarios (simulated) ──\n');

  const PLAINTEXT = 'hunter2!';
  const hash = await hashPassword(PLAINTEXT);

  // In-memory DB double matching what the real PrismaService would hold.
  const db = {
    users: [
      {
        id: 'user-allowed',
        email: 'alice@example.com',
        allowed: true,
        mustChangePassword: false,
        identities: [{ provider: 'password', secret: hash }],
      },
      {
        id: 'user-disallowed',
        email: 'blocked@example.com',
        allowed: false,
        mustChangePassword: false,
        identities: [{ provider: 'password', secret: hash }],
      },
      {
        id: 'user-otp-only',
        email: 'otponly@example.com',
        allowed: true,
        mustChangePassword: false,
        identities: [], // no password identity
      },
    ],
  };

  // Scenario 1: Correct credentials for an allowed account establish a session.
  {
    const result = await simulatePasswordLogin(db, 'alice@example.com', PLAINTEXT);
    assert(result !== null, 'B1a: correct credentials for an allowed account → session established');
    assert(result?.sessionToken !== undefined, 'B1b: session credential is returned on success');
  }

  // Scenario 2: Wrong password is rejected without disclosure.
  {
    const result = await simulatePasswordLogin(db, 'alice@example.com', 'wrong-password');
    assert(result === null,
      'B2: wrong password → generic null (no disclosure of whether email exists)');
  }

  // Scenario 3: Unknown email returns the same generic failure (never auto-creates).
  {
    const resultUnknown = await simulatePasswordLogin(db, 'nosuchuser@example.com', PLAINTEXT);
    assert(resultUnknown === null,
      'B3: unknown email → same generic null (no account created, no disclosure)');
    // Confirm the db is unmodified (no auto-creation side-effect in the service).
    assert(db.users.length === 3,
      'B3b: no new account was created for an unknown email (no public registration)');
  }

  // Additional fail-closed cases.
  {
    const disallowed = await simulatePasswordLogin(db, 'blocked@example.com', PLAINTEXT);
    assert(disallowed === null,
      'B4: disallowed account → generic null (allowed=false fails same as wrong password)');

    const noPasswordId = await simulatePasswordLogin(db, 'otponly@example.com', PLAINTEXT);
    assert(noPasswordId === null,
      'B5: no password identity → generic null (same failure regardless of cause)');
  }

  // ── Part C: endpoint existence check (the missing controller gate) ────────

  console.log('\n── C. POST /auth/password endpoint existence ──\n');

  /**
   * The spec requires a PUBLIC endpoint POST /auth/password.
   * Task 4.1 (password-login controller) is UNCHECKED in tasks.md.
   * The app.module.ts comment explicitly says:
   *   "the password-auth controllers are NOT yet implemented
   *    (track password-auth has no module to wire)"
   *
   * We probe this by checking whether the compiled dist contains
   * a password controller/service file. If it does not exist,
   * the endpoint is not wired and the requirement is NOT satisfied.
   */
  import('node:fs').then(async (fs) => {
    const DIST_ROOT = path.resolve(here, '../../dist');

    // Look for a password controller or service (NOT spec/test files).
    // The spec requires a real password-login controller (task 4.1) to be
    // compiled and wired. A controller will typically be named:
    //   password.controller.js | password-login.controller.js | auth-password.controller.js
    // or live in a dedicated directory (auth-password/).
    function findPasswordControllerFiles(dir) {
      let found = [];
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return found;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          found = found.concat(findPasswordControllerFiles(full));
        } else if (
          e.isFile() &&
          e.name.toLowerCase().includes('password') &&
          e.name.endsWith('.js') &&
          // Exclude spec / test files — they test things, not implement them.
          !e.name.includes('.spec.') &&
          !e.name.includes('.test.')
        ) {
          found.push(full);
        }
      }
      return found;
    }

    const passwordFiles = findPasswordControllerFiles(DIST_ROOT);
    assert(
      passwordFiles.length > 0,
      `C1: POST /auth/password controller is compiled and wired (found: ${passwordFiles.join(', ') || 'none'})`,
    );

    // Print summary.
    console.log(`\n${'─'.repeat(56)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed === 0) {
      console.log('ALL TESTS PASSED');
      process.exit(0);
    } else {
      console.error('SOME TESTS FAILED');
      process.exit(1);
    }
  });
};

void run();
