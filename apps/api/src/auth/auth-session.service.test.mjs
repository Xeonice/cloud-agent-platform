/**
 * Verify-phase test for the allowlist-gated, revocable session SERVICE
 * (be-oauth-allowlist, tasks 2.4 / 2.5 / 2.6).
 *
 * Unlike the pure-helper tests (allowlist.test.mjs / session-token.test.mjs),
 * this drives the REAL compiled AuthSessionService composition by importing
 * dist/auth/auth-session.service.js and injecting a fake Prisma + an explicit
 * env. It exercises the load-bearing ordering and re-check logic that lives in
 * the service itself, not in any single helper:
 *
 *   1. Allowlist gate is FIRST: a non-allowlisted GitHub id (and an
 *      unset/empty/unparseable AUTH_ALLOWLIST) yields NO session AND NO user row
 *      and NO session row (fail-closed; record persistence cannot bypass the gate).
 *   2. An allowlisted id is admitted: the user is upserted (keyed on the numeric
 *      id) and an opaque session is minted storing only the token HASH.
 *   3. Matching keys on the immutable numeric id, NEVER the mutable login: an
 *      identity whose login equals an allowlisted display name but whose id is not
 *      listed is denied.
 *   4. resolveSession rejects an expired session (server-side expiry check).
 *   5. resolveSession RE-CONFIRMS allowlist at resolution time: a now-de-allowlisted
 *      user is denied on their next request even though the session row is valid.
 *   6. resolveSession rejects an unknown/revoked token (no matching hash -> null).
 *   7. revokeSession (logout) deletes the server-side row by token HASH so a
 *      stolen-but-logged-out token can never be replayed (treated unauthenticated).
 *
 * Requires `pnpm --filter @cap/api build` (refreshes dist/) before running.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../../dist/auth');

const { AuthSessionService } = require(path.join(DIST, 'auth-session.service.js'));
const { hashSessionToken } = require(path.join(DIST, 'session-token.js'));

// ---- fake Prisma -----------------------------------------------------------

/**
 * A minimal in-memory Prisma double that records the security-relevant calls so
 * the test can assert "no user row / no session row on deny" and "deleteMany by
 * tokenHash on revoke".
 */
function makePrisma({ findFirstResult = null } = {}) {
  const calls = { upsert: 0, sessionCreate: 0, deleteMany: [] };
  return {
    calls,
    user: {
      upsert: async (args) => {
        calls.upsert += 1;
        return {
          id: 'user-row-1',
          githubId: args.where.githubId,
          login: args.create?.login ?? args.update?.login ?? 'unknown',
          name: 'Name',
          avatarUrl: '',
          allowed: true,
        };
      },
    },
    session: {
      create: async () => {
        calls.sessionCreate += 1;
        return {};
      },
      findFirst: async () => findFirstResult,
      deleteMany: async (args) => {
        calls.deleteMany.push(args);
        return { count: findFirstResult ? 1 : 0 };
      },
    },
  };
}

const githubUser = (id, login = 'op') => ({ id, login, name: 'Operator', avatarUrl: '' });

