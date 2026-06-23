/**
 * Tests for the one-time env→DB SMTP migration boot seed (add-smtp-config-ui,
 * track backend-storage, task 2.3; spec `smtp-configuration`).
 *
 * Covers the three load-bearing behaviours (design D9):
 *   1. MIGRATES ON FIRST BOOT — with the env SMTP configured, no DB config, the
 *      marker unset, and a key available, the env values are seeded into the DB
 *      (password born-ENCRYPTED) and the marker is stamped.
 *   2. NEVER RE-SEEDS once the marker is set — even if the DB config was since
 *      DELETED, a subsequent boot does NOT re-create it (the admin's intent to
 *      remove it is respected).
 *   3. SKIPS WITHOUT A KEY — fail-closed: no encryption key ⇒ no DB write, no
 *      marker (the env fallback continues to serve mail).
 *
 * Plus: the boot hook never throws; a DB config already present is left intact;
 * a partial env is not migrated.
 *
 * Exercises the REAL {@link SmtpEnvMigrationService} over the REAL
 * {@link SmtpConfigService} with an in-memory fake Prisma — no DB, no DI
 * container — so it runs under `pnpm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SYSTEM_SETTINGS_ROW_ID,
  SmtpEnvMigrationService,
} from './smtp-env-migration.service';
import { SMTP_CONFIG_ROW_ID, SmtpConfigService } from './smtp-config.service';
import type { PrismaService } from '../prisma/prisma.service';

const KEY = '0'.repeat(64);

/** A fully-configured env (all five SMTP_* vars + the encryption key). */
function fullEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CODEX_CRED_ENC_KEY: KEY,
    SMTP_HOST: 'smtp.resend.com',
    SMTP_PORT: '465',
    SMTP_USER: 'resend',
    SMTP_PASS: 're_envsecretapikey',
    SMTP_FROM: 'noreply@example.test',
    ...extra,
  };
}

interface SmtpRow {
  id: string;
  host: string;
  port: number;
  user: string;
  from: string;
  passCiphertext: string | null;
  passLast4: string | null;
}

interface SettingsRow {
  id: string;
  maxConcurrentTasks: number;
  smtpEnvMigratedAt: Date | null;
}

interface FakeDb {
  smtp: SmtpRow | null;
  settings: SettingsRow | null;
}

/**
 * In-memory fake Prisma covering the `smtpConfig` + `systemSettings` delegates
 * the migration + config service touch. A single backing store is shared across
 * "restart" re-constructions to model process restarts over the same DB.
 */
function makeFakePrisma(db: FakeDb): PrismaService {
  return {
    smtpConfig: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.smtp && db.smtp.id === where.id ? db.smtp : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: SmtpRow;
        update: Partial<SmtpRow>;
      }) => {
        if (db.smtp && db.smtp.id === where.id) {
          Object.assign(db.smtp, update);
          return db.smtp;
        }
        db.smtp = {
          id: where.id,
          host: create.host,
          port: create.port,
          user: create.user,
          from: create.from,
          passCiphertext: create.passCiphertext ?? null,
          passLast4: create.passLast4 ?? null,
        };
        return db.smtp;
      },
    },
    systemSettings: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.settings && db.settings.id === where.id ? db.settings : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: { id: string; maxConcurrentTasks: number; smtpEnvMigratedAt?: Date };
        update: Partial<SettingsRow>;
      }) => {
        if (db.settings && db.settings.id === where.id) {
          Object.assign(db.settings, update);
          return db.settings;
        }
        db.settings = {
          id: create.id,
          maxConcurrentTasks: create.maxConcurrentTasks,
          smtpEnvMigratedAt: create.smtpEnvMigratedAt ?? null,
        };
        return db.settings;
      },
    },
  } as unknown as PrismaService;
}

function build(db: FakeDb): SmtpEnvMigrationService {
  const prisma = makeFakePrisma(db);
  return new SmtpEnvMigrationService(new SmtpConfigService(prisma), prisma);
}

function freshDb(): FakeDb {
  return { smtp: null, settings: null };
}

// ---------------------------------------------------------------------------
// 1 — migrates on first boot
// ---------------------------------------------------------------------------

