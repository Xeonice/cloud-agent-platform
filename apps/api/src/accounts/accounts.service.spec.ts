/**
 * Tests for the admin-only account-administration surface (account-administration,
 * task 7.3).
 *
 * Asserts the load-bearing requirements of tracks 7.1 / 7.2:
 *   1. ADMIN CRUD — an admin creates a local password account (allowed=true,
 *      mustChangePassword=true, a `password` identity holding the argon2 hash) and
 *      an OTP-only account (no password identity), lists local accounts,
 *      resets a local password, assigns roles.
 *   2. NON-ADMIN 403 — a `member` (and any scopeless / no-user principal) is 403'd
 *      at the controller BEFORE any service method runs; no write happens.
 *   3. DISABLE -> REVOKE — disabling flips `User.allowed` to false (the single
 *      runtime gate that denies the account's next request), and re-enabling
 *      restores it.
 *   4. LEGACY-ACCOUNT DISABLE PATH — a legacy linked account is disable-able (the
 *      pure-DB revocation path) WITHOUT touching its identity secret, while
 *      password reset on an account without a password identity is rejected.
 *   5. NO PLAINTEXT / NO SECRET LEAK — the plaintext password is never stored and
 *      never appears in a response; identity secrets are never projected.
 *
 * Exercises {@link AccountsService} with a fake Prisma and {@link AccountsController}
 * with synthesized principals — no DB, no DI container — so it runs under
 * `pnpm test` (nest build -> node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, BadRequestException } from '@nestjs/common';

import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

// ---------------------------------------------------------------------------
// In-memory fake Prisma (user + identityLink delegates, incl. nested create)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string | null;
  name: string;
  role: string;
  allowed: boolean;
  mustChangePassword: boolean;
  githubId: number | null;
  createdAt: Date;
}

interface IdentityRow {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  secret: string | null;
}

interface FakeDb {
  prisma: PrismaService;
  users: UserRow[];
  identities: IdentityRow[];
  seedUser: (row: Partial<UserRow> & { id: string }) => UserRow;
  seedIdentity: (row: Partial<IdentityRow> & { id: string; userId: string }) => IdentityRow;
}

function makeFakePrisma(): FakeDb {
  const users: UserRow[] = [];
  const identities: IdentityRow[] = [];
  let seq = 0;

  const identitiesFor = (userId: string) =>
    identities
      .filter((i) => i.userId === userId)
      .map((i) => ({
        id: i.id,
        provider: i.provider,
        providerAccountId: i.providerAccountId,
        secret: i.secret,
      }));

  const withIncludes = (row: UserRow) => ({ ...row, identities: identitiesFor(row.id) });

  const prisma = {
    user: {
      findUnique: async ({
        where,
        select,
      }: {
        where: { id?: string; email?: string; githubId?: number };
        select?: Record<string, boolean>;
      }) => {
        const row = users.find(
          (u) =>
            (where.id !== undefined && u.id === where.id) ||
            (where.email !== undefined && u.email === where.email) ||
            (where.githubId !== undefined && u.githubId === where.githubId),
        );
        if (!row) return null;
        if (select) return row; // callers read only the selected scalar fields
        return withIncludes(row);
      },
      findMany: async () =>
        [...users]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((u) => withIncludes(u)),
      create: async ({
        data,
      }: {
        data: {
          email: string;
          name: string;
          role: string;
          allowed: boolean;
          mustChangePassword: boolean;
          identities?: {
            create: Array<{ provider: string; providerAccountId: string; secret: string }>;
          };
        };
      }) => {
        seq += 1;
        const row: UserRow = {
          id: `user-${seq}`,
          email: data.email,
          name: data.name,
          role: data.role,
          allowed: data.allowed,
          mustChangePassword: data.mustChangePassword,
          githubId: null,
          createdAt: new Date(Date.now() + seq),
        };
        users.push(row);
        for (const c of data.identities?.create ?? []) {
          seq += 1;
          identities.push({
            id: `id-${seq}`,
            userId: row.id,
            provider: c.provider,
            providerAccountId: c.providerAccountId,
            secret: c.secret,
          });
        }
        return withIncludes(row);
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }) => {
        const row = users.find((u) => u.id === where.id);
        if (!row) throw new Error('no such user');
        Object.assign(row, data);
        return withIncludes(row);
      },
    },
    identityLink: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<IdentityRow>;
      }) => {
        const row = identities.find((i) => i.id === where.id);
        if (!row) throw new Error('no such identity');
        Object.assign(row, data);
        return row;
      },
    },
  } as unknown as PrismaService;

  return {
    prisma,
    users,
    identities,
    seedUser: (row) => {
      const full: UserRow = {
        id: row.id,
        email: row.email ?? null,
        name: row.name ?? 'Seed',
        role: row.role ?? 'member',
        allowed: row.allowed ?? true,
        mustChangePassword: row.mustChangePassword ?? false,
        githubId: row.githubId ?? null,
        createdAt: row.createdAt ?? new Date(),
      };
      users.push(full);
      return full;
    },
    seedIdentity: (row) => {
      const full: IdentityRow = {
        id: row.id,
        userId: row.userId,
        provider: row.provider ?? 'github',
        providerAccountId: row.providerAccountId ?? '999',
        secret: row.secret ?? null,
      };
      identities.push(full);
      return full;
    },
  };
}

// ---------------------------------------------------------------------------
// Principal helpers
// ---------------------------------------------------------------------------

function principalRequest(principal: OperatorPrincipal | undefined): AuthenticatedRequest {
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

/** A `session` principal whose resolved user carries the internal id (admin gate key). */
function sessionPrincipal(userId: string): OperatorPrincipal {
  return {
    kind: 'session',
    user: {
      id: userId,
      githubId: 0,
      login: 'admin',
      name: 'Admin',
      avatarUrl: '',
      allowed: true,
    },
  } as unknown as OperatorPrincipal;
}

