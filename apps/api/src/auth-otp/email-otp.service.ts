import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import type { SessionUser } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { renderOtpEmail } from './otp-email-template';
import {
  mintSessionToken,
  sessionExpiryFrom,
  type MintedSessionToken,
} from '../auth/session-token';

/** Number of decimal digits in an emailed verification code. */
const OTP_DIGITS = 6;

/** Code lifetime: a short window so a leaked/forwarded code expires fast. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** Resend cooldown: a fresh code for the same email is refused inside this window. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Wrong-code attempt cap. After this many failed verifies against a single code
 * the code is treated as spent (further attempts fail even with the right value),
 * bounding online guessing of the 6-digit space.
 */
export const OTP_MAX_ATTEMPTS = 5;

/**
 * Email verification-code (OTP) service (add-private-account-identity,
 * tasks 5.2 / 5.3).
 *
 * Implements passwordless login by emailed code for an `allowed` account that has
 * a stored, verified `email`. The two public operations mirror the request/verify
 * split:
 *  - {@link requestCode}: resolve the email to an allowed account, enforce the
 *    resend cooldown, generate a single-use numeric code, persist ONLY its hash
 *    with a short expiry, and email the code. UNIFORM + NON-DISCLOSING: an
 *    unknown/disallowed/email-less account is indistinguishable from success (no
 *    code sent, no account created).
 *  - {@link verifyCode}: match the presented code against the stored hash, reject
 *    expired/consumed/over-attempt codes, mark the code consumed (single-use,
 *    no replay), and mint a session for the owning account.
 *
 * Storage discipline (hash-at-rest) — the load-bearing secret property: the
 * plaintext code is emailed exactly once and NEVER stored. Only its SHA-256 hash
 * is persisted (same discipline as session tokens / API keys); a database read
 * can never recover a usable code. A plain SHA-256 is used deliberately — the
 * online attempt cap + short TTL, not hash slowness, bound guessing of the
 * low-entropy 6-digit value.
 */
@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /**
   * Issues a verification code for `rawEmail` when it resolves to an allowed
   * account with a stored email — otherwise a silent no-op so the caller's
   * response stays uniform (spec "Request for an unknown email reveals nothing").
   *
   * On the issuing path:
   *   1. enforce the 60s resend cooldown (a still-fresh unconsumed code blocks a
   *      new one — drains a resend-spam vector and caps issuance);
   *   2. generate a 6-digit code, persist ONLY its hash with a {@link OTP_TTL_MS}
   *      expiry;
   *   3. email the plaintext code (fail closed if SMTP is unconfigured — checked
   *      by the controller before calling, and again here defensively).
   *
   * Never throws to disclose account existence: a send/DB error is logged, not
   * surfaced to the unauthenticated caller (the controller keeps its response
   * uniform regardless).
   */
  async requestCode(rawEmail: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const email = normalizeEmail(rawEmail);
    if (!email) {
      return; // malformed input → behave like an unknown email (uniform).
    }

    // Fail closed when SMTP is unconfigured: never pretend a code went out.
    if (!(await this.mail.isConfigured(env))) {
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Resolve ONLY to an allowed account with a stored email — never create one.
    if (!user || !user.allowed) {
      return;
    }

    const now = new Date();

    // Resend cooldown: a recent, still-valid, unconsumed code blocks a new issue.
    const recent = await this.prisma.emailOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent && now.getTime() - recent.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      return; // within cooldown — silently decline a fresh code.
    }

    const code = generateNumericCode();
    await this.prisma.emailOtp.create({
      data: {
        email,
        codeHash: hashOtpCode(code),
        expiresAt: new Date(now.getTime() + OTP_TTL_MS),
        attempts: 0,
      },
    });

    try {
      const { subject, html, text } = renderOtpEmail({
        code,
        ttlMinutes: OTP_TTL_MS / 60_000,
      });
      await this.mail.sendMail({ to: email, subject, html, text }, env);
    } catch (error) {
      // Surface the delivery failure to the operator (logs) but do NOT leak it to
      // the unauthenticated requester — the controller's response is uniform.
      this.logger.error(`OTP email send failed for an allowed account: ${String(error)}`);
    }
  }

  /**
   * Verifies a presented code for `rawEmail` and, on success, mints a session for
   * the owning allowed account; returns `null` on ANY failure (unknown email,
   * disallowed account, no matching unconsumed/unexpired code, wrong value,
   * attempt cap reached) so the controller can return a single uniform failure.
   *
   * Single-use + anti-replay: the latest unconsumed, unexpired code is selected;
   * a wrong value increments `attempts` (capping online guessing); a correct
   * value marks the code `consumedAt` in the SAME path before the session is
   * minted, so the code can never be replayed.
   */
  async verifyCode(
    rawEmail: string,
    code: string,
  ): Promise<{ token: string; user: SessionUser } | null> {
    const email = normalizeEmail(rawEmail);
    if (!email || typeof code !== 'string' || code.length === 0) {
      return null;
    }

    const now = new Date();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.allowed) {
      return null;
    }

    // Newest unconsumed, unexpired code for this email.
    const otp = await this.prisma.emailOtp.findFirst({
      where: { email, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) {
      return null;
    }

    // Attempt cap: an over-budget code is spent regardless of the presented value.
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      return null;
    }

    if (hashOtpCode(code) !== otp.codeHash) {
      // Wrong value: charge an attempt so the 6-digit space can't be brute-forced.
      await this.prisma.emailOtp.update({
        where: { id: otp.id },
        data: { attempts: otp.attempts + 1 },
      });
      return null;
    }

    // Correct: consume the code FIRST (single-use, no replay) then mint a session.
    await this.prisma.emailOtp.update({
      where: { id: otp.id },
      data: { consumedAt: now },
    });

    const minted: MintedSessionToken = mintSessionToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: minted.tokenHash,
        expiresAt: sessionExpiryFrom(),
      },
    });

    return {
      token: minted.token,
      user: {
        githubId: user.githubId,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        allowed: true,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }
}

/**
 * Hashes a plaintext OTP code into its stored representation. Plain SHA-256 —
 * same discipline as session tokens; the short TTL + attempt cap bound guessing,
 * not hash slowness.
 */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Generates a zero-padded {@link OTP_DIGITS}-digit numeric code using a CSPRNG. */
function generateNumericCode(): string {
  const max = 10 ** OTP_DIGITS;
  return String(randomInt(0, max)).padStart(OTP_DIGITS, '0');
}

/**
 * Normalises an email for lookup/storage: trims and lowercases, returns `null`
 * for anything without a single `@` separating non-empty local/domain parts.
 * Deliberately conservative — a malformed value behaves like an unknown email.
 */
export function normalizeEmail(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) {
    return null;
  }
  return trimmed;
}
