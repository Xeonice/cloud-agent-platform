/**
 * Manual probe for the AuthSessionService composition under the normalized
 * identity model (add-private-account-identity). NOT in the CI gate (the api test
 * runner globs `dist/**\/*.spec.js`); run it ad hoc after a build to exercise the
 * real compiled service against a fake Prisma + explicit env.
 *
 * It drives the REAL compiled service (dist/auth/auth-session.service.js) with a
 * fake Prisma that mirrors the normalized-identity surface the service now calls
 * (`identityLink.findUnique`/`upsert`, `user.findUnique`/`create`/`update`/
 * `findUniqueOrThrow`, `session.*`). The load-bearing properties it asserts:
 *
 *   1. Login-time allowlist gate is FIRST: a non-allowlisted GitHub id (and an
 *      unset/empty/unparseable AUTH_ALLOWLIST) yields NO account row and NO
 *      session row (fail-closed; record persistence cannot bypass the gate).
 *   2. An allowlisted id is admitted: the account is provisioned (create on first
 *      login), the github identity secret is upserted, and an opaque session is
 *      minted storing only the token HASH.
 *   3. Match keys on the immutable numeric id, NEVER the mutable login.
 *   4. resolveSession rejects an expired session (server-side expiry check).
 *   5. resolveSession gates on the pure-DB `User.allowed` flag (D2): a session
 *      whose owner has `allowed=false` is denied on its next request, regardless
 *      of AUTH_ALLOWLIST (the env is login-time provisioning only, not the runtime
 *      gate); the same session resolves while `allowed=true`.
 *   6. resolveSession rejects an unknown/revoked token (no matching hash).
 *   7. revokeSession (logout) deletes the server-side row by token HASH.
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
 * A minimal in-memory Prisma double mirroring the normalized-identity surface.
 * `existingLink` simulates a known github identity (re-login); `emailUser`
 * simulates a verified-email auto-link target; `findFirstResult` is the session
 * row resolveSession/revokeSession read. Records the security-relevant write
 * counts so the test can assert "no rows on deny" and "deleteMany by hash".
 */
function makePrisma({ findFirstResult = null, existingLink = null, emailUser = null } = {}) {
  const calls = { userCreate: 0, userUpdate: 0, sessionCreate: 0, identityUpsert: 0, deleteMany: [] };
  return {
    calls,
    identityLink: {
      findUnique: async () => existingLink,
      upsert: async () => { calls.identityUpsert += 1; return {}; },
    },
    user: {
      findUnique: async () => emailUser, // by email (auto-link probe)
      create: async () => { calls.userCreate += 1; return { id: 'user-row-1' }; },
      update: async (args) => { calls.userUpdate += 1; return { id: args?.where?.id ?? 'user-row-1' }; },
      findUniqueOrThrow: async () => ({ role: 'member', mustChangePassword: false }),
    },
    session: {
      create: async () => { calls.sessionCreate += 1; return {}; },
      findFirst: async () => findFirstResult,
      deleteMany: async (args) => { calls.deleteMany.push(args); return { count: findFirstResult ? 1 : 0 }; },
    },
  };
}

const githubUser = (id, login = 'op') => ({ id, login, name: 'Operator', avatarUrl: '', email: null });

/** A resolved session row whose owner is `allowed`, for resolveSession tests. */
const sessionRow = (token, { expiresAt, allowed }) => ({
  tokenHash: hashSessionToken(token),
  expiresAt,
  user: {
    githubId: 12345,
    login: 'op',
    name: 'n',
    avatarUrl: '',
    allowed,
    role: 'member',
    mustChangePassword: false,
  },
});

// ---- harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else { console.error(`  FAIL  ${label}`); failed++; }
}

