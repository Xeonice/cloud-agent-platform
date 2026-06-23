/**
 * Tests for the persisted-DB SMTP config service (add-smtp-config-ui, track
 * backend-storage, task 2.2; spec `smtp-configuration`).
 *
 * Against the REAL service with an in-memory fake Prisma:
 *   - saveConfig ENCRYPTS the password at rest (ciphertext only, never the
 *     plaintext) alongside the non-secret host/port/user/from + a masked suffix.
 *   - readConfig projects host/port/user/from + passLast4 + hasPassword and
 *     NEVER returns the plaintext password.
 *   - saveConfig FAILS CLOSED without an encryption key (no plaintext stored).
 *   - resolveDbSmtpConfig returns the DECRYPTED transport tuple (DB-first path),
 *     and null when no row / no password.
 *   - a blank/omitted password on save KEEPS the existing stored secret.
 *
 * Runs under `pnpm test` (nest build → node --test dist/**\/*.spec.js): no DB, no
 * DI container — a fake Prisma + a real 32-byte key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SMTP_CONFIG_ROW_ID, SmtpConfigService } from './smtp-config.service';
import { EncryptionKeyUnavailableError } from '../settings/settings-crypto';
import type { PrismaService } from '../prisma/prisma.service';

// A real 32-byte hex key so encrypt/decrypt actually round-trips.
const KEY = '0'.repeat(64);
const ENV: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: KEY };
const NO_KEY_ENV: NodeJS.ProcessEnv = {};

interface SmtpRow {
  id: string;
  host: string;
  port: number;
  user: string;
  from: string;
  passCiphertext: string | null;
  passLast4: string | null;
}

interface FakeStore {
  row: SmtpRow | null;
}

/**
 * Minimal in-memory fake Prisma covering the `smtpConfig` delegate the service
 * touches: `findUnique` + `upsert` (create/update on the fixed singleton id).
 */
function makeFakePrisma(store: FakeStore): PrismaService {
  return {
    smtpConfig: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        store.row && store.row.id === where.id ? store.row : null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Omit<SmtpRow, never>;
        update: Partial<SmtpRow>;
      }) => {
        if (store.row && store.row.id === where.id) {
          Object.assign(store.row, update);
          return store.row;
        }
        store.row = {
          id: where.id,
          host: create.host,
          port: create.port,
          user: create.user,
          from: create.from,
          passCiphertext: create.passCiphertext ?? null,
          passLast4: create.passLast4 ?? null,
        };
        return store.row;
      },
    },
  } as unknown as PrismaService;
}

const SAMPLE = {
  host: 'smtp.resend.com',
  port: 465,
  user: 'resend',
  from: 'noreply@example.test',
  pass: 're_supersecretapikeyvalue',
} as const;

// ---------------------------------------------------------------------------
// Save encrypts the password at rest
// ---------------------------------------------------------------------------

test('saveConfig stores the password as ciphertext only (never plaintext)', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));

  const result = await svc.saveConfig(SAMPLE, ENV);

  // The persisted row holds the non-secret fields + an ENCRYPTED password.
  assert.ok(store.row, 'a row was upserted');
  assert.equal(store.row!.id, SMTP_CONFIG_ROW_ID, 'fixed singleton id');
  assert.equal(store.row!.host, SAMPLE.host);
  assert.equal(store.row!.port, SAMPLE.port);
  assert.equal(store.row!.user, SAMPLE.user);
  assert.equal(store.row!.from, SAMPLE.from);

  const ct = store.row!.passCiphertext;
  assert.ok(ct && ct.length > 0, 'a ciphertext is stored');
  assert.ok(!ct!.includes(SAMPLE.pass), 'the plaintext password is NOT in the ciphertext');
  assert.equal(ct!.split('.').length, 3, 'born-encrypted envelope (ciphertext.iv.authTag)');
  assert.equal(store.row!.passLast4, 'alue', 'masked last-4 suffix stored');

  // The returned read shape carries the masked indicator, never the plaintext.
  assert.equal(result.hasPassword, true);
  assert.equal(result.passLast4, 'alue');
  assert.ok(!JSON.stringify(result).includes(SAMPLE.pass), 'plaintext absent from the result');
});

// ---------------------------------------------------------------------------
// Masked read never returns the plaintext
// ---------------------------------------------------------------------------

