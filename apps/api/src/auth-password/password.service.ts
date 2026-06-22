import { Injectable } from '@nestjs/common';
import type { SessionUser } from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword, verifyPassword } from '../auth/argon2';
import { normalizeEmail } from '../auth-otp/email-otp.service';
import {
  hashSessionToken,
  isSessionExpired,
  mintSessionToken,
  sessionExpiryFrom,
  type MintedSessionToken,
} from '../auth/session-token';

/** The fixed provider discriminator for a local email+password login identity. */
const PASSWORD_IDENTITY_PROVIDER = 'password' as const;

/** The User columns this service projects into a {@link SessionUser}. */
interface AccountRow {
  githubId: number | null;
  login: string | null;
  name: string;
  avatarUrl: string | null;
  allowed: boolean;
  role: 'admin' | 'member';
  mustChangePassword: boolean;
}

/**
 * Email + password authentication service (add-private-account-identity,
 * tasks 4.1 / 4.2; `password-login`).
 *
 * Two operations, both fail-closed:
 *  - {@link verifyAndMint}: resolve an account by email → verify the presented
 *    password against the argon2 hash on its `password` `IdentityLink` → require
 *    `allowed` → mint a session. Returns `null` on ANY failure (unknown email, no
 *    password identity, wrong password, disallowed) so the controller can answer a
 *    single UNIFORM generic failure that discloses nothing and never auto-creates
 *    an account (there is no public registration).
 *  - {@link changePassword}: authenticated by the active SESSION (the operator just
 *    logged in with the temporary credential), set a new argon2 hash, clear
 *    `mustChangePassword`, and rotate the identity secret so the prior temporary
 *    credential no longer verifies. An optional `currentPassword` is verified as an
 *    extra check when supplied (the forced first-login dialog omits it — the valid
 *    session is the proof of identity).
 *
 * The password identity is located by `(userId, provider="password")` rather than
 * by `providerAccountId`, so a verify is robust to how the email was normalised at
 * storage time; lookups normalise the email the same way the OTP path and account
 * creation do, so storage and lookup agree.
 */
@Injectable()
export class PasswordAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verifies an email+password pair and, on success, mints a session for the
   * `allowed` account; returns `null` on every failure path so the caller returns
   * one uniform, non-disclosing rejection.
   */
  async verifyAndMint(
    rawEmail: string,
    password: string,
  ): Promise<{ token: string; user: SessionUser } | null> {
    const email = normalizeEmail(rawEmail);
    if (!email || typeof password !== 'string' || password.length === 0) {
      return null;
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    // Resolve ONLY to an allowed account — never create one (no registration).
    if (!user || !user.allowed) {
      return null;
    }

    const identity = await this.prisma.identityLink.findFirst({
      where: { userId: user.id, provider: PASSWORD_IDENTITY_PROVIDER },
      select: { secret: true },
    });
    if (!identity?.secret) {
      return null;
    }

    const ok = await verifyPassword(identity.secret, password);
    if (!ok) {
      return null;
    }

    const minted: MintedSessionToken = mintSessionToken();
    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: minted.tokenHash,
        expiresAt: sessionExpiryFrom(),
      },
    });

    return { token: minted.token, user: toSessionUser(user) };
  }

  /**
   * Changes the current account's password (authenticated by the active session),
   * rotates the `password` identity secret, and clears `mustChangePassword`.
   * Returns the refreshed {@link SessionUser} on success, or `null` when the
   * session is invalid/expired/disallowed, the account has no email to key the
   * identity on, or an optional `currentPassword` is supplied but does not verify.
   */
  async changePassword(
    sessionToken: string | undefined | null,
    currentPassword: string | undefined,
    newPassword: string,
  ): Promise<SessionUser | null> {
    if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
      return null;
    }
    const session = await this.prisma.session.findFirst({
      where: { tokenHash: hashSessionToken(sessionToken) },
      include: { user: true },
    });
    if (!session || isSessionExpired(session.expiresAt) || !session.user.allowed) {
      return null;
    }
    const user = session.user;
    if (!user.email) {
      // A password identity is keyed on the email; an account without one cannot
      // hold a password credential.
      return null;
    }

    const identity = await this.prisma.identityLink.findFirst({
      where: { userId: user.id, provider: PASSWORD_IDENTITY_PROVIDER },
      select: { secret: true },
    });
    if (currentPassword && identity?.secret) {
      const ok = await verifyPassword(identity.secret, currentPassword);
      if (!ok) {
        return null;
      }
    }

    const secret = await hashPassword(newPassword);
    // Rotate (or create) the password identity so the prior temp credential dies.
    await this.prisma.identityLink.upsert({
      where: {
        provider_providerAccountId: {
          provider: PASSWORD_IDENTITY_PROVIDER,
          providerAccountId: user.email,
        },
      },
      create: {
        userId: user.id,
        provider: PASSWORD_IDENTITY_PROVIDER,
        providerAccountId: user.email,
        secret,
      },
      update: { userId: user.id, secret },
    });
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { mustChangePassword: false },
    });
    return toSessionUser(updated);
  }
}

/** Projects an account row into the session-user shape the console renders. */
function toSessionUser(u: AccountRow): SessionUser {
  return {
    githubId: u.githubId,
    login: u.login,
    name: u.name,
    avatarUrl: u.avatarUrl,
    allowed: u.allowed,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
  };
}
