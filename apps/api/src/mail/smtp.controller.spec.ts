/**
 * Tests for the admin-only SMTP configuration surface (add-smtp-config-ui, task
 * 4.2).
 *
 * Asserts the load-bearing requirements of track 4 (backend-api):
 *   1. ADMIN GATE — a non-admin (a `member`, the identity-less legacy operator,
 *      and an absent principal) is 403'd at the controller on EVERY route (read,
 *      save, test) BEFORE the service runs, re-checked against the LIVE `User` row
 *      so a just-demoted/just-disabled admin fails closed (spec "A non-admin ...
 *      SHALL be denied").
 *   2. MASKED READ — the read projection carries host/port/user/from + a masked
 *      suffix + `hasPassword`, and NEVER the plaintext password (spec "Reading the
 *      config never returns the plaintext password").
 *   3. SAVE ENCRYPTS — a save stores the password only as ciphertext (never
 *      plaintext) alongside the non-secret fields + masked suffix (spec "Saving a
 *      config encrypts the password at rest").
 *   4. TEST TARGETS THE ADMIN'S OWN EMAIL — the test-send delivers to the
 *      requesting admin's own account email, not an arbitrary address (spec D5 /
 *      "the requesting admin's own email").
 *
 * Exercises {@link SmtpController} with a fake `SmtpConfigService` (that really
 * encrypts via the shared `secret-storage`) and a fake Prisma + synthesized
 * principals — no DB, no DI container, no live SMTP server (the transport is
 * overridden) — so it runs under `pnpm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import type {
  SaveSmtpConfigRequest,
  SmtpConfigRead,
  TestSmtpConfigRequest,
} from '@cap/contracts';

import { SmtpController } from './smtp.controller';
import { SmtpConfigService } from './smtp-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  encryptToStored,
  decryptStored,
  CODEX_CRED_ENC_KEY_ENV,
} from '../settings/secret-storage';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import type { OperatorPrincipal } from '../auth/operator-principal';

// A 32-byte (base64) at-rest key so the fake service really encrypts/decrypts.
const TEST_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const TEST_ENV: NodeJS.ProcessEnv = { [CODEX_CRED_ENC_KEY_ENV]: TEST_ENC_KEY };

// ---------------------------------------------------------------------------
// In-memory fake Prisma (only `user.findUnique` is exercised by the admin gate)
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string | null;
  role: string;
  allowed: boolean;
  githubId: number | null;
}

interface FakeDb {
  prisma: PrismaService;
  users: UserRow[];
  seedUser: (row: Partial<UserRow> & { id: string }) => UserRow;
}

function makeFakePrisma(): FakeDb {
  const users: UserRow[] = [];
  const prisma = {
    user: {
      findUnique: async ({
        where,
      }: {
        where: { id?: string; githubId?: number };
        select?: Record<string, boolean>;
      }) => {
        const row = users.find(
          (u) =>
            (where.id !== undefined && u.id === where.id) ||
            (where.githubId !== undefined && u.githubId === where.githubId),
        );
        return row ?? null;
      },
    },
  } as unknown as PrismaService;

  return {
    prisma,
    users,
    seedUser: (row) => {
      const full: UserRow = {
        id: row.id,
        email: row.email ?? null,
        role: row.role ?? 'member',
        allowed: row.allowed ?? true,
        githubId: row.githubId ?? null,
      };
      users.push(full);
      return full;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake SmtpConfigService — a singleton row that REALLY encrypts the password
// via the shared secret-storage (so "save encrypts" is proven, not stubbed).
// ---------------------------------------------------------------------------

interface StoredSmtp {
  host: string;
  port: number;
  user: string;
  from: string;
  passCiphertext: string | null;
  passLast4: string | null;
}

function makeFakeSmtpService(): {
  service: SmtpConfigService;
  row: () => StoredSmtp | null;
} {
  let stored: StoredSmtp | null = null;

  const mask = (read: StoredSmtp): SmtpConfigRead =>
    ({
      host: read.host,
      port: read.port,
      user: read.user,
      from: read.from,
      passLast4: read.passLast4,
      hasPassword: read.passCiphertext !== null,
    }) as SmtpConfigRead;

  const service = {
    async readConfig(): Promise<SmtpConfigRead> {
      if (!stored) {
        // An unset singleton still returns a (masked) projection with no secret.
        return {
          host: '',
          port: 0,
          user: '',
          from: '',
          passLast4: null,
          hasPassword: false,
        } as SmtpConfigRead;
      }
      return mask(stored);
    },
    async saveConfig(body: SaveSmtpConfigRequest): Promise<SmtpConfigRead> {
      // An omitted/blank password keeps the previously stored secret ("留空沿用");
      // a supplied one is encrypted at rest (FAIL-CLOSED: throws without a key) so
      // the stored value is ciphertext, never plaintext.
      const pass = typeof body.pass === 'string' ? body.pass : '';
      const settingPassword = pass.length > 0;
      stored = {
        host: body.host,
        port: body.port,
        user: body.user,
        from: body.from,
        passCiphertext: settingPassword
          ? encryptToStored(pass, TEST_ENV)
          : stored?.passCiphertext ?? null,
        passLast4: settingPassword ? pass.slice(-4) : stored?.passLast4 ?? null,
      };
      return mask(stored);
    },
    async resolveDbSmtpConfig() {
      if (!stored || stored.passCiphertext === null) {
        return null;
      }
      const pass = decryptStored(stored.passCiphertext, TEST_ENV);
      if (pass === null) {
        return null;
      }
      return {
        host: stored.host,
        port: stored.port,
        user: stored.user,
        pass,
        from: stored.from,
        source: 'db' as const,
      };
    },
  } as unknown as SmtpConfigService;

  return { service, row: () => stored };
}

// ---------------------------------------------------------------------------
// A controller whose transport is captured instead of dialling a real server.
// ---------------------------------------------------------------------------

interface SentMessage {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
}

class CapturingSmtpController extends SmtpController {
  public readonly sent: SentMessage[] = [];
  public lastTransportConfig:
    | { host: string; port: number; user: string; pass: string; from: string }
    | null = null;

  protected override createTransport(config: {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
  }): Transporter {
    this.lastTransportConfig = config;
    const sent = this.sent;
    return {
      async sendMail(message: SentMessage) {
        sent.push(message);
        return { messageId: 'test' };
      },
    } as unknown as Transporter;
  }
}

class FailingSmtpController extends SmtpController {
  protected override createTransport(): Transporter {
    return {
      async sendMail() {
        throw new Error('ECONNREFUSED smtp.example.com:465');
      },
    } as unknown as Transporter;
  }
}

// ---------------------------------------------------------------------------
// Principal helpers
// ---------------------------------------------------------------------------

function principalRequest(
  principal: OperatorPrincipal | undefined,
): AuthenticatedRequest {
  return { operatorPrincipal: principal } as unknown as AuthenticatedRequest;
}

/** A `session` principal whose resolved user carries the internal id (gate key). */
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