// ---------------------------------------------------------------------------
// 7.3 — admin CRUD
// ---------------------------------------------------------------------------

test('admin creates a local password account: allowed + mustChangePassword + hashed identity', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);

  const created = await service.create({
    email: 'Alice@Example.com',
    name: 'Alice',
    role: 'member',
    initialCredential: 'password',
    password: 'sup3r-secret',
  });

  assert.equal(created.allowed, true, 'created account is allowed');
  assert.equal(created.email, 'alice@example.com', 'email is normalized lowercase');
  assert.deepEqual(created.loginMethods, ['password', 'otp'], 'password + otp methods');
  assert.equal(created.isGithubLinked, false);

  const row = db.users.find((u) => u.email === 'alice@example.com');
  assert.ok(row, 'user row persisted');
  assert.equal(row.mustChangePassword, true, 'admin-set password forces a change on first login');

  const identity = db.identities.find((i) => i.userId === row.id && i.provider === 'password');
  assert.ok(identity, 'a password identity is created');
  assert.equal(identity.providerAccountId, 'alice@example.com', 'identity is keyed on the email');
  assert.ok(identity.secret, 'the identity carries a stored secret');
  assert.notEqual(identity.secret, 'sup3r-secret', 'the plaintext password is NEVER stored');

  // The plaintext never appears in the response, and the secret is never projected.
  const serialized = JSON.stringify(created);
  assert.ok(!serialized.includes('sup3r-secret'), 'plaintext absent from response');
  assert.ok(!serialized.includes(identity.secret as string), 'identity secret absent from response');
});

test('admin creates a verification-code-only account: no password identity', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);

  const created = await service.create({
    email: 'bob@example.com',
    name: 'Bob',
    role: 'member',
    initialCredential: 'otp-only',
  });

  assert.equal(created.allowed, true);
  assert.deepEqual(created.loginMethods, ['otp'], 'an OTP-only account exposes only the otp method');

  const row = db.users.find((u) => u.email === 'bob@example.com');
  assert.ok(row);
  assert.equal(row.mustChangePassword, false, 'no password => no forced change');
  assert.equal(
    db.identities.filter((i) => i.userId === row.id).length,
    0,
    'no identity row is created for an OTP-only account',
  );
});

test('duplicate email is rejected (no public registration / no silent merge)', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  await service.create({
    email: 'dup@example.com',
    name: 'First',
    role: 'member',
    initialCredential: 'otp-only',
  });

  await assert.rejects(
    () =>
      service.create({
        email: 'dup@example.com',
        name: 'Second',
        role: 'member',
        initialCredential: 'otp-only',
      }),
    /already exists/,
  );
  assert.equal(db.users.length, 1, 'no duplicate account created');
});

