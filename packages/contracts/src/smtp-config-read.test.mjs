/**
 * `SmtpConfigRead` vs `SaveSmtpConfigRequest` — the read/write asymmetry.
 *
 * `SmtpConfigReadSchema` carried the write shape's `.min(1)` strictness for its
 * whole life while the api emitted a blank tuple for an unset config. Nothing
 * failed, because the schema had no call site anywhere in the repository. It has
 * one now (`smtp.controller.ts`, both the read and the save path), which makes
 * these cases the thing that would have caught it.
 *
 * Run: node --test src/smtp-config-read.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { SmtpConfigReadSchema, SaveSmtpConfigRequestSchema } = require(
  path.join(here, '..', 'dist', 'index.js'),
);

/** The three unset shapes the system can actually produce. */
const UNSET_SHAPES = {
  // apps/api/src/mail/smtp.controller.ts — EMPTY_SMTP_CONFIG_READ, returned when
  // the singleton row has never been saved.
  'controller blank tuple': {
    host: '',
    port: 0,
    user: '',
    from: '',
    hasPassword: false,
    passLast4: null,
  },
  // apps/web/src/lib/api/mock.ts — the fixed Resend host/port/user with no
  // sender chosen yet. This is why the read shape is not a two-branch union over
  // "all blank" and "all set": there is a third state in between.
  'console mock, fixed tuple with no sender': {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: '',
    hasPassword: false,
    passLast4: null,
  },
  // A row saved without a password: everything non-empty, hasPassword false.
  // This is why hasPassword cannot serve as the configured/unconfigured
  // discriminant.
  'saved row with no password': {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'no-reply@example.com',
    hasPassword: false,
    passLast4: null,
  },
};

for (const [name, shape] of Object.entries(UNSET_SHAPES)) {
  test(`the read shape accepts a real unset state: ${name}`, () => {
    assert.deepEqual(SmtpConfigReadSchema.parse(shape), shape);
  });
}

test('the read shape still accepts a fully configured projection', () => {
  const configured = {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'no-reply@example.com',
    hasPassword: true,
    passLast4: 'ab12',
  };
  assert.deepEqual(SmtpConfigReadSchema.parse(configured), configured);
});

test('the read shape never carries a password, however it arrives', () => {
  const parsed = SmtpConfigReadSchema.parse({
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'no-reply@example.com',
    hasPassword: true,
    passLast4: 'ab12',
    pass: 're_a_plaintext_key_that_must_not_survive',
  });
  assert.equal('pass' in parsed, false);
});

test('the read shape still rejects a port outside the valid range', () => {
  // Relaxing the lower bound to 0 (unset) must not relax the upper one.
  assert.throws(() =>
    SmtpConfigReadSchema.parse({
      host: '',
      port: 70000,
      user: '',
      from: '',
      hasPassword: false,
      passLast4: null,
    }),
  );
  assert.throws(() =>
    SmtpConfigReadSchema.parse({
      host: '',
      port: -1,
      user: '',
      from: '',
      hasPassword: false,
      passLast4: null,
    }),
  );
});

test('the WRITE shape keeps every .min(1) the read gave up', () => {
  // The asymmetry is the decision (design D6): a save is where emptiness can
  // still be rejected, so it is where the strictness belongs. If this ever
  // passes, the relaxation leaked from the read onto the write.
  for (const field of ['host', 'user', 'from']) {
    assert.throws(
      () =>
        SaveSmtpConfigRequestSchema.parse({
          host: 'smtp.resend.com',
          port: 465,
          user: 'resend',
          from: 'no-reply@example.com',
          [field]: '',
        }),
      new RegExp('.'),
      `SaveSmtpConfigRequestSchema accepted an empty ${field}`,
    );
  }
  assert.throws(() =>
    SaveSmtpConfigRequestSchema.parse({
      host: 'smtp.resend.com',
      port: 0,
      user: 'resend',
      from: 'no-reply@example.com',
    }),
  );
});
