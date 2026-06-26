import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from '../auth/argon2';

/**
 * Admin-only account-lifecycle service (account-administration, tasks 7.1 / 7.2).
 *
 * Owns the OPERATOR-facing management side of the account model the rest of the
 * change introduces (local-account-identity): a provider-agnostic `User` plus one
 * `IdentityLink` row per login identity. This service is reached EXCLUSIVELY by an
 * `admin`-role principal — the controller resolves the caller's role from the DB
 * (fail-closed) and 403s every non-admin BEFORE any method here runs, so a `member`
 * (or scopeless machine) principal can never create, mutate, or even list accounts.
 *
 * Load-bearing properties:
 *   - NO PUBLIC REGISTRATION — accounts are born ONLY here (admin create), in the
 *     default-admin seed; {@link create} is the only
 *     write path and it always sets `allowed = true` (account-administration:
 *     "Creating a local account SHALL set allowed = true").
 *   - PASSWORD HASH-ONLY — a `password` identity stores the argon2 hash as its
 *     `IdentityLink.secret`; the plaintext password is never persisted and never
 *     returned. The hash is produced by the shared auth-core argon2 util so a
 *     locally-created credential verifies on the password-login path.
 *   - DISABLE = REVOKE — {@link setEnabled} flips `User.allowed`, the SINGLE
 *     runtime gate (local-account-identity D2). It applies to every account row
 *     and takes effect on the next request. It NEVER touches identity secrets.
 *   - NO DISCLOSURE LEAK — list/read shapes carry only non-secret metadata; an
 *     `IdentityLink.secret` (argon2 hash or legacy token) is never
 *     projected into a response.
 */
@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a local account from the admin flow. Always sets `allowed = true`
   * (account-administration). The `initialCredential` choice decides the identity:
   *   - `'password'` -> store an argon2 hash as a `password` `IdentityLink` secret
   *     and flag `mustChangePassword = true`, so the admin-set credential is a
   *     one-time temporary one the owner must replace on first login;
   *   - `'otp-only'` -> create NO password identity; the account logs in by email
   *     verification code once SMTP is configured.
   *
   * There is NO upsert/merge: a duplicate email (the `@unique` handle) is rejected
   * rather than silently mutating an existing account. The plaintext password is
   * hashed here and never persisted or returned.
   */
  async create(input: CreateAccountInput): Promise<AccountListItem> {
    const email = normalizeEmail(input.email);

    if (input.initialCredential === 'password' && !input.password) {
      // The DTO refinement already enforces this; guard defensively so a malformed
      // call can never create an account with a missing credential.
      throw new BadRequestException(
        'A password is required when initialCredential is "password".',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`An account with email ${email} already exists.`);
    }

    const created = await this.prisma.user.create({
      data: {
        email,
        name: input.name,
        role: input.role,
        allowed: true,
        // A password account starts with a one-time admin-set credential the owner
        // must replace; an OTP-only account carries no password to change.
        mustChangePassword: input.initialCredential === 'password',
        identities:
          input.initialCredential === 'password'
            ? {
                create: [
                  {
                    provider: 'password',
                    providerAccountId: email,
                    // Store ONLY the argon2 hash (never the plaintext). Produced by
                    // the shared auth-core util so it verifies on the login path.
                    secret: await hashPassword(input.password as string),
                  },
                ],
              }
            : undefined,
      },
      include: ACCOUNT_INCLUDE,
    });

    return toListItem(created);
  }

  /**
   * List all accounts as non-secret rows for the admin
   * page: identity, role, login methods, and
   * enabled/disabled status (account-administration: "Account administration page").
   * Newest first. No `IdentityLink.secret` is ever projected.
   */
  async list(): Promise<AccountListItem[]> {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: ACCOUNT_INCLUDE,
    });
    return rows.map((row) => toListItem(row));
  }

  /**
   * Enable/disable ANY account by flipping `User.allowed`, the single runtime gate
   * (local-account-identity D2). Disabling takes effect on the account's next
   * request (its sessions/tokens stop resolving because the gate re-confirms
   * `allowed` at request time); re-enabling restores access. Applies to
   * legacy linked accounts too and NEVER touches any identity secret.
   */
  async setEnabled(id: string, allowed: boolean): Promise<AccountListItem> {
    await this.requireAccount(id);
    const updated = await this.prisma.user.update({
      where: { id },
      data: { allowed },
      include: ACCOUNT_INCLUDE,
    });
    return toListItem(updated);
  }

  /**
   * Reset a LOCAL account's password: rotate the `password` `IdentityLink` secret
   * to a fresh argon2 hash and re-flag `mustChangePassword = true` so the
   * admin-set credential is again a one-time temporary one. Rejects a
   * row that has no password identity. The plaintext is never persisted or returned.
   */
  async resetPassword(id: string, password: string): Promise<AccountListItem> {
    const account = await this.requireAccount(id);
    const passwordIdentity = account.identities.find((i) => i.provider === 'password');
    if (!passwordIdentity) {
      throw new BadRequestException(
        'This account has no password identity; password reset applies to local accounts only.',
      );
    }

    await this.prisma.identityLink.update({
      where: { id: passwordIdentity.id },
      // Store ONLY the new argon2 hash.
      data: { secret: await hashPassword(password) },
    });
    const updated = await this.prisma.user.update({
      where: { id },
      data: { mustChangePassword: true },
      include: ACCOUNT_INCLUDE,
    });
    return toListItem(updated);
  }

  /**
   * Assign an account's `role` (admin|member). `role` gates ONLY the admin panel —
   * it carries NO execution privilege (every allowed account is host-root) — so
   * this is purely a panel-access change. Applies to all accounts alike at the
   * data layer.
   */
  async assignRole(id: string, role: AccountRole): Promise<AccountListItem> {
    await this.requireAccount(id);
    const updated = await this.prisma.user.update({
      where: { id },
      data: { role },
      include: ACCOUNT_INCLUDE,
    });
    return toListItem(updated);
  }

  /**
   * Load an account with its identities or throw 404. The `secret` of each
   * identity is selected only so internal logic (e.g. locating the password
   * identity to rotate) can act on it; it is NEVER projected into a response —
   * {@link toListItem} drops it.
   */
  private async requireAccount(id: string): Promise<AccountWithIdentities> {
    const account = await this.prisma.user.findUnique({
      where: { id },
      include: ACCOUNT_INCLUDE,
    });
    if (!account) {
      throw new NotFoundException(`No account ${id}.`);
    }
    return account;
  }
}