test('admin lists local + legacy linked accounts with identity, role, methods, enabled', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);

  // A legacy linked account (no email captured) + a local password account.
  const gh = db.seedUser({ id: 'gh-1', email: null, name: 'Octo', role: 'member', allowed: true });
  db.seedIdentity({ id: 'gh-id', userId: gh.id, provider: 'github', providerAccountId: '12345', secret: 'enc-token' });
  await service.create({
    email: 'local@example.com',
    name: 'Local',
    role: 'admin',
    initialCredential: 'password',
    password: 'pw-pw-pw-pw',
  });

  const list = await service.list();
  assert.equal(list.length, 2);

  const ghRow = list.find((a) => a.id === 'gh-1');
  assert.ok(ghRow);
  assert.equal(ghRow.isGithubLinked, true);
  assert.equal(ghRow.identity, '12345', 'legacy row identity falls back to its provider handle');
  assert.deepEqual(ghRow.loginMethods, [], 'legacy github identity is not a login method');

  const localRow = list.find((a) => a.email === 'local@example.com');
  assert.ok(localRow);
  assert.equal(localRow.role, 'admin');
  assert.deepEqual(localRow.loginMethods, ['password', 'otp']);

  // No identity secret leaks anywhere in the list response.
  assert.ok(!JSON.stringify(list).includes('enc-token'), 'legacy token secret absent from list');
});

test('admin resets a local password (re-flags mustChangePassword, rotates the hash)', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  const created = await service.create({
    email: 'reset@example.com',
    name: 'R',
    role: 'member',
    initialCredential: 'password',
    password: 'old-password',
  });
  // Simulate the owner having changed their password (clears the flag).
  db.users.find((u) => u.id === created.id)!.mustChangePassword = false;
  const identityId = db.identities.find((i) => i.userId === created.id)!.id;
  // Tamper the stored secret to a sentinel so we can prove the reset rewrites it
  // (independent of the hash function's salting, which a real argon2 would add).
  db.identities.find((i) => i.id === identityId)!.secret = '__SENTINEL__';

  const newPassword = 'a-much-longer-brand-new-password';
  const after = await service.resetPassword(created.id, newPassword);
  assert.equal(after.email, 'reset@example.com');

  const row = db.users.find((u) => u.id === created.id)!;
  assert.equal(row.mustChangePassword, true, 'reset re-forces a change on next login');
  const newSecret = db.identities.find((i) => i.id === identityId)!.secret;
  assert.notEqual(newSecret, '__SENTINEL__', 'the stored hash is rotated (secret rewritten)');
  assert.notEqual(newSecret, newPassword, 'the plaintext is NEVER stored');
});

test('admin assigns a role', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  const created = await service.create({
    email: 'role@example.com',
    name: 'X',
    role: 'member',
    initialCredential: 'otp-only',
  });

  const promoted = await service.assignRole(created.id, 'admin');
  assert.equal(promoted.role, 'admin');
  assert.equal(db.users.find((u) => u.id === created.id)!.role, 'admin');
});

// ---------------------------------------------------------------------------
// 7.3 — disable -> revoke (next request denied) + re-enable
// ---------------------------------------------------------------------------

test('disabling flips User.allowed false (revokes next request); re-enabling restores it', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  const created = await service.create({
    email: 'toggle@example.com',
    name: 'T',
    role: 'member',
    initialCredential: 'otp-only',
  });

  const disabled = await service.setEnabled(created.id, false);
  assert.equal(disabled.allowed, false, 'disabled account is not allowed');
  assert.equal(
    db.users.find((u) => u.id === created.id)!.allowed,
    false,
    'the single runtime gate User.allowed is now false (next request denied)',
  );

  const reenabled = await service.setEnabled(created.id, true);
  assert.equal(reenabled.allowed, true, 're-enabling restores access');
});

test('unknown account id is a 404 on management ops', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  await assert.rejects(() => service.setEnabled('nope', false), /No account/);
  await assert.rejects(() => service.resetPassword('nope', 'whatever-pw'), /No account/);
  await assert.rejects(() => service.assignRole('nope', 'admin'), /No account/);
});

// ---------------------------------------------------------------------------
// 7.3 — legacy-account disable path (and no password reset)
// ---------------------------------------------------------------------------

