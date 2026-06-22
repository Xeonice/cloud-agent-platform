/**
 * Tests for the default-admin bootstrap (add-private-account-identity, track
 * admin-bootstrap, task 6.4; spec `default-admin-bootstrap`).
 *
 * Covers the four load-bearing behaviours:
 *   1. IDEMPOTENT RESEED — a fresh DB gets exactly one admin (role=admin,
 *      allowed=true, mustChangePassword=true) with a `password` identity; a
 *      re-boot after the reveal was consumed leaves it intact (no duplicate, no
 *      reset).
 *   2. REVEAL-ONCE — the one-time reveal returns `{email, password}` exactly
 *      once, stamps `SystemSettings.adminRevealConsumedAt`, clears the in-memory
 *      plaintext, and yields `{}` on every later call.
 *   3. NO PLAINTEXT PERSISTED — only the argon2 hash is stored; the generated
 *      plaintext appears in NO persisted column (users / identities / settings).
 *   4. RESTART REGENERATES — a fresh process (new holder) over a DB whose reveal
 *      was never consumed regenerates a new password (the DB held no plaintext to
 *      re-serve); a restart AFTER the reveal was consumed leaves the admin intact.
 *
 * Exercises {@link AdminSeedService} + {@link AdminRevealController} with a fake
 * Prisma and a fake (non-reversible) hasher — no DB, no DI container — so it runs
 * under `pnpm test` (nest build → node --test dist/**\/*.spec.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  AdminRevealHolder,
  AdminSeedService,
  generateStrongPassword,
  type PasswordHasher,
} from './admin-seed.service';
import { AdminRevealController } from './admin-reveal.controller';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const ADMIN_EMAIL = 'admin@example.test';

interface UserRow {
  id: string;
  email: string | null;
  name: string;
  role: string;
  allowed: boolean;
  mustChangePassword: boolean;
}

interface IdentityRow {
  id: string;
  userId: string;
  provider: string;
  providerAccountId: string;
  secret: string | null;
}

interface SettingsRow {
  id: string;
  maxConcurrentTasks: number;
  adminRevealConsumedAt: Date | null;
}

interface FakeDb {
  users: UserRow[];
  identities: IdentityRow[];
  settings: SettingsRow[];
}

/**
 * Minimal in-memory fake Prisma covering the delegates the seed + reveal touch:
 * `user.findUnique/create/update`, `identityLink.upsert`,
 * `systemSettings.findUnique/upsert/updateMany`. A single backing store is shared
 * across "restart" re-constructions to model process restarts over the same DB.
 */
function makeFakePrisma(db: FakeDb): PrismaService {
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  return {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        const row =
          where.id !== undefined
            ? db.users.find((u) => u.id === where.id)
            : db.users.find((u) => u.email === where.email);
        return row ?? null;
      },
      create: async ({
        data,
      }: {
        data: {
          email: string;
          name: string;
          role: string;
          allowed: boolean;
          mustChangePassword: boolean;
          identities?: { create: Array<Omit<IdentityRow, 'id' | 'userId'>> };
        };
      }) => {
        const user: UserRow = {
          id: nextId('user'),
          email: data.email,
          name: data.name,
          role: data.role,
          allowed: data.allowed,
          mustChangePassword: data.mustChangePassword,
        };
        db.users.push(user);
        for (const ident of data.identities?.create ?? []) {
          db.identities.push({ id: nextId('ident'), userId: user.id, ...ident });
        }
        return user;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<UserRow>;
      }) => {
        const row = db.users.find((u) => u.id === where.id);
        if (!row) throw new Error('no such user');
        Object.assign(row, data);
        return row;
      },
    },
    identityLink: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
        create: Omit<IdentityRow, 'id'>;
        update: Partial<IdentityRow>;
      }) => {
        const key = where.provider_providerAccountId;
        const existing = db.identities.find(
          (i) => i.provider === key.provider && i.providerAccountId === key.providerAccountId,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: IdentityRow = { id: nextId('ident'), ...create };
        db.identities.push(row);
        return row;
      },
    },
    systemSettings: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.settings.find((s) => s.id === where.id) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { id: string; maxConcurrentTasks: number };
        update: Partial<SettingsRow>;
      }) => {
        const existing = db.settings.find((s) => s.id === where.id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: SettingsRow = {
          id: create.id,
          maxConcurrentTasks: create.maxConcurrentTasks,
          adminRevealConsumedAt: null,
        };
        db.settings.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; adminRevealConsumedAt: null };
        data: { adminRevealConsumedAt: Date };
      }) => {
        const matched = db.settings.filter(
          (s) => s.id === where.id && s.adminRevealConsumedAt === null,
        );
        for (const row of matched) row.adminRevealConsumedAt = data.adminRevealConsumedAt;
        return { count: matched.length };
      },
    },
  } as unknown as PrismaService;
}