test('migrates the env SMTP config into the DB on first boot and stamps the marker', async () => {
  const db = freshDb();
  const env = fullEnv();

  await build(db).migrate(env);

  assert.ok(db.smtp, 'a DB config row was created');
  assert.equal(db.smtp!.id, SMTP_CONFIG_ROW_ID);
  assert.equal(db.smtp!.host, 'smtp.resend.com');
  assert.equal(db.smtp!.port, 465);
  assert.equal(db.smtp!.user, 'resend');
  assert.equal(db.smtp!.from, 'noreply@example.test');

  // The password is born-ENCRYPTED (ciphertext only, never plaintext).
  const ct = db.smtp!.passCiphertext;
  assert.ok(ct && !ct.includes('re_envsecretapikey'), 'env password stored encrypted, not plaintext');
  assert.equal(ct!.split('.').length, 3, 'born-encrypted envelope');

  // The marker is stamped so the migration runs at most once.
  assert.ok(db.settings, 'system settings row created');
  assert.equal(db.settings!.id, SYSTEM_SETTINGS_ROW_ID);
  assert.ok(db.settings!.smtpEnvMigratedAt instanceof Date, 'marker stamped');

  // And the migrated row resolves back to the original env password.
  const resolved = await new SmtpConfigService(makeFakePrisma(db)).resolveDbSmtpConfig(env);
  assert.equal(resolved?.pass, 're_envsecretapikey');
});

// ---------------------------------------------------------------------------
// 2 — never re-seeds once the marker is set (even if the DB config was deleted)
// ---------------------------------------------------------------------------

test('does not re-seed once the marker is set, even if the DB config was deleted', async () => {
  const db = freshDb();
  const env = fullEnv();

  // First boot migrates + stamps.
  await build(db).migrate(env);
  assert.ok(db.smtp, 'first boot created the DB config');
  assert.ok(db.settings!.smtpEnvMigratedAt, 'marker set');

  // An admin later DELETES the DB config (the marker stays set).
  db.smtp = null;

  // Re-boot over the same DB: the env is still configured, but the marker guards
  // against re-seeding the admin's deliberately-removed config.
  await build(db).migrate(env);
  assert.equal(db.smtp, null, 'no re-seed — the admin deletion is respected');
});

test('does not re-seed when the marker is already set on a fresh DB config-less boot', async () => {
  const db = freshDb();
  db.settings = { id: SYSTEM_SETTINGS_ROW_ID, maxConcurrentTasks: 5, smtpEnvMigratedAt: new Date() };

  await build(db).migrate(fullEnv());
  assert.equal(db.smtp, null, 'marker present ⇒ migration is a no-op');
});

// ---------------------------------------------------------------------------
// 3 — skips without a key (fail-closed)
// ---------------------------------------------------------------------------

test('skips fail-closed when no encryption key is available', async () => {
  const db = freshDb();
  const env = fullEnv();
  delete env.CODEX_CRED_ENC_KEY;

  await build(db).migrate(env);

  assert.equal(db.smtp, null, 'no DB write without a key (env fallback continues)');
  assert.equal(db.settings, null, 'marker NOT stamped — the migration may run later once a key exists');
});

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

test('does not migrate when a DB config already exists', async () => {
  const db = freshDb();
  const env = fullEnv();
  // Seed a pre-existing DB config (a saved admin config).
  await new SmtpConfigService(makeFakePrisma(db)).saveConfig(
    { host: 'smtp.admin.test', port: 587, user: 'admin', from: 'admin@example.test', pass: 'admin-pass' },
    env,
  );

  await build(db).migrate(env);

  assert.equal(db.smtp!.host, 'smtp.admin.test', 'existing DB config left intact');
  assert.equal(db.settings, null, 'no marker stamped — nothing was migrated');
});

test('does not migrate when the env SMTP is only partially configured', async () => {
  const db = freshDb();
  const env = fullEnv();
  delete env.SMTP_PASS; // partial env ⇒ resolveSmtpConfig returns null

  await build(db).migrate(env);

  assert.equal(db.smtp, null, 'a partial env is not migrated');
  assert.equal(db.settings, null, 'no marker stamped');
});

test('the boot hook never throws even if the migration write fails', async () => {
  const exploding = {
    systemSettings: {
      findUnique: async () => {
        throw new Error('db down');
      },
    },
  } as unknown as PrismaService;
  const service = new SmtpEnvMigrationService(new SmtpConfigService(exploding), exploding);
  // Must not throw out of the boot hook.
  await service.onApplicationBootstrap();
});