// `pass` is required in this fixture (typed `string`, not the contract's optional
// `pass?`) so the round-trip assertions can reference `SAVE_BODY.pass` directly.
const SAVE_BODY: SaveSmtpConfigRequest & { pass: string } = {
  host: 'smtp.resend.com',
  port: 465,
  user: 'resend',
  pass: 're_test_key_abcd9999',
  from: 'noreply@example.com',
};

// ---------------------------------------------------------------------------
// 1. Admin gate — non-admin is 403 on read / save / test (before the service)
// ---------------------------------------------------------------------------

test('a member principal is 403 on read, save, and test (nothing read or written)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'member-1', email: 'm@example.com', role: 'member', allowed: true });
  const req = principalRequest(sessionPrincipal('member-1'));

  await assert.rejects(() => controller.read(req), ForbiddenException);
  await assert.rejects(() => controller.save(req, SAVE_BODY), ForbiddenException);
  await assert.rejects(
    () => controller.test(req, {} as TestSmtpConfigRequest),
    ForbiddenException,
  );

  assert.equal(fake.row(), null, 'no config was written by the rejected member');
  assert.equal(controller.sent.length, 0, 'no mail was sent for a non-admin');
});

test('an identity-less / absent principal is 403 on every route', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  const legacy: OperatorPrincipal = { kind: 'legacy-token', user: null };
  for (const principal of [legacy, undefined]) {
    const req = principalRequest(principal);
    await assert.rejects(() => controller.read(req), ForbiddenException);
    await assert.rejects(() => controller.save(req, SAVE_BODY), ForbiddenException);
    await assert.rejects(
      () => controller.test(req, {} as TestSmtpConfigRequest),
      ForbiddenException,
    );
  }
  assert.equal(controller.sent.length, 0);
});

test('a just-disabled admin loses access on the next request (fail-closed re-check)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  const admin = db.seedUser({
    id: 'admin-x',
    email: 'a@example.com',
    role: 'admin',
    allowed: true,
  });
  const req = principalRequest(sessionPrincipal('admin-x'));

  // Live row disabled after the session was minted -> the next request fails.
  admin.allowed = false;
  await assert.rejects(() => controller.read(req), ForbiddenException);
});

// ---------------------------------------------------------------------------
// 2. Masked read never includes the plaintext password
// ---------------------------------------------------------------------------