/**
 * Non-reversible fake hasher: the produced hash is a SHA-256 digest that does NOT
 * contain the plaintext, so the "no plaintext persisted" assertion is meaningful
 * (a hasher that echoed the plaintext would make that test vacuous).
 */
const fakeHasher: PasswordHasher = {
  hash: async (plaintext: string) =>
    'argon2id$' + createHash('sha256').update(plaintext, 'utf8').digest('hex'),
};

function freshDb(): FakeDb {
  return { users: [], identities: [], settings: [] };
}

function withAdminEnv<T>(
  env: { email?: string | null; password?: string | null },
  fn: () => T,
): T {
  const prevEmail = process.env.ADMIN_EMAIL;
  const prevPassword = process.env.ADMIN_PASSWORD;
  if (env.email === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = env.email ?? '';
  if (env.password === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = env.password ?? '';
  try {
    return fn();
  } finally {
    if (prevEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevPassword;
  }
}

/** Assert a plaintext appears in NO persisted column of the fake DB. */
function assertPlaintextAbsent(db: FakeDb, plaintext: string): void {
  const serialized = JSON.stringify(db);
  assert.ok(
    !serialized.includes(plaintext),
    'generated plaintext must never appear in any persisted row',
  );
}

// ---------------------------------------------------------------------------
// 6.1 — fresh deploy gets a usable admin
// ---------------------------------------------------------------------------

test('fresh deploy seeds an admin (role=admin, allowed, mustChangePassword) with a password identity', async () => {
  const db = freshDb();
  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));

  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.seedAdmin());

  assert.equal(db.users.length, 1, 'exactly one admin created');
  const admin = db.users[0];
  assert.equal(admin.email, ADMIN_EMAIL);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.allowed, true);
  assert.equal(admin.mustChangePassword, true, 'seeded admin is flagged mustChangePassword');

  assert.equal(db.identities.length, 1, 'one password identity created');
  const ident = db.identities[0];
  assert.equal(ident.provider, 'password');
  assert.equal(ident.providerAccountId, ADMIN_EMAIL, 'password identity keyed by email');
  assert.ok(ident.secret && ident.secret.length > 0, 'identity secret is the (hashed) password');

  // The plaintext is held in memory for the one-time reveal.
  const held = holder.peek();
  assert.ok(held, 'generated plaintext held in memory');
  assert.equal(held!.email, ADMIN_EMAIL);
  assert.equal(ident.secret, await fakeHasher.hash(held!.password), 'stored secret is the HASH of the held plaintext');
  assertPlaintextAbsent(db, held!.password);
});

// ---------------------------------------------------------------------------
// Role promotion — an existing ADMIN_EMAIL account is ensured to be admin
// ---------------------------------------------------------------------------

test('an existing non-admin ADMIN_EMAIL account is promoted to admin (role only, no reset)', async () => {
  const db = freshDb();
  // Pre-existing account keyed by ADMIN_EMAIL (e.g. created via GitHub OAuth → member),
  // with its own customized password identity, enabled, and NOT must-change.
  db.users.push({
    id: 'u-existing',
    email: ADMIN_EMAIL,
    name: 'Existing Owner',
    role: 'member',
    allowed: true,
    mustChangePassword: false,
  });
  db.identities.push({
    id: 'i-existing',
    userId: 'u-existing',
    provider: 'password',
    providerAccountId: ADMIN_EMAIL,
    secret: 'argon2id$preexisting-secret',
  });
  // Reveal already consumed → the generated-password regen branch is skipped, proving
  // the promotion is independent of the password lifecycle.
  db.settings.push({ id: 'system', maxConcurrentTasks: 5, adminRevealConsumedAt: new Date() });

  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.seedAdmin());

  assert.equal(db.users.length, 1, 'no duplicate account created');
  const acct = db.users[0];
  assert.equal(acct.role, 'admin', 'the member ADMIN_EMAIL account is promoted to admin');
  // Promotion touches ONLY role.
  assert.equal(acct.allowed, true, 'allowed left unchanged');
  assert.equal(acct.mustChangePassword, false, 'mustChangePassword NOT reset');
  assert.equal(
    db.identities[0].secret,
    'argon2id$preexisting-secret',
    'password identity NOT reset',
  );
  assert.equal(holder.peek(), null, 'no new password generated or held');
});