test('a legacy linked account is disable-able without touching its identity secret', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  const gh = db.seedUser({ id: 'gh-9', email: null, name: 'Octo', role: 'member', allowed: true });
  db.seedIdentity({
    id: 'gh-id-9',
    userId: gh.id,
    provider: 'github',
    providerAccountId: '777',
    secret: 'encrypted-github-token',
  });

  const disabled = await service.setEnabled(gh.id, false);
  assert.equal(disabled.allowed, false, 'legacy account is revoked via User.allowed');
  assert.equal(disabled.isGithubLinked, true);
  assert.equal(
    db.identities.find((i) => i.id === 'gh-id-9')!.secret,
    'encrypted-github-token',
    'the legacy identity secret is left untouched',
  );
});

test('password reset is rejected for an account with no password identity', async () => {
  const db = makeFakePrisma();
  const service = new AccountsService(db.prisma);
  const gh = db.seedUser({ id: 'gh-8', email: null, name: 'Octo', role: 'member', allowed: true });
  db.seedIdentity({ id: 'gh-id-8', userId: gh.id, provider: 'github', providerAccountId: '888', secret: 'tok' });

  await assert.rejects(
    () => service.resetPassword(gh.id, 'cannot-set-this'),
    BadRequestException,
    'accounts without password identity have no password to reset',
  );
});

// ---------------------------------------------------------------------------
// 7.3 — non-admin 403 (controller gate, before any service write)
// ---------------------------------------------------------------------------

test('a member principal is 403 on every management op and writes nothing', async () => {
  const db = makeFakePrisma();
  const controller = new AccountsController(new AccountsService(db.prisma), db.prisma);

  // The principal resolves to a member account.
  db.seedUser({ id: 'member-1', email: 'm@example.com', name: 'Member', role: 'member', allowed: true });
  const req = principalRequest(sessionPrincipal('member-1'));

  await assert.rejects(
    () =>
      controller.create(req, {
        email: 'evil@example.com',
        name: 'Evil',
        role: 'admin',
        initialCredential: 'otp-only',
      }),
    ForbiddenException,
  );
  await assert.rejects(() => controller.list(req), ForbiddenException);
  await assert.rejects(() => controller.setEnabled(req, 'member-1', { allowed: false }), ForbiddenException);
  await assert.rejects(() => controller.assignRole(req, 'member-1', { role: 'admin' }), ForbiddenException);

  assert.equal(db.users.length, 1, 'no account created by the rejected member');
  assert.equal(db.users[0].role, 'member', 'no self-promotion happened');
  assert.equal(db.users[0].allowed, true, 'no self-disable happened');
});

test('a no-user / scopeless principal (legacy, missing) is 403 on management', async () => {
  const db = makeFakePrisma();
  const controller = new AccountsController(new AccountsService(db.prisma), db.prisma);

  const legacy: OperatorPrincipal = { kind: 'legacy-token', user: null };
  for (const principal of [legacy, undefined]) {
    const req = principalRequest(principal);
    await assert.rejects(() => controller.list(req), ForbiddenException);
  }
});

test('an admin principal reaches the service and gets a working surface', async () => {
  const db = makeFakePrisma();
  const controller = new AccountsController(new AccountsService(db.prisma), db.prisma);
  db.seedUser({ id: 'admin-1', email: 'a@example.com', name: 'Admin', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-1'));

  const created = await controller.create(req, {
    email: 'new@example.com',
    name: 'New',
    role: 'member',
    initialCredential: 'password',
    password: 'temp-pass-1',
  });
  assert.equal(created.allowed, true);

  const list = await controller.list(req);
  assert.equal(list.accounts.length, 2, 'admin + the new account');

  const disabled = await controller.setEnabled(req, created.id, { allowed: false });
  assert.equal(disabled.allowed, false);
});

test('a disabled admin loses panel access on the next request (fail-closed re-check)', async () => {
  const db = makeFakePrisma();
  const controller = new AccountsController(new AccountsService(db.prisma), db.prisma);
  const admin = db.seedUser({ id: 'admin-2', email: 'a2@example.com', name: 'A2', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-2'));

  // Live row is disabled after the session was minted; the next request must fail.
  admin.allowed = false;
  await assert.rejects(() => controller.list(req), ForbiddenException);
});