test('masked read carries the non-secret fields + masked suffix, never the plaintext', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-1', email: 'a@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-1'));

  await controller.save(req, SAVE_BODY);
  const read = await controller.read(req);

  assert.equal(read.host, 'smtp.resend.com');
  assert.equal(read.port, 465);
  assert.equal(read.user, 'resend');
  assert.equal(read.from, 'noreply@example.com');
  assert.equal(read.hasPassword, true, 'a saved password is advertised via hasPassword');
  assert.equal(read.passLast4, '9999', 'only the masked suffix is exposed');

  const serialized = JSON.stringify(read);
  assert.ok(
    !serialized.includes(SAVE_BODY.pass),
    'the plaintext password never appears in the read projection',
  );
});

// ---------------------------------------------------------------------------
// 3. Save encrypts the password at rest (ciphertext only)
// ---------------------------------------------------------------------------

test('save stores the password only as ciphertext (never plaintext)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-2', email: 'a2@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-2'));

  const result = await controller.save(req, SAVE_BODY);

  // The returned projection is masked.
  assert.ok(!JSON.stringify(result).includes(SAVE_BODY.pass), 'save response carries no plaintext');

  const row = fake.row();
  assert.ok(row, 'a singleton row was persisted');
  assert.ok(row.passCiphertext, 'the password is stored as ciphertext');
  assert.notEqual(row.passCiphertext, SAVE_BODY.pass, 'the plaintext is NEVER stored');
  // The ciphertext round-trips back to the plaintext under the at-rest key.
  assert.equal(
    decryptStored(row.passCiphertext, TEST_ENV),
    SAVE_BODY.pass,
    'the ciphertext decrypts to the original password (real encryption)',
  );
});

// ---------------------------------------------------------------------------
// 4. Test-send targets the requesting admin's OWN email
// ---------------------------------------------------------------------------

test('test-send delivers to the requesting admin\'s own account email', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-3', email: 'owner@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-3'));

  // A submitted candidate config (Resend-shaped: pass + fixed tuple).
  const result = await controller.test(req, {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    pass: 're_candidate_key',
    from: 'noreply@example.com',
  } as TestSmtpConfigRequest);

  assert.equal(result.ok, true, 'a successful test reports ok');
  assert.equal(controller.sent.length, 1, 'exactly one test message was sent');
  assert.equal(
    controller.sent[0].to,
    'owner@example.com',
    'the test mail targets the admin\'s OWN email, never an arbitrary address',
  );
  assert.equal(controller.lastTransportConfig?.pass, 're_candidate_key', 'the submitted candidate config is used');
});

test('test-send reuses the saved password when the candidate omits it (留空沿用)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-4', email: 'keep@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-4'));

  await controller.save(req, SAVE_BODY);
  const result = await controller.test(req, {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'noreply@example.com',
    // pass omitted -> reuse the stored one
  } as TestSmtpConfigRequest);

  assert.equal(result.ok, true);
  assert.equal(controller.sent[0].to, 'keep@example.com');
  assert.equal(
    controller.lastTransportConfig?.pass,
    SAVE_BODY.pass,
    'the omitted password falls back to the saved (decrypted) one',
  );
});

test('test-send fails closed when no password is available (no candidate, no saved)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-5', email: 'a5@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-5'));

  const result = await controller.test(req, {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    from: 'noreply@example.com',
  } as TestSmtpConfigRequest);

  assert.equal(result.ok, false, 'no password -> the test fails closed');
  assert.equal(controller.sent.length, 0, 'nothing is sent without a password');
});

test('test-send fails (ok:false) when the admin account has no email', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new CapturingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-6', email: null, role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-6'));

  const result = await controller.test(req, {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    pass: 're_x',
    from: 'noreply@example.com',
  } as TestSmtpConfigRequest);

  assert.equal(result.ok, false, 'an admin with no email cannot receive a test');
  assert.equal(controller.sent.length, 0);
});

test('a transport/send failure resolves to ok:false (nothing thrown, nothing persisted)', async () => {
  const db = makeFakePrisma();
  const fake = makeFakeSmtpService();
  const controller = new FailingSmtpController(fake.service, db.prisma);

  db.seedUser({ id: 'admin-7', email: 'a7@example.com', role: 'admin', allowed: true });
  const req = principalRequest(sessionPrincipal('admin-7'));

  const result = await controller.test(req, {
    host: 'smtp.resend.com',
    port: 465,
    user: 'resend',
    pass: 're_x',
    from: 'noreply@example.com',
  } as TestSmtpConfigRequest);

  assert.equal(result.ok, false, 'a send failure is surfaced, not thrown');
  assert.match(result.message, /failed/i, 'the failure carries a readable message');
  assert.equal(fake.row(), null, 'a failed test persists nothing');
});