test('readConfig projects the masked shape and never the plaintext password', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  await svc.saveConfig(SAMPLE, ENV);

  const read = await svc.readConfig();
  assert.ok(read, 'a config is read back');
  assert.deepEqual(
    { ...read },
    {
      host: SAMPLE.host,
      port: SAMPLE.port,
      user: SAMPLE.user,
      from: SAMPLE.from,
      passLast4: 'alue',
      hasPassword: true,
    },
    'read shape is exactly host/port/user/from + passLast4 + hasPassword',
  );
  assert.ok(!('pass' in read!), 'the read shape has no plaintext pass field');
  assert.ok(
    !JSON.stringify(read).includes(SAMPLE.pass),
    'the plaintext password never appears in the read',
  );
});

test('readConfig returns null when no config row exists', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  assert.equal(await svc.readConfig(), null);
});

// ---------------------------------------------------------------------------
// Save fails closed without an encryption key
// ---------------------------------------------------------------------------

test('saveConfig fails closed without an encryption key (no plaintext persisted)', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));

  await assert.rejects(
    () => svc.saveConfig(SAMPLE, NO_KEY_ENV),
    (err: unknown) => err instanceof EncryptionKeyUnavailableError,
    'a keyless save is rejected',
  );

  assert.equal(store.row, null, 'nothing was persisted — no plaintext on disk');
});

// ---------------------------------------------------------------------------
// DB resolution decrypts (DB-first path)
// ---------------------------------------------------------------------------

test('resolveDbSmtpConfig returns the decrypted transport tuple', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  await svc.saveConfig(SAMPLE, ENV);

  const resolved = await svc.resolveDbSmtpConfig(ENV);
  assert.deepEqual(resolved, {
    host: SAMPLE.host,
    port: SAMPLE.port,
    user: SAMPLE.user,
    pass: SAMPLE.pass,
    from: SAMPLE.from,
  });
});

test('resolveDbSmtpConfig returns null when no row exists (env fallback signal)', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  assert.equal(await svc.resolveDbSmtpConfig(ENV), null);
});

test('resolveDbSmtpConfig returns null when the password cannot be decrypted', async () => {
  // Saved with one key; resolved with a different key → decrypt fails → null.
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  await svc.saveConfig(SAMPLE, ENV);

  const otherKey: NodeJS.ProcessEnv = { CODEX_CRED_ENC_KEY: '1'.repeat(64) };
  assert.equal(await svc.resolveDbSmtpConfig(otherKey), null);
});

// ---------------------------------------------------------------------------
// Blank/omitted password keeps the existing secret ("留空沿用")
// ---------------------------------------------------------------------------

test('saveConfig with a blank password keeps the existing stored secret', async () => {
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  await svc.saveConfig(SAMPLE, ENV);
  const originalCiphertext = store.row!.passCiphertext;

  // Edit the sender only, no password → the ciphertext + last4 are unchanged.
  const result = await svc.saveConfig(
    { host: SAMPLE.host, port: SAMPLE.port, user: SAMPLE.user, from: 'changed@example.test' },
    ENV,
  );

  assert.equal(store.row!.from, 'changed@example.test', 'non-secret field updated');
  assert.equal(store.row!.passCiphertext, originalCiphertext, 'stored secret left intact');
  assert.equal(store.row!.passLast4, 'alue', 'masked suffix left intact');
  assert.equal(result.hasPassword, true, 'still reports a password is stored');

  // And it still decrypts to the ORIGINAL password.
  const resolved = await svc.resolveDbSmtpConfig(ENV);
  assert.equal(resolved?.pass, SAMPLE.pass);
});

test('saveConfig with a blank password and NO key still succeeds (no secret touched)', async () => {
  // A no-password edit must NOT trip the fail-closed key check (only a NEW
  // password requires the key).
  const store: FakeStore = { row: null };
  const svc = new SmtpConfigService(makeFakePrisma(store));
  await svc.saveConfig(SAMPLE, ENV); // seed a row with a stored secret

  const result = await svc.saveConfig(
    { host: SAMPLE.host, port: 587, user: SAMPLE.user, from: SAMPLE.from },
    NO_KEY_ENV,
  );
  assert.equal(store.row!.port, 587, 'non-secret edit applied without a key');
  assert.equal(result.hasPassword, true, 'existing secret preserved');
});