// ---------------------------------------------------------------------------
// Local DTOs (validated at the controller via ZodValidationPipe)
// ---------------------------------------------------------------------------

/** The two roles: `admin` gates the admin panel only; neither isolates execution. */
export const AccountRoleSchema = z.enum(['admin', 'member']);
export type AccountRole = z.infer<typeof AccountRoleSchema>;

/** A local login method an account can authenticate with, derived from its identities. */
export type AccountLoginMethod = 'password' | 'otp';

/** Minimum password length for an admin-set local credential. */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Create-account body. `initialCredential` is the admin's choice between a one-time
 * password (requires `password`) and a verification-code-only account (no password
 * identity). The cross-field rule is enforced with a refinement so an invalid
 * combination is a 400 (nothing created), not a runtime surprise.
 */
export const CreateAccountSchema = z
  .object({
    email: z.string().trim().email(),
    name: z.string().trim().min(1),
    role: AccountRoleSchema,
    initialCredential: z.enum(['password', 'otp-only']),
    password: z.string().min(MIN_PASSWORD_LENGTH).optional(),
  })
  .refine(
    (v) => v.initialCredential !== 'password' || typeof v.password === 'string',
    {
      message: 'A password is required when initialCredential is "password".',
      path: ['password'],
    },
  );
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

/** Enable/disable body — flips the single runtime gate `User.allowed`. */
export const SetEnabledSchema = z.object({ allowed: z.boolean() });
export type SetEnabledInput = z.infer<typeof SetEnabledSchema>;

/** Reset-password body — a fresh one-time local credential. */
export const ResetPasswordSchema = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

/** Assign-role body. */
export const AssignRoleSchema = z.object({ role: AccountRoleSchema });
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

/**
 * A non-secret account row for the admin page. `identity` is the email when
 * present else a legacy handle; `loginMethods` is derived from local identities;
 * `isGithubLinked` flags a legacy github `IdentityLink` for display/compatibility
 * only. No identity `secret` ever appears here.
 */
export interface AccountListItem {
  id: string;
  email: string | null;
  name: string;
  identity: string;
  role: AccountRole;
  allowed: boolean;
  loginMethods: AccountLoginMethod[];
  isGithubLinked: boolean;
}

// ---------------------------------------------------------------------------
// Row projection (drops every secret)
// ---------------------------------------------------------------------------

/** The identities select used everywhere — includes `secret` for internal logic only. */
const ACCOUNT_INCLUDE = {
  identities: {
    select: {
      id: true,
      provider: true,
      providerAccountId: true,
      secret: true,
    },
  },
} as const;

interface IdentityRow {
  id: string;
  provider: string;
  providerAccountId: string;
  secret: string | null;
}

interface AccountWithIdentities {
  id: string;
  email: string | null;
  name: string;
  role: string;
  allowed: boolean;
  identities: IdentityRow[];
}

/**
 * Project a loaded account into the non-secret list shape. By construction this
 * reads NO identity `secret` — the argon2 hash / legacy token never
 * reaches a response. `loginMethods` contains only local login methods; `otp` is
 * surfaced for any email-bearing account (it can log in by code once SMTP is
 * configured), so the row reflects what the account can actually do.
 */
function toListItem(account: AccountWithIdentities): AccountListItem {
  const providers = new Set(account.identities.map((i) => i.provider));
  const githubIdentity = account.identities.find((i) => i.provider === 'github');
  const isGithubLinked = providers.has('github');

  const loginMethods: AccountLoginMethod[] = [];
  if (providers.has('password')) loginMethods.push('password');
  // OTP is available to any account with an email handle once SMTP is configured.
  if (account.email) loginMethods.push('otp');

  // Prefer the canonical email handle; fall back to a legacy github handle for a
  // historical row that has no captured email.
  const identity = account.email ?? githubIdentity?.providerAccountId ?? account.id;

  return {
    id: account.id,
    email: account.email ?? null,
    name: account.name,
    identity,
    role: account.role as AccountRole,
    allowed: account.allowed,
    loginMethods,
    isGithubLinked,
  };
}

/** Normalize an email to a stable, case-insensitive handle (the `@unique` key). */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
