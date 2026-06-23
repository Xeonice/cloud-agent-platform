/**
 * Test for the recipient-routing transport seam + DB-first/env-fallback resolution
 * (add-smtp-config-ui, email-otp-login spec §"SMTP delivery and capability gating").
 *
 * Spec: mail is sent through a per-recipient transport-selection seam over named
 * transports; the DEFAULT transport resolves the STORED DB SMTP config FIRST and
 * FALLS BACK to the unprefixed `SMTP_*` env (the DB config takes precedence); a
 * recipient with no matching rule falls back to the default; OTP is available iff
 * at least one transport is configured (DB OR env). With only the default channel
 * registered today, every recipient routes to it — these tests pin that behavior so
 * a future China channel is an additive change.
 *
 * No DB, no DI: the routing/gating functions are async and pure over an INJECTED DB
 * resolver (a `() => Promise<ResolvedSmtpConfig | null>`) + env, so the DB-first /
 * env-fallback ordering is exercised without a real Prisma client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveTransportFor,
  isSmtpConfigured,
  type DbSmtpConfigResolver,
  type ResolvedSmtpConfig,
} from './mail.service';

const FULL: NodeJS.ProcessEnv = {
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '465',
  SMTP_USER: 'resend',
  SMTP_PASS: 're_test_key',
  SMTP_FROM: 'no-reply@auth.example.com',
};

/** A DB resolver that always resolves `null` — no stored config (env-only path). */
const NO_DB: DbSmtpConfigResolver = async () => null;

/** A DB resolver that resolves a stored config (its `source` is always `'db'`). */
function dbConfig(config: Omit<ResolvedSmtpConfig, 'source'>): DbSmtpConfigResolver {
  return async () => ({ ...config, source: 'db' });
}

const DB_FULL: Omit<ResolvedSmtpConfig, 'source'> = {
  host: 'smtp.db.example.com',
  port: 587,
  user: 'db-user',
  pass: 'db-secret',
  from: 'no-reply@db.example.com',
};

// --- isSmtpConfigured (async, DB OR env) ---------------------------------------

test('isSmtpConfigured: false when neither DB nor env is configured', async () => {
  assert.equal(await isSmtpConfigured(NO_DB, {}), false);
});

test('isSmtpConfigured: true when the env SMTP_* transport is configured', async () => {
  assert.equal(await isSmtpConfigured(NO_DB, FULL), true);
});

test('isSmtpConfigured: true when only the DB config is configured (no env)', async () => {
  assert.equal(await isSmtpConfigured(dbConfig(DB_FULL), {}), true);
});

test('isSmtpConfigured: false on a partial env config and no DB (fail-closed)', async () => {
  const partial: NodeJS.ProcessEnv = { ...FULL };
  delete partial.SMTP_PASS;
  assert.equal(
    await isSmtpConfigured(NO_DB, partial),
    false,
    'a missing env var and no DB row means no usable transport',
  );
});

test('isSmtpConfigured: defaults to env-only (no DB resolver) — back-compat', async () => {
  assert.equal(await isSmtpConfigured(undefined, FULL), true);
  assert.equal(await isSmtpConfigured(undefined, {}), false);
});

// --- resolveTransportFor (async, DB-first / env-fallback) ----------------------

test('resolveTransportFor: returns null for every recipient when neither DB nor env is configured', async () => {
  assert.equal(await resolveTransportFor('alice@gmail.com', NO_DB, {}), null);
  assert.equal(await resolveTransportFor('bob@qq.com', NO_DB, {}), null);
});

test('resolveTransportFor: falls back to the env transport when no DB config exists', async () => {
  const intl = await resolveTransportFor('alice@gmail.com', NO_DB, FULL);
  assert.ok(intl !== null, 'a configured env transport resolves');
  assert.equal(intl.host, 'smtp.resend.com');
  assert.equal(intl.port, 465);
  assert.equal(intl.from, 'no-reply@auth.example.com');
  assert.equal(intl.source, 'env', 'env fallback is stamped source=env');
});

test('resolveTransportFor: the DB config takes precedence over the env', async () => {
  const resolved = await resolveTransportFor('alice@gmail.com', dbConfig(DB_FULL), FULL);
  assert.ok(resolved !== null, 'the DB config resolves');
  assert.equal(resolved.host, 'smtp.db.example.com', 'DB host wins over env');
  assert.equal(resolved.port, 587);
  assert.equal(resolved.from, 'no-reply@db.example.com');
  assert.equal(resolved.source, 'db', 'a DB-resolved config is stamped source=db');
});

test('resolveTransportFor: a recipient with no specific rule falls back to the default transport', async () => {
  // A China-mainland address has no dedicated channel today → routes to the default.
  const cn = await resolveTransportFor('user@qq.com', NO_DB, FULL);
  assert.ok(cn !== null, 'an unmatched recipient still resolves via the default channel');
  assert.equal(cn.host, 'smtp.resend.com', 'it is the same default transport');
});
