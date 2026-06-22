/**
 * Tests for the email verification-code (OTP) service (add-private-account-identity,
 * task 5.4).
 *
 * Asserts the load-bearing OTP requirements end-to-end against an in-memory Prisma
 * fake + a fake MailService (no DB, no SMTP, no DI container) so it runs under
 * `pnpm test` (nest build → node --test dist/**\/*.spec.js):
 *   1. ISSUE — a request for an allowed account with a stored email persists ONLY
 *      a code hash (never plaintext) with a short expiry and sends one email.
 *   2. VERIFY HAPPY PATH — the matching code mints a session and is marked
 *      consumed; re-submitting the same code fails (single-use, no replay).
 *   3. EXPIRED / CONSUMED / WRONG — none of these establish a session; a wrong
 *      value charges an attempt and the attempt cap spends the code.
 *   4. UNKNOWN EMAIL — request is a uniform no-op (no code stored, no mail sent,
 *      no account created) and verify returns null.
 *   5. SMTP OFF — fail closed: request issues nothing and verify never succeeds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EmailOtpService,
  hashOtpCode,
  normalizeEmail,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
} from './email-otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { hashSessionToken } from '../auth/session-token';

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const ALLOWED_EMAIL = 'alice@example.com';
const ALLOWED_USER = {
  id: '00000000-0000-4000-a000-000000000001',
  githubId: 4242,
  login: 'alice',
  name: 'Alice',
  avatarUrl: 'https://example.com/a.png',
  allowed: true,
  email: ALLOWED_EMAIL,
};

const DISALLOWED_EMAIL = 'mallory@example.com';
const DISALLOWED_USER = { ...ALLOWED_USER, id: 'u-2', githubId: 9, allowed: false, email: DISALLOWED_EMAIL };

interface OtpRow {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

/** The subset of the `emailOtp` where-clause this fake matches against. */
interface OtpWhere {
  email?: string;
  consumedAt?: Date | null;
  expiresAt?: { gt?: Date };
}

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

type UserRecord = typeof ALLOWED_USER;

/** Minimal in-memory fake Prisma covering the `user`, `emailOtp`, `session` delegates. */
function makeFakePrisma(users: UserRecord[]): {
  prisma: PrismaService;
  otpRows: OtpRow[];
  sessions: SessionRow[];
} {
  const otpRows: OtpRow[] = [];
  const sessions: SessionRow[] = [];
  let seq = 0;

  const matchesOtpWhere = (row: OtpRow, where: OtpWhere): boolean => {
    if (where.email !== undefined && row.email !== where.email) return false;
    if (where.consumedAt === null && row.consumedAt !== null) return false;
    if (where.expiresAt?.gt !== undefined && !(row.expiresAt.getTime() > where.expiresAt.gt.getTime()))
      return false;
    return true;
  };

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { email?: string } }) =>
        users.find((u) => u.email === where.email) ?? null,
    },
    emailOtp: {
      create: async ({ data }: { data: Omit<OtpRow, 'id' | 'createdAt' | 'consumedAt'> & { consumedAt?: Date | null } }) => {
        seq += 1;
        const row: OtpRow = {
          id: `otp-${seq}`,
          email: data.email,
          codeHash: data.codeHash,
          expiresAt: data.expiresAt,
          consumedAt: data.consumedAt ?? null,
          attempts: data.attempts ?? 0,
          createdAt: new Date(Date.now() + seq),
        };
        otpRows.push(row);
        return row;
      },
      findFirst: async ({ where, orderBy }: { where: OtpWhere; orderBy?: { createdAt?: 'asc' | 'desc' } }) => {
        const matched = otpRows.filter((r) => matchesOtpWhere(r, where));
        matched.sort((a, b) =>
          orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return matched[0] ?? null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<OtpRow> }) => {
        const row = otpRows.find((r) => r.id === where.id);
        if (!row) throw new Error(`no otp row ${where.id}`);
        Object.assign(row, data);
        return row;
      },
    },
    session: {
      create: async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        seq += 1;
        const row: SessionRow = { id: `s-${seq}`, ...data };
        sessions.push(row);
        return row;
      },
    },
  } as unknown as PrismaService;

  return { prisma, otpRows, sessions };
}

