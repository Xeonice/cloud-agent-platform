/**
 * The two drifted pairs, verified at the wire rather than by typecheck.
 *
 * `SmtpConfigRead` and `RuntimeReadiness` were the only two convergences in this
 * change that alter what a declaration says about bytes already being sent, and
 * a typecheck cannot see either: one was a schema with no call site anywhere in
 * the repository, and the other an envelope the console worked around. So these
 * cases drive the REAL compiled handlers and assert what they hand back.
 *
 * The contract is the shared middle. The api asserting its output against the
 * same schema the console validates with is what makes this end-to-end rather
 * than self-consistent — before this change, both of these bodies would have
 * failed that assertion, in opposite directions.
 *
 * Runs against the compiled dist/ (no Nest container, no DB).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '..', 'dist');

const { SmtpController } = require(path.join(DIST, 'mail/smtp.controller.js'));
const { RuntimesService } = require(
  path.join(DIST, 'runtimes/runtimes.service.js'),
);
const { SmtpConfigReadSchema, RuntimeReadinessResponseSchema } = require(
  '@cap-console/contracts',
);

// ---- doubles ---------------------------------------------------------------

const ADMIN_ID = 'user-admin';

/** A request whose principal passes the controller's admin gate. */
const adminRequest = () => ({
  operatorPrincipal: {
    // `isAdminPrincipal` is fail-closed on all three: a session (not a machine
    // credential), enabled, and role admin.
    kind: 'session',
    user: { id: ADMIN_ID, githubId: 4242, allowed: true, role: 'admin' },
  },
});

/** Prisma double returning an allowed admin row for the id above. */
const adminPrisma = () => ({
  user: {
    findUnique: async () => ({
      role: 'admin',
      allowed: true,
      email: 'admin@example.com',
    }),
  },
});

/** SmtpConfigService double: `readConfig` returns whatever the case supplies. */
const smtpService = (row) => ({
  readConfig: async () => row,
  saveConfig: async () => row,
});

// ---- SmtpConfigRead: the unset state must survive its own contract ----------

test('GET /settings/smtp emits a body its own contract accepts when NOTHING is configured', async () => {
  // The storage service returns null for a singleton that has never been saved,
  // and the controller coalesces that to a blank tuple. Against the pre-change
  // schema (`host/user/from` .min(1), `port` .min(1)) this exact body was
  // rejected by the declaration the console validates with — and nothing noticed,
  // because the schema had no call site. The controller now parses on the way
  // out, so an unset config that could not be described would throw here.
  const controller = new SmtpController(smtpService(null), adminPrisma());
  const body = await controller.read(adminRequest());

  assert.deepEqual(body, {
    host: '',
    port: 0,
    user: '',
    from: '',
    hasPassword: false,
    passLast4: null,
  });
  assert.doesNotThrow(() => SmtpConfigReadSchema.parse(body));
});

test('GET /settings/smtp still emits a configured projection, and never a password', async () => {
  const stored = {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'no-reply@example.com',
    hasPassword: true,
    passLast4: 'ab12',
  };
  const controller = new SmtpController(
    // The service double leaks a plaintext key the real one never returns; the
    // parse on the way out is what guarantees it cannot reach the wire.
    smtpService({ ...stored, pass: 're_plaintext_key' }),
    adminPrisma(),
  );
  const body = await controller.read(adminRequest());

  assert.deepEqual(body, stored);
  assert.equal('pass' in body, false);
});

test('the SMTP read stays admin-gated — the parse did not become the only check', async () => {
  const controller = new SmtpController(smtpService(null), adminPrisma());
  await assert.rejects(
    () => controller.read({ operatorPrincipal: undefined }),
    /admin/i,
  );
});

// ---- RuntimeReadiness: the envelope ----------------------------------------

test('GET /runtimes emits the bare array its contract declares, not an envelope', async () => {
  // `{ runtimes: [...] }` is what this endpoint sent from the commit that
  // introduced it (f050ab0) while the contract declared `z.array(…)` in the same
  // commit. This is the assertion that would have failed then.
  const body = await new RuntimesService().getReadiness(null);

  assert.ok(Array.isArray(body), 'the response body is the list itself');
  assert.equal('runtimes' in body, false, 'no envelope key survives');
  assert.doesNotThrow(() => RuntimeReadinessResponseSchema.parse(body));
});

test('GET /runtimes reports every declared runtime, booleans only', async () => {
  const { AGENT_RUNTIME_IDS } = require('@cap-console/contracts');
  const body = await new RuntimesService().getReadiness(null);

  assert.deepEqual(
    body.map((entry) => entry.id).sort(),
    [...AGENT_RUNTIME_IDS].sort(),
  );
  for (const entry of body) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['id', 'ready'],
      'readiness carries booleans only — never a credential or a suffix',
    );
    assert.equal(typeof entry.ready, 'boolean');
  }
});