test('an already-admin ADMIN_EMAIL account triggers no role write (idempotent)', async () => {
  const db = freshDb();
  db.users.push({
    id: 'u-admin',
    email: ADMIN_EMAIL,
    name: 'Admin',
    role: 'admin',
    allowed: true,
    mustChangePassword: false,
  });
  db.settings.push({ id: 'system', maxConcurrentTasks: 5, adminRevealConsumedAt: new Date() });

  const prisma = makeFakePrisma(db);
  // Spy on user.update to prove the already-admin path issues no write.
  let userUpdates = 0;
  const u = prisma.user as unknown as { update: (a: unknown) => Promise<unknown> };
  const realUpdate = u.update.bind(u);
  u.update = async (a: unknown) => {
    userUpdates += 1;
    return realUpdate(a);
  };

  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, prisma);
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.seedAdmin());

  assert.equal(db.users[0].role, 'admin', 'role stays admin');
  assert.equal(userUpdates, 0, 'no user.update issued for an already-admin account');
});

// ---------------------------------------------------------------------------
// 6.4 — idempotent reseed (after the reveal is consumed)
// ---------------------------------------------------------------------------

test('re-boot after the reveal is consumed leaves the admin intact (no duplicate, no reset)', async () => {
  const db = freshDb();

  // First boot + consume the reveal.
  const holder1 = new AdminRevealHolder();
  const service1 = new AdminSeedService(holder1, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service1.seedAdmin());
  const controller1 = new AdminRevealController(makeFakePrisma(db), holder1);
  await controller1.reveal();

  // Operator customizes the admin password after first login.
  db.identities[0].secret = 'argon2id$customized-by-operator';
  const customizedSecret = db.identities[0].secret;
  const adminId = db.users[0].id;

  // Re-boot: a fresh process over the same DB.
  const holder2 = new AdminRevealHolder();
  const service2 = new AdminSeedService(holder2, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service2.seedAdmin());

  assert.equal(db.users.length, 1, 'no duplicate admin on re-boot');
  assert.equal(db.users[0].id, adminId, 'same admin row');
  assert.equal(db.identities.length, 1, 'no duplicate identity');
  assert.equal(db.identities[0].secret, customizedSecret, 'customized password left intact');
  assert.equal(holder2.peek(), null, 'no new plaintext held when reveal already consumed');
});

// ---------------------------------------------------------------------------
// 6.4 — reveal-once
// ---------------------------------------------------------------------------

test('the one-time reveal returns the credential once, then nothing', async () => {
  const db = freshDb();
  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.seedAdmin());
  const generated = holder.peek()!.password;

  const controller = new AdminRevealController(makeFakePrisma(db), holder);

  const first = (await controller.reveal()) as { email?: string; password?: string };
  assert.equal(first.email, ADMIN_EMAIL, 'first reveal returns the admin email');
  assert.equal(first.password, generated, 'first reveal returns the generated password');

  // The persisted single-use flag is now stamped, and the in-memory plaintext gone.
  const settings = db.settings.find((s) => s.id === 'system');
  assert.ok(settings?.adminRevealConsumedAt instanceof Date, 'adminRevealConsumedAt stamped');
  assert.equal(holder.peek(), null, 'in-memory plaintext cleared after consume');

  const second = await controller.reveal();
  assert.deepEqual(second, {}, 'a second reveal returns nothing');
});