/** Fake MailService recording sent messages; `configured` toggles the capability. */
function makeFakeMail(configured: boolean): { mail: MailService; sent: { to: string; text: string }[] } {
  const sent: { to: string; text: string }[] = [];
  const mail = {
    isConfigured: () => configured,
    sendMail: async (message: { to: string; subject: string; text: string }) => {
      if (!configured) throw new Error('SMTP not configured');
      sent.push({ to: message.to, text: message.text });
    },
  } as unknown as MailService;
  return { mail, sent };
}

/** Extracts the 6-digit code embedded in a sent OTP email body. */
function codeFromEmail(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  assert.ok(match, `expected a 6-digit code in: ${text}`);
  return match![1];
}

// ---------------------------------------------------------------------------
// normalizeEmail (pure)
// ---------------------------------------------------------------------------

test('normalizeEmail trims + lowercases, rejects malformed', () => {
  assert.equal(normalizeEmail('  Alice@Example.com '), 'alice@example.com');
  assert.equal(normalizeEmail('no-at-sign'), null);
  assert.equal(normalizeEmail('@nolocal.com'), null);
  assert.equal(normalizeEmail('trailing@'), null);
  assert.equal(normalizeEmail('two@@ats.com'), null);
  assert.equal(normalizeEmail(undefined), null);
});

// ---------------------------------------------------------------------------
// 1. ISSUE — hash-at-rest, expiry, one email
// ---------------------------------------------------------------------------

test('requestCode issues a hashed code with expiry and sends one email', async () => {
  const { prisma, otpRows } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(ALLOWED_EMAIL);

  assert.equal(otpRows.length, 1, 'one code row persisted');
  assert.equal(sent.length, 1, 'one email sent');
  const code = codeFromEmail(sent[0].text);
  // Plaintext is NEVER stored — only its hash, and the hash matches the sent code.
  assert.notEqual(otpRows[0].codeHash, code);
  assert.equal(otpRows[0].codeHash, hashOtpCode(code));
  assert.ok(otpRows[0].expiresAt.getTime() > Date.now(), 'expiry is in the future');
  assert.equal(otpRows[0].consumedAt, null);
});

// ---------------------------------------------------------------------------
// 2. VERIFY HAPPY PATH — mint session + single-use (no replay)
// ---------------------------------------------------------------------------

test('verifyCode mints a session and consumes the code (no replay)', async () => {
  const { prisma, otpRows, sessions } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(ALLOWED_EMAIL);
  const code = codeFromEmail(sent[0].text);

  const result = await service.verifyCode(ALLOWED_EMAIL, code);
  assert.ok(result, 'a valid code mints a session');
  assert.equal(result!.user.githubId, ALLOWED_USER.githubId);
  assert.equal(result!.user.allowed, true);
  assert.equal(sessions.length, 1, 'a session row was created');
  // The session stores the HASH of the returned raw token, never the raw token.
  assert.equal(sessions[0].tokenHash, hashSessionToken(result!.token));
  assert.notEqual(sessions[0].tokenHash, result!.token);
  assert.ok(otpRows[0].consumedAt instanceof Date, 'code marked consumed');

  // Replay the SAME code → rejected (consumed), no second session.
  const replay = await service.verifyCode(ALLOWED_EMAIL, code);
  assert.equal(replay, null, 'a consumed code cannot be replayed');
  assert.equal(sessions.length, 1, 'no second session minted');
});

// ---------------------------------------------------------------------------
// 3. EXPIRED / WRONG / ATTEMPT-CAP
// ---------------------------------------------------------------------------

