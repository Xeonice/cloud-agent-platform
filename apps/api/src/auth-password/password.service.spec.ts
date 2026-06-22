/**
 * Tests for the email+password auth service (add-private-account-identity,
 * task 4.3; `password-login`).
 *
 * Asserts the load-bearing requirements end-to-end against an in-memory Prisma
 * fake (no DB, no DI) so it runs under `pnpm test` (nest build → node --test
 * dist/**\/*.spec.js). Uses the REAL argon2 util so a stored hash actually
 * verifies on the login path:
 *   1. CORRECT password for an allowed account → mints a session.
 *   2. WRONG password → null (uniform failure, no session).
 *   3. DISALLOWED owner → null even with the right password.
 *   4. UNKNOWN email / no password identity → null (no account auto-created).
 *   5. CHANGE PASSWORD — sets a new hash, clears mustChangePassword, and the OLD
 *      temporary password no longer verifies while the NEW one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../auth/argon2';
import { hashSessionToken } from '../auth/session-token';
import { PasswordAuthService } from './password.service';

const EMAIL = 'admin@local';
const ROW = {
  id: 'user-1',
  githubId: null,
  login: null,
  name: 'Admin',
  avatarUrl: null,
  email: EMAIL,
  role: 'admin' as const,
};

/**
 * In-memory Prisma fake: one user with a `password` identity, plus a session
 * store so the change-password path (session → user) resolves. `allowed` and
 * `mustChangePassword` are mutable so a test can flip them.
 */
function makeFakePrisma(opts: {
  allowed: boolean;
  mustChangePassword: boolean;
  passwordHash: string | null;
}) {
  const state = {
    allowed: opts.allowed,
    mustChangePassword: opts.mustChangePassword,
    secret: opts.passwordHash,
  };
  const sessions: { tokenHash: string; userId: string; expiresAt: Date }[] = [];
  const user = () => ({ ...ROW, allowed: state.allowed, mustChangePassword: state.mustChangePassword });
  const prisma = {
    user: {
      findUnique: async (args: { where: { email?: string } }) =>
        args.where.email === EMAIL ? user() : null,
      update: async (args: { where: { id: string }; data: { mustChangePassword?: boolean } }) => {
        if (args.data.mustChangePassword === false) state.mustChangePassword = false;
        return user();
      },
    },
    identityLink: {
      findFirst: async (args: { where: { userId: string; provider: string } }) =>
        args.where.userId === ROW.id && args.where.provider === 'password' && state.secret
          ? { secret: state.secret }
          : null,
      upsert: async (args: { create: { secret: string }; update: { secret: string } }) => {
        state.secret = args.update.secret;
        return {};
      },
    },
    session: {
      create: async (args: { data: { tokenHash: string; userId: string; expiresAt: Date } }) => {
        sessions.push({ ...args.data });
        return {};
      },
      findFirst: async (args: { where: { tokenHash: string } }) => {
        const s = sessions.find((x) => x.tokenHash === args.where.tokenHash);
        return s ? { ...s, user: user() } : null;
      },
    },
  };
  return { prisma, state, sessions };
}

function serviceOver(prisma: unknown): PasswordAuthService {
  return new PasswordAuthService(prisma as never);
}

test('verifyAndMint: correct password for an allowed account mints a session', async () => {
  const hash = await hashPassword('s3cret-passw0rd');
  const { prisma, sessions } = makeFakePrisma({ allowed: true, mustChangePassword: false, passwordHash: hash });
  const svc = serviceOver(prisma);

  const result = await svc.verifyAndMint(EMAIL, 's3cret-passw0rd');
  assert.ok(result !== null, 'correct password should authenticate');
  assert.equal(result.user.allowed, true);
  assert.ok(result.token.length > 0, 'a session token is minted');
  // The minted session is stored as a HASH, never the raw token.
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tokenHash, hashSessionToken(result.token));
});

test('verifyAndMint: wrong password returns null (no session)', async () => {
  const hash = await hashPassword('s3cret-passw0rd');
  const { prisma, sessions } = makeFakePrisma({ allowed: true, mustChangePassword: false, passwordHash: hash });
  const result = await serviceOver(prisma).verifyAndMint(EMAIL, 'wrong-password');
  assert.equal(result, null, 'a wrong password must not authenticate');
  assert.equal(sessions.length, 0, 'no session is minted on failure');
});

test('verifyAndMint: disallowed owner is denied even with the right password', async () => {
  const hash = await hashPassword('s3cret-passw0rd');
  const { prisma } = makeFakePrisma({ allowed: false, mustChangePassword: false, passwordHash: hash });
  const result = await serviceOver(prisma).verifyAndMint(EMAIL, 's3cret-passw0rd');
  assert.equal(result, null, 'a disallowed account fails closed regardless of password');
});

test('verifyAndMint: unknown email / no password identity returns null', async () => {
  const hash = await hashPassword('s3cret-passw0rd');
  const known = makeFakePrisma({ allowed: true, mustChangePassword: false, passwordHash: hash });
  // Unknown email.
  assert.equal(await serviceOver(known.prisma).verifyAndMint('nobody@x.io', 's3cret-passw0rd'), null);
  // Known email but no password identity.
  const noPw = makeFakePrisma({ allowed: true, mustChangePassword: false, passwordHash: null });
  assert.equal(await serviceOver(noPw.prisma).verifyAndMint(EMAIL, 's3cret-passw0rd'), null);
});

test('changePassword: rotates the hash, clears mustChangePassword, and the old password stops working', async () => {
  const oldHash = await hashPassword('temp-passw0rd');
  const { prisma, state } = makeFakePrisma({ allowed: true, mustChangePassword: true, passwordHash: oldHash });
  const svc = serviceOver(prisma);

  // Log in with the temporary password to mint a session (the change is session-authed).
  const login = await svc.verifyAndMint(EMAIL, 'temp-passw0rd');
  assert.ok(login !== null);
  assert.equal(login.user.mustChangePassword, true, 'the temp account is flagged must-change');

  const changed = await svc.changePassword(login.token, undefined, 'brand-new-passw0rd');
  assert.ok(changed !== null, 'change should succeed for a valid session');
  assert.equal(changed.mustChangePassword, false, 'the flag is cleared');
  assert.equal(state.mustChangePassword, false);

  // The NEW password now verifies; the OLD temp password no longer does.
  assert.ok(await svc.verifyAndMint(EMAIL, 'brand-new-passw0rd'), 'new password works');
  assert.equal(await svc.verifyAndMint(EMAIL, 'temp-passw0rd'), null, 'old temp password is dead');
});

test('changePassword: an absent/invalid session returns null', async () => {
  const hash = await hashPassword('temp-passw0rd');
  const { prisma } = makeFakePrisma({ allowed: true, mustChangePassword: true, passwordHash: hash });
  const result = await serviceOver(prisma).changePassword('not-a-real-token', undefined, 'brand-new-passw0rd');
  assert.equal(result, null, 'no session → no change');
});
