/**
 * Test for the recipient-routing transport seam (wire-resend-otp-mail,
 * email-otp-login spec §"SMTP delivery and capability gating").
 *
 * Spec: mail is sent through a per-recipient transport-selection seam over named
 * transports; a DEFAULT transport is the unprefixed `SMTP_*` tuple; a recipient with
 * no matching rule falls back to the default; OTP is available iff at least one
 * transport is configured. With only the default channel registered today, every
 * recipient routes to it — these tests pin that behavior so a future China channel is
 * an additive change.
 *
 * No DB, no DI: the routing/gating functions are pure over an injected env.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTransportFor, isSmtpConfigured } from './mail.service';

const FULL: NodeJS.ProcessEnv = {
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '465',
  SMTP_USER: 'resend',
  SMTP_PASS: 're_test_key',
  SMTP_FROM: 'no-reply@auth.example.com',
};

test('isSmtpConfigured: false when no transport is configured', () => {
  assert.equal(isSmtpConfigured({}), false);
});

test('isSmtpConfigured: true when the default SMTP_* transport is configured', () => {
  assert.equal(isSmtpConfigured(FULL), true);
});

test('isSmtpConfigured: false on a partial default config (fail-closed)', () => {
  const partial: NodeJS.ProcessEnv = { ...FULL };
  delete partial.SMTP_PASS;
  assert.equal(isSmtpConfigured(partial), false, 'a missing var means no usable transport');
});

test('resolveTransportFor: returns null for every recipient when no transport is configured', () => {
  assert.equal(resolveTransportFor('alice@gmail.com', {}), null);
  assert.equal(resolveTransportFor('bob@qq.com', {}), null);
});

test('resolveTransportFor: the configured default transport serves any recipient', () => {
  const intl = resolveTransportFor('alice@gmail.com', FULL);
  assert.ok(intl !== null, 'a configured default transport resolves');
  assert.equal(intl.host, 'smtp.resend.com');
  assert.equal(intl.port, 465);
  assert.equal(intl.from, 'no-reply@auth.example.com');
});

test('resolveTransportFor: a recipient with no specific rule falls back to the default transport', () => {
  // A China-mainland address has no dedicated channel today → routes to the default.
  const cn = resolveTransportFor('user@qq.com', FULL);
  assert.ok(cn !== null, 'an unmatched recipient still resolves via the default channel');
  assert.equal(cn.host, 'smtp.resend.com', 'it is the same default transport');
});