test('verifyCode rejects an expired code', async () => {
  const { prisma, otpRows, sessions } = makeFakePrisma([ALLOWED_USER]);
  const { mail } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  // Inject an already-expired code directly.
  const code = '123456';
  otpRows.push({
    id: 'otp-expired',
    email: ALLOWED_EMAIL,
    codeHash: hashOtpCode(code),
    expiresAt: new Date(Date.now() - 1000),
    consumedAt: null,
    attempts: 0,
    createdAt: new Date(),
  });

  const result = await service.verifyCode(ALLOWED_EMAIL, code);
  assert.equal(result, null, 'expired code does not establish a session');
  assert.equal(sessions.length, 0);
});

test('verifyCode rejects a wrong code, charges an attempt, and caps guessing', async () => {
  const { prisma, otpRows, sessions } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(ALLOWED_EMAIL);
  const realCode = codeFromEmail(sent[0].text);
  const wrong = realCode === '000000' ? '111111' : '000000';

  // Burn the attempt budget with wrong values.
  for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
    const r = await service.verifyCode(ALLOWED_EMAIL, wrong);
    assert.equal(r, null, 'wrong code never establishes a session');
  }
  assert.equal(otpRows[0].attempts, OTP_MAX_ATTEMPTS, 'each wrong try charges an attempt');

  // Even the CORRECT code now fails — the code is spent by the attempt cap.
  const afterCap = await service.verifyCode(ALLOWED_EMAIL, realCode);
  assert.equal(afterCap, null, 'attempt cap spends the code');
  assert.equal(sessions.length, 0);
});

// ---------------------------------------------------------------------------
// 4. UNKNOWN / DISALLOWED EMAIL — uniform no-op
// ---------------------------------------------------------------------------

test('requestCode for an unknown email is a no-op (nothing stored, nothing sent)', async () => {
  const { prisma, otpRows } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode('nobody@example.com');

  assert.equal(otpRows.length, 0, 'no code stored for an unknown email');
  assert.equal(sent.length, 0, 'no email sent for an unknown email');
});

test('requestCode for a disallowed account is a no-op', async () => {
  const { prisma, otpRows } = makeFakePrisma([DISALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(DISALLOWED_EMAIL);

  assert.equal(otpRows.length, 0, 'no code stored for a disallowed account');
  assert.equal(sent.length, 0, 'no email sent for a disallowed account');
});

test('verifyCode for an unknown email returns the uniform null failure', async () => {
  const { prisma, sessions } = makeFakePrisma([ALLOWED_USER]);
  const { mail } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  const result = await service.verifyCode('nobody@example.com', '123456');
  assert.equal(result, null);
  assert.equal(sessions.length, 0);
});

// ---------------------------------------------------------------------------
// Resend cooldown
// ---------------------------------------------------------------------------

test('requestCode honours the resend cooldown', async () => {
  const { prisma, otpRows } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(true);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(ALLOWED_EMAIL);
  assert.equal(otpRows.length, 1);

  // A second request immediately after is declined within the cooldown window.
  await service.requestCode(ALLOWED_EMAIL);
  assert.equal(otpRows.length, 1, 'no fresh code inside the cooldown');
  assert.equal(sent.length, 1, 'no second email inside the cooldown');

  // Backdate the existing code past the cooldown → a fresh code issues.
  otpRows[0].createdAt = new Date(Date.now() - OTP_RESEND_COOLDOWN_MS - 1000);
  await service.requestCode(ALLOWED_EMAIL);
  assert.equal(otpRows.length, 2, 'a fresh code issues after the cooldown');
  assert.equal(sent.length, 2);
});

// ---------------------------------------------------------------------------
// 5. SMTP OFF — fail closed
// ---------------------------------------------------------------------------

test('requestCode is a no-op when SMTP is unconfigured (fail closed)', async () => {
  const { prisma, otpRows } = makeFakePrisma([ALLOWED_USER]);
  const { mail, sent } = makeFakeMail(false);
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode(ALLOWED_EMAIL);

  assert.equal(otpRows.length, 0, 'no code issued when SMTP is off');
  assert.equal(sent.length, 0, 'no email sent when SMTP is off');
});