const run = async () => {
  console.log('\n=== AuthSessionService: normalized identity + login-time gate + DB-allowed runtime gate ===\n');

  // T1: allowlisted id admitted -> account provisioned + github secret upserted +
  //     session minted, token != hash.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma, null);
    const res = await svc.establishSessionForGitHubUser(githubUser(12345), 'gh-access-token', {
      AUTH_ALLOWLIST: '12345',
    });
    assert(res !== null, 'T1a: allowlisted id obtains a session');
    assert(prisma.calls.userCreate === 1 && prisma.calls.sessionCreate === 1,
      'T1b: admit provisions the account AND creates the session row');
    assert(prisma.calls.identityUpsert === 1,
      'T1c: the github identity secret is upserted on the resolved account');
    assert(res.user.githubId === 12345 && res.user.allowed === true,
      'T1d: session user keyed on numeric id, allowed=true');
    assert(typeof res.token === 'string' && res.token.length >= 40,
      'T1e: high-entropy opaque token returned to caller');
  }

  // T2: non-allowlisted id denied fail-closed -> NO account row, NO session row.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma, null);
    const res = await svc.establishSessionForGitHubUser(githubUser(999), 'tok', {
      AUTH_ALLOWLIST: '12345,67890',
    });
    assert(res === null, 'T2a: non-allowlisted id denied (null session)');
    assert(prisma.calls.userCreate === 0 && prisma.calls.sessionCreate === 0,
      'T2b: denied identity gets NO account row and NO session row (gate is first)');
  }

  // T3: AUTH_ALLOWLIST unset / empty / unparseable denies EVERYONE at login.
  {
    for (const [label, env] of [
      ['unset', {}],
      ['empty', { AUTH_ALLOWLIST: '' }],
      ['whitespace', { AUTH_ALLOWLIST: '   ' }],
      ['unparseable-login', { AUTH_ALLOWLIST: '12345,tanghehui' }],
    ]) {
      const prisma = makePrisma();
      const svc = new AuthSessionService(prisma, null);
      const res = await svc.establishSessionForGitHubUser(githubUser(12345), 'tok', env);
      assert(res === null && prisma.calls.userCreate === 0 && prisma.calls.sessionCreate === 0,
        `T3 (${label}): denies everyone, no rows written`);
    }
  }

  // T4: match keys on numeric id, NOT mutable login.
  {
    const prisma = makePrisma();
    const svc = new AuthSessionService(prisma, null);
    const res = await svc.establishSessionForGitHubUser(
      githubUser(424242, 'tanghehui'),
      'tok',
      { AUTH_ALLOWLIST: '583231' },
    );
    assert(res === null && prisma.calls.userCreate === 0,
      'T4: id-not-listed denied even when login matches an allowlisted display name');
  }

  // T5: resolveSession rejects an EXPIRED session even though the hash matches and
  //     the owner is allowed.
  {
    const token = 'opaque-session-token-T5';
    const prisma = makePrisma({
      findFirstResult: sessionRow(token, { expiresAt: new Date(Date.now() - 1000), allowed: true }),
    });
    const svc = new AuthSessionService(prisma, null);
    const user = await svc.resolveSession(token);
    assert(user === null, 'T5: expired session rejected (server-side expiry check)');
  }

  // T6: resolveSession gates on the pure-DB `User.allowed` flag (D2). The env
  //     allowlist is login-time provisioning only and is NOT re-checked here.
  {
    const token = 'opaque-session-token-T6';
    // 6a: owner disabled in DB -> denied even with a valid, unexpired session.
    const disabled = makePrisma({
      findFirstResult: sessionRow(token, { expiresAt: new Date(Date.now() + 60_000), allowed: false }),
    });
    const denied = await new AuthSessionService(disabled, null).resolveSession(token, { AUTH_ALLOWLIST: '12345' });
    assert(denied === null, 'T6a: owner allowed=false denied on next request (DB gate)');
    // 6b: same valid session resolves while the owner is allowed — even with an
    //     EMPTY AUTH_ALLOWLIST, proving the env is not the runtime gate.
    const okPrisma = makePrisma({
      findFirstResult: sessionRow(token, { expiresAt: new Date(Date.now() + 60_000), allowed: true }),
    });
    const ok = await new AuthSessionService(okPrisma, null).resolveSession(token, { AUTH_ALLOWLIST: '' });
    assert(ok !== null && ok.githubId === 12345,
      'T6b: allowed owner resolves regardless of AUTH_ALLOWLIST (env is not the runtime gate)');
  }

  // T7: resolveSession rejects an unknown / revoked token (no matching hash).
  {
    const prisma = makePrisma({ findFirstResult: null });
    const svc = new AuthSessionService(prisma, null);
    const user = await svc.resolveSession('no-such-token');
    assert(user === null, 'T7a: unknown/revoked token (no row) -> unauthenticated');
    const empty = await svc.resolveSession('');
    const nul = await svc.resolveSession(null);
    assert(empty === null && nul === null, 'T7b: empty/null token -> unauthenticated');
  }

  // T8: revokeSession (logout) deletes the server-side row by token HASH.
  {
    const token = 'opaque-session-token-T8';
    const prisma = makePrisma({ findFirstResult: { count: 1 } });
    const svc = new AuthSessionService(prisma, null);
    await svc.revokeSession(token);
    assert(prisma.calls.deleteMany.length === 1,
      'T8a: logout invalidates server-side (deleteMany called)');
    assert(prisma.calls.deleteMany[0]?.where?.tokenHash === hashSessionToken(token),
      'T8b: revocation targets the stored token HASH, never the raw token');
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