// ---- harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const run = async () => {
  console.log('\n=== AuthSessionService: allowlist gate + revocable session (real compiled source) ===\n');

  // T1: allowlisted id admitted -> user upserted + session minted, token != hash.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma);
    const res = await svc.establishSessionForGitHubUser(githubUser(12345), 'gh-access-token', {
      AUTH_ALLOWLIST: '12345',
    });
    assert(res !== null, 'T1a: allowlisted id obtains a session');
    assert(prisma.calls.upsert === 1 && prisma.calls.sessionCreate === 1,
      'T1b: admit upserts the user row AND creates the session row');
    assert(res.user.githubId === 12345 && res.user.allowed === true,
      'T1c: session user keyed on numeric id, allowed=true');
    assert(typeof res.token === 'string' && res.token.length >= 40,
      'T1d: high-entropy opaque token returned to caller');
  }

  // T2: non-allowlisted id denied fail-closed -> NO user row, NO session row.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma);
    const res = await svc.establishSessionForGitHubUser(githubUser(999), 'tok', {
      AUTH_ALLOWLIST: '12345,67890',
    });
    assert(res === null, 'T2a: non-allowlisted id denied (null session)');
    assert(prisma.calls.upsert === 0 && prisma.calls.sessionCreate === 0,
      'T2b: denied identity gets NO user row and NO session row (gate is first)');
  }

  // T3: AUTH_ALLOWLIST unset / empty / unparseable denies EVERYONE.
  {
    for (const [label, env] of [
      ['unset', {}],
      ['empty', { AUTH_ALLOWLIST: '' }],
      ['whitespace', { AUTH_ALLOWLIST: '   ' }],
      ['unparseable-login', { AUTH_ALLOWLIST: '12345,tanghehui' }],
    ]) {
      const prisma = makePrisma();
      const svc = new AuthSessionService(prisma);
      const res = await svc.establishSessionForGitHubUser(githubUser(12345), 'tok', env);
      assert(res === null && prisma.calls.upsert === 0 && prisma.calls.sessionCreate === 0,
        `T3 (${label}): denies everyone, no rows written`);
    }
  }

  // T4: match keys on numeric id, NOT mutable login. The impostor's login equals a
  //     listed operator's display name but its numeric id is not on the list.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma);
    const res = await svc.establishSessionForGitHubUser(
      githubUser(424242, 'tanghehui'), // login matches a real operator's display name
      'tok',
      { AUTH_ALLOWLIST: '583231' }, // the real operator's numeric id, NOT the impostor's
    );
    assert(res === null && prisma.calls.upsert === 0,
      'T4: id-not-listed denied even when login matches an allowlisted display name');
  }

  // T5: resolveSession rejects an EXPIRED session even though the hash matches and
  //     the user is still allowlisted.
  {
    const token = 'opaque-session-token-T5';
    const prisma = makePrisma({
      findFirstResult: {
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() - 1000), // already expired
        user: { githubId: 12345, login: 'op', name: 'n', avatarUrl: '' },
      },
    });
    const svc = new AuthSessionService(prisma);
    const user = await svc.resolveSession(token, { AUTH_ALLOWLIST: '12345' });
    assert(user === null, 'T5: expired session rejected (server-side expiry check)');
  }

  // T6: resolveSession RE-CONFIRMS the allowlist — a valid, unexpired session whose
  //     owning user has been DE-ALLOWLISTED is denied on the next request.
  {
    const token = 'opaque-session-token-T6';
    const prisma = makePrisma({
      findFirstResult: {
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(Date.now() + 60_000), // still valid
        user: { githubId: 12345, login: 'op', name: 'n', avatarUrl: '' },
      },
    });
    const svc = new AuthSessionService(prisma);
    // Allowlist no longer contains 12345 -> denied at resolution time.
    const denied = await svc.resolveSession(token, { AUTH_ALLOWLIST: '999' });
    assert(denied === null, 'T6a: de-allowlisted user denied on next request (re-confirm at resolve)');
    // Sanity: the SAME valid session DOES resolve while still allowlisted.
    const ok = await svc.resolveSession(token, { AUTH_ALLOWLIST: '12345' });
    assert(ok !== null && ok.githubId === 12345,
      'T6b: same valid session resolves while still allowlisted');
  }

  // T7: resolveSession rejects an unknown / revoked token (no matching hash).
  {
    const prisma = makePrisma({ findFirstResult: null });
    const svc = new AuthSessionService(prisma);
    const user = await svc.resolveSession('no-such-token', { AUTH_ALLOWLIST: '12345' });
    assert(user === null, 'T7a: unknown/revoked token (no row) -> unauthenticated');
    const empty = await svc.resolveSession('', { AUTH_ALLOWLIST: '12345' });
    const nul = await svc.resolveSession(null, { AUTH_ALLOWLIST: '12345' });
    assert(empty === null && nul === null, 'T7b: empty/null token -> unauthenticated');
  }

  // T8: revokeSession (logout) deletes the server-side row by token HASH, so the
  //     logged-out token can never be replayed.
  {
    const token = 'opaque-session-token-T8';
    const prisma = makePrisma({ findFirstResult: { count: 1 } });
    const svc = new AuthSessionService(prisma);
    await svc.revokeSession(token);
    assert(prisma.calls.deleteMany.length === 1,
      'T8a: logout invalidates server-side (deleteMany called)');
    assert(prisma.calls.deleteMany[0]?.where?.tokenHash === hashSessionToken(token),
      'T8b: revocation targets the stored token HASH, never the raw token');
    // Idempotent: revoking an empty/null token is a no-op (no extra delete).
    await svc.revokeSession('');
    await svc.revokeSession(null);
    assert(prisma.calls.deleteMany.length === 1, 'T8c: revoking empty/null token is a no-op');
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log('ALL TESTS PASSED'); process.exit(0); }
  else { console.error('SOME TESTS FAILED'); process.exit(1); }
};

void run();
