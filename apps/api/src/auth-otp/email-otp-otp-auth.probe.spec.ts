/**
 * Minimal ground-truth probe: "Email verification-code (OTP) authentication"
 * requirement from add-private-account-identity / email-otp-login capability.
 *
 * Exercises the PRIMARY scenario end-to-end using the service directly
 * (no DI container, no DB, no SMTP) — same pattern as the shipped unit spec.
 *
 * Scenarios:
 *   A. Happy path: requestCode → verifyCode → session minted + code consumed
 *   B. Wrong code → null, no session; correct code still works after one miss
 *   C. Expired code → null, no session
 *   D. SMTP off → requestCode is a no-op; verifyCode cannot succeed
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { EmailOtpService, hashOtpCode } from './email-otp.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import { hashSessionToken } from '../auth/session-token';

// ---------------------------------------------------------------------------
// In-memory fakes (no database, no SMTP)
// ---------------------------------------------------------------------------

const ALICE_EMAIL = 'alice@otp-probe.example';
const ALICE = {
  id: 'probe-user-1',
  githubId: 1001 as number | null,
  login: 'alice',
  name: 'Alice Probe',
  avatarUrl: null as string | null,
  allowed: true,
  role: 'member' as const,
  mustChangePassword: false,
  email: ALICE_EMAIL,
};

interface OtpRow {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

function makeFakes(smtpOn: boolean = true): {
  service: EmailOtpService;
  otpRows: OtpRow[];
  sessions: SessionRow[];
  sent: { to: string; text: string }[];
} {
  const otpRows: OtpRow[] = [];
  const sessions: SessionRow[] = [];
  const sent: { to: string; text: string }[] = [];
  let seq = 0;

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { email?: string } }) =>
        [ALICE].find((u) => u.email === where.email) ?? null,
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
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { email?: string; consumedAt?: null; expiresAt?: { gt?: Date } };
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const matched = otpRows.filter((r) => {
          if (where.email !== undefined && r.email !== where.email) return false;
          if (where.consumedAt === null && r.consumedAt !== null) return false;
          if (where.expiresAt?.gt !== undefined && !(r.expiresAt.getTime() > where.expiresAt.gt.getTime()))
            return false;
          return true;
        });
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

  const mail = {
    isConfigured: () => smtpOn,
    sendMail: async (msg: { to: string; subject: string; text: string }) => {
      if (!smtpOn) throw new Error('SMTP not configured');
      sent.push({ to: msg.to, text: msg.text });
    },
  } as unknown as MailService;

  const service = new EmailOtpService(prisma, mail);
  return { service, otpRows, sessions, sent };
}

/** Extracts the 6-digit code from the email body. */
function extractCode(text: string): string {
  const m = text.match(/\b(\d{6})\b/);
  assert.ok(m, `no 6-digit code in: ${text}`);
  return m![1];
}

// ---------------------------------------------------------------------------
// A. Happy path
// ---------------------------------------------------------------------------

test('A: requestCode → verifyCode mints a session and consumes the code', async () => {
  const { service, otpRows, sessions, sent } = makeFakes(true);

  // Step 1: issue a code
  await service.requestCode(ALICE_EMAIL);
  assert.equal(otpRows.length, 1, 'one code row persisted');
  assert.equal(sent.length, 1, 'one email sent');

  const code = extractCode(sent[0].text);

  // Plaintext MUST NOT be stored — only the hash
  assert.notEqual(otpRows[0].codeHash, code, 'plaintext code never stored');
  assert.equal(otpRows[0].codeHash, hashOtpCode(code), 'stored hash matches the sent code');
  assert.ok(otpRows[0].expiresAt.getTime() > Date.now(), 'expiry is in the future');
  assert.equal(otpRows[0].consumedAt, null, 'code not yet consumed');

  // Step 2: verify the code → session minted
  const result = await service.verifyCode(ALICE_EMAIL, code);
  assert.ok(result !== null, 'valid code mints a session');
  assert.equal(result!.user.allowed, true, 'returned user is allowed');

  // Session row stores the HASH of the raw token, never the raw token itself
  assert.equal(sessions.length, 1, 'one session row created');
  assert.equal(sessions[0].tokenHash, hashSessionToken(result!.token), 'session stores token hash');
  assert.notEqual(sessions[0].tokenHash, result!.token, 'raw token not stored in DB');

  // Code is consumed — no replay
  assert.ok(otpRows[0].consumedAt !== null && typeof otpRows[0].consumedAt === 'object', 'code marked consumed');
  const replay = await service.verifyCode(ALICE_EMAIL, code);
  assert.equal(replay, null, 'consumed code cannot be replayed');
  assert.equal(sessions.length, 1, 'no second session minted on replay');
});

// ---------------------------------------------------------------------------
// B. Wrong code → null, no session; correct code still works after one miss
// ---------------------------------------------------------------------------

test('B: wrong code returns null; correct code succeeds after one failed attempt', async () => {
  const { service, otpRows, sessions, sent } = makeFakes(true);

  await service.requestCode(ALICE_EMAIL);
  const code = extractCode(sent[0].text);
  const wrong = code === '000000' ? '111111' : '000000';

  const bad = await service.verifyCode(ALICE_EMAIL, wrong);
  assert.equal(bad, null, 'wrong code returns null');
  assert.equal(sessions.length, 0, 'no session on wrong code');
  assert.equal(otpRows[0].attempts, 1, 'wrong attempt increments counter');

  // One wrong attempt is below the cap — correct code still works
  const good = await service.verifyCode(ALICE_EMAIL, code);
  assert.ok(good !== null, 'correct code mints a session after one wrong attempt');
});

// ---------------------------------------------------------------------------
// C. Expired code → null
// ---------------------------------------------------------------------------

test('C: expired code returns null without minting a session', async () => {
  const { service, otpRows, sessions } = makeFakes(true);

  const code = '654321';
  otpRows.push({
    id: 'otp-expired',
    email: ALICE_EMAIL,
    codeHash: hashOtpCode(code),
    expiresAt: new Date(Date.now() - 1000), // 1 second in the past
    consumedAt: null,
    attempts: 0,
    createdAt: new Date(),
  });

  const result = await service.verifyCode(ALICE_EMAIL, code);
  assert.equal(result, null, 'expired code does not establish a session');
  assert.equal(sessions.length, 0, 'no session row created for expired code');
});

// ---------------------------------------------------------------------------
// D. SMTP off — fail closed
// ---------------------------------------------------------------------------

test('D: SMTP unconfigured → requestCode is a no-op; verifyCode cannot succeed', async () => {
  const { service, otpRows, sent } = makeFakes(false);

  await service.requestCode(ALICE_EMAIL);
  assert.equal(otpRows.length, 0, 'no code stored when SMTP is unconfigured');
  assert.equal(sent.length, 0, 'no email sent when SMTP is unconfigured');

  // No code was issued, so verifyCode cannot succeed
  const result = await service.verifyCode(ALICE_EMAIL, '123456');
  assert.equal(result, null, 'verifyCode returns null when no code was issued');
});
