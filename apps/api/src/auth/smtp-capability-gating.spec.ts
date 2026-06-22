/**
 * Minimal test for requirement: SMTP delivery and capability gating
 * (add-private-account-identity, email-otp-login spec)
 *
 * Spec: "When SMTP is not configured, the OTP login method SHALL be reported as
 * unavailable through the backend capability flags so the console hides it, and
 * the OTP request endpoint SHALL fail closed."
 * Spec: "When SMTP is configured and a valid OTP request arrives, the code is sent
 * via the configured SMTP transport and the capability flag for OTP is true."
 *
 * Exercises end-to-end without a DB or NestJS container:
 *   S1 — SMTP unconfigured → isOtpAuthEnabled()=false + OtpController returns 404
 *   S2 — SMTP configured   → isOtpAuthEnabled()=true  + OtpController calls sendMail
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isOtpAuthEnabled } from '../auth/oauth-config';
import { MailService } from '../mail/mail.service';
import { EmailOtpService } from '../auth-otp/email-otp.service';
import { OtpController } from '../auth-otp/otp.controller';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Fake MailService — tracks sendMail calls, toggleable configured state
// ---------------------------------------------------------------------------

function makeFakeMail(configured: boolean): {
  mail: MailService;
  sent: { to: string; subject: string; text: string }[];
} {
  const sent: { to: string; subject: string; text: string }[] = [];
  const mail = {
    isConfigured: () => configured,
    sendMail: async (message: { to: string; subject: string; text: string }) => {
      if (!configured) throw new Error('SMTP not configured');
      sent.push(message);
    },
  } as unknown as MailService;
  return { mail, sent };
}

// ---------------------------------------------------------------------------
// Fake Prisma — minimal stubs for the OTP service
// ---------------------------------------------------------------------------

function makeFakePrisma(userEmail: string | null): PrismaService {
  const user = userEmail
    ? {
        id: 'u-1',
        githubId: null,
        login: 'alice',
        name: 'Alice',
        avatarUrl: null,
        allowed: true,
        email: userEmail,
        role: 'member' as const,
        mustChangePassword: false,
      }
    : null;
  const otpRows: { id: string; email: string; codeHash: string; expiresAt: Date; consumedAt: Date | null; attempts: number; createdAt: Date }[] = [];
  let seq = 0;
  return {
    user: {
      findUnique: async ({ where }: { where: { email?: string } }) =>
        user && user.email === where.email ? user : null,
    },
    emailOtp: {
      create: async ({ data }: { data: { email: string; codeHash: string; expiresAt: Date; attempts: number } }) => {
        seq += 1;
        const row = { id: `otp-${seq}`, consumedAt: null, createdAt: new Date(), ...data };
        otpRows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: { email?: string; consumedAt?: null; expiresAt?: { gt?: Date } } }) => {
        const now = new Date();
        return (
          otpRows.find(
            (r) =>
              r.email === where.email &&
              r.consumedAt === null &&
              r.expiresAt.getTime() > (where.expiresAt?.gt ?? now).getTime(),
          ) ?? null
        );
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<{ consumedAt: Date; attempts: number }> }) => {
        const row = otpRows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    session: {
      create: async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        seq += 1;
        return { id: `s-${seq}`, ...data };
      },
    },
  } as unknown as PrismaService;
}

// ---------------------------------------------------------------------------
// Fake Express Response for OtpController
// ---------------------------------------------------------------------------

function makeFakeRes(): {
  res: { status: (code: number) => { json: (body: unknown) => void } };
  captured: { statusCode: number; body: unknown } | null;
} {
  let captured: { statusCode: number; body: unknown } | null = null;
  const res = {
    status: (code: number) => ({
      json: (body: unknown) => {
        captured = { statusCode: code, body };
      },
    }),
  };
  // Also support chained .setHeader (verify path) — minimal stub
  (res as unknown as Record<string, unknown>).setHeader = () => res;
  return {
    res: res as unknown as { status: (code: number) => { json: (body: unknown) => void } },
    get captured() {
      return captured;
    },
  };
}

// ---------------------------------------------------------------------------
// S1: SMTP unconfigured → capability flag false + endpoint fails closed (404)
// ---------------------------------------------------------------------------

test('S1: isOtpAuthEnabled returns false when SMTP vars are absent', () => {
  // Use an empty env (no SMTP vars set at all).
  const emptyEnv: NodeJS.ProcessEnv = {};
  assert.equal(isOtpAuthEnabled(emptyEnv), false, 'capability flag must be false with no SMTP vars');
});

test('S1: OtpController.request returns 404 when SMTP is unconfigured', async () => {
  const { mail } = makeFakeMail(false);
  const prisma = makeFakePrisma('alice@example.com');
  const otp = new EmailOtpService(prisma, mail);
  const controller = new OtpController(otp, mail);

  const fakeRes = makeFakeRes();
  await controller.request(
    { email: 'alice@example.com' },
    fakeRes.res as unknown as import('express').Response,
  );

  assert.ok(fakeRes.captured !== null, 'controller must call res.status().json()');
  assert.equal(fakeRes.captured!.statusCode, 404, 'must fail closed with 404 when SMTP is unconfigured');
  const body = fakeRes.captured!.body as { error?: string };
  assert.ok(
    typeof body.error === 'string' && body.error.toLowerCase().includes('not available'),
    `error body should describe OTP unavailability, got: ${JSON.stringify(body)}`,
  );
});

// ---------------------------------------------------------------------------
// S2: SMTP configured → capability flag true + sendMail is called
// ---------------------------------------------------------------------------

test('S2: isOtpAuthEnabled returns true when all five SMTP vars are present and port is valid', () => {
  const fullSmtpEnv: NodeJS.ProcessEnv = {
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_USER: 'user@example.com',
    SMTP_PASS: 'secret',
    SMTP_FROM: 'noreply@example.com',
  };
  assert.equal(isOtpAuthEnabled(fullSmtpEnv), true, 'capability flag must be true with all five SMTP vars');
});

test('S2: EmailOtpService.requestCode delivers via sendMail when SMTP is configured', async () => {
  const { mail, sent } = makeFakeMail(true);
  const prisma = makeFakePrisma('alice@example.com');
  const service = new EmailOtpService(prisma, mail);

  await service.requestCode('alice@example.com');

  assert.equal(sent.length, 1, 'sendMail must be called exactly once for a configured SMTP');
  assert.equal(sent[0].to, 'alice@example.com', 'mail must be addressed to the requesting user');
  const codeMatch = sent[0].text.match(/\b(\d{6})\b/);
  assert.ok(codeMatch, 'email body must contain a 6-digit verification code');
});