test('reveal yields nothing when nothing was generated (fixed ADMIN_PASSWORD)', async () => {
  const db = freshDb();
  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL, password: 'fixed-operator-password' }, () =>
    service.seedAdmin(),
  );

  // Fixed password ⇒ nothing held; the stored secret is the hash, not plaintext.
  assert.equal(holder.peek(), null, 'no plaintext held for a fixed password');
  assert.equal(
    db.identities[0].secret,
    await fakeHasher.hash('fixed-operator-password'),
    'stored secret is the hash of the fixed password',
  );
  assertPlaintextAbsent(db, 'fixed-operator-password');

  const controller = new AdminRevealController(makeFakePrisma(db), holder);
  assert.deepEqual(await controller.reveal(), {}, 'reveal returns nothing for a fixed password');
});

// ---------------------------------------------------------------------------
// 6.4 — no plaintext persisted
// ---------------------------------------------------------------------------

test('only the argon2 hash is stored — the generated plaintext is never persisted', async () => {
  const db = freshDb();
  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.seedAdmin());

  const plaintext = holder.peek()!.password;
  assertPlaintextAbsent(db, plaintext);

  // Even after the reveal is consumed, the DB still holds no plaintext.
  const controller = new AdminRevealController(makeFakePrisma(db), holder);
  await controller.reveal();
  assertPlaintextAbsent(db, plaintext);
});

// ---------------------------------------------------------------------------
// 6.4 — restart regenerates (only while the reveal is unconsumed)
// ---------------------------------------------------------------------------

test('restart before the reveal is consumed regenerates the password (DB held no plaintext)', async () => {
  const db = freshDb();

  const holder1 = new AdminRevealHolder();
  const service1 = new AdminSeedService(holder1, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service1.seedAdmin());
  const firstPassword = holder1.peek()!.password;
  const firstSecret = db.identities[0].secret;

  // Simulate a restart BEFORE the reveal: a brand-new holder over the same DB.
  const holder2 = new AdminRevealHolder();
  const service2 = new AdminSeedService(holder2, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service2.seedAdmin());

  assert.equal(db.users.length, 1, 'no duplicate admin on restart');
  const secondPassword = holder2.peek()!.password;
  assert.notEqual(secondPassword, firstPassword, 'a new password is generated on restart');
  assert.notEqual(db.identities[0].secret, firstSecret, 'the stored hash is updated to the new password');
  assert.equal(
    db.identities[0].secret,
    await fakeHasher.hash(secondPassword),
    'stored secret is the hash of the regenerated password',
  );
  assert.equal(db.users[0].mustChangePassword, true, 'regenerated credential re-asserts mustChangePassword');
  assertPlaintextAbsent(db, secondPassword);
});

// ---------------------------------------------------------------------------
// helpers under test
// ---------------------------------------------------------------------------

test('generateStrongPassword yields distinct, sufficiently-long, unambiguous passwords', () => {
  const a = generateStrongPassword();
  const b = generateStrongPassword();
  assert.notEqual(a, b, 'two generations differ (fresh entropy)');
  assert.ok(a.length >= 20, 'password is at least 20 chars');
  assert.ok(/^[a-zA-Z2-9]+$/.test(a), 'uses the unambiguous alphanumeric alphabet');
  assert.ok(!/[0O1lI]/.test(a), 'excludes ambiguous characters');
});

// ---------------------------------------------------------------------------
// seed guards
// ---------------------------------------------------------------------------

test('seed is a no-op when ADMIN_EMAIL is unset', async () => {
  const db = freshDb();
  const holder = new AdminRevealHolder();
  const service = new AdminSeedService(holder, fakeHasher, makeFakePrisma(db));
  await withAdminEnv({ email: undefined }, () => service.seedAdmin());
  assert.equal(db.users.length, 0, 'no admin provisioned without ADMIN_EMAIL');
  assert.equal(holder.peek(), null);
});

test('boot hook never throws even if the seed write fails', async () => {
  const holder = new AdminRevealHolder();
  const exploding = {
    user: {
      findUnique: async () => {
        throw new Error('db down');
      },
    },
  } as unknown as PrismaService;
  const service = new AdminSeedService(holder, fakeHasher, exploding);
  await withAdminEnv({ email: ADMIN_EMAIL }, () => service.onApplicationBootstrap());
  // No throw escaped onApplicationBootstrap (a seed failure must not crash boot).
  assert.equal(holder.peek(), null);
});
