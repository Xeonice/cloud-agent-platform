import { z } from 'zod';

/**
 * Private-account identity contracts (add-private-account-identity).
 *
 * The wire shapes for the self-hostable identity layer: email+password login,
 * email verification-code (OTP) login, the
 * forced first-login password change, admin-only account lifecycle management,
 * the one-time default-admin credential reveal, and the unauthenticated auth
 * capability flags the login modal reads to decide which methods to render.
 *
 * This file OWNS these contract types (track contracts-schema-deps, task 1.4);
 * the backend (`apps/api`) POPULATES/consumes them and the web console reads
 * them — neither re-declares a local copy (the single-source-of-truth rule).
 *
 * Secret discipline mirrors the rest of the platform: a password is only ever
 * sent UP (login / change / admin-set), never returned; the server stores only
 * an argon2 hash. No response shape here carries a password hash or an OTP code.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Console authorization role (add-private-account-identity). MUST stay in sync
 * with the Prisma `Role` enum. `role` gates ONLY the admin panel — it carries NO
 * execution privilege (every `allowed` account is host-root regardless of role).
 */
export const RoleSchema = z.enum(['admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

/** A login identity provider kind. OTP is NOT a provider — it keys on the email. */
export const IdentityProviderSchema = z.enum(['password']);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

/** Canonical account email — the password/OTP login handle and auto-link key. */
export const EmailSchema = z
  .string()
  .trim()
  .min(1)
  .email('A valid email address is required');

/**
 * A submitted password. Bounded so a single field cannot be used to exhaust the
 * argon2 hasher; the lower bound is the policy floor for a NEW password (login
 * does not constrain length beyond non-empty so a legacy/short password can
 * still be entered and then forced to change).
 */
export const PasswordSchema = z.string().min(8).max(200);

/** A presented numeric verification code (OTP): exactly 6 ASCII digits. */
export const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'A 6-digit code is required');

// ---------------------------------------------------------------------------
// Auth capability flags (unauthenticated) — D11
// ---------------------------------------------------------------------------

/**
 * The unauthenticated auth-method capability flags the login modal reads to
 * decide which local methods to render. Exposed by the backend so a
 * method whose prerequisites are unmet is simply not offered:
 *   - `passwordAuthEnabled` — email+password login is available.
 *   - `otpAuthEnabled` — email verification-code login is available (true only
 *     when SMTP is configured, per `email-otp-login`).
 * These describe AVAILABILITY only; they are never an authorization decision and
 * carry no secret.
 */
export const AuthCapabilitiesSchema = z.object({
  /** Whether email+password login is offered. */
  passwordAuthEnabled: z.boolean(),
  /** Whether email verification-code (OTP) login is offered (SMTP configured). */
  otpAuthEnabled: z.boolean(),
});
export type AuthCapabilities = z.infer<typeof AuthCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Password login
// ---------------------------------------------------------------------------

/**
 * Request body for the public email+password login endpoint. The endpoint fails
 * closed with a UNIFORM generic failure (unknown email / no password identity /
 * wrong password / not allowed are indistinguishable) and never auto-creates an
 * account.
 */
export const PasswordLoginRequestSchema = z.object({
  email: EmailSchema,
  /** The presented password — non-empty; login does not enforce the new-password floor. */
  password: z.string().min(1).max(200),
});
export type PasswordLoginRequest = z.infer<typeof PasswordLoginRequestSchema>;

// ---------------------------------------------------------------------------
// Email OTP (request + verify)
// ---------------------------------------------------------------------------

/**
 * Request body for the public OTP request endpoint. The response is UNIFORM and
 * non-disclosing (it never reveals whether the email maps to an allowed account)
 * and no account is ever created.
 */
export const OtpRequestRequestSchema = z.object({
  email: EmailSchema,
});
export type OtpRequestRequest = z.infer<typeof OtpRequestRequestSchema>;

/**
 * The uniform, non-disclosing response to an OTP request. It is identical on the
 * success path and the unknown-email path so a caller cannot enumerate accounts.
 */
export const OtpRequestResponseSchema = z.object({
  /** Always present; a constant acknowledgement that reveals nothing. */
  ok: z.literal(true),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

/**
 * Request body for the public OTP verify endpoint. A matching, unexpired,
 * unconsumed code for an allowed account mints a session; the code is then marked
 * consumed so it cannot be replayed.
 */
export const OtpVerifyRequestSchema = z.object({
  email: EmailSchema,
  code: OtpCodeSchema,
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;

// ---------------------------------------------------------------------------
// Change password (forced first-login + self-service)
// ---------------------------------------------------------------------------

/**
 * Request body for the change-password endpoint. Setting a new password stores
 * its argon2 hash, clears `mustChangePassword`, and invalidates the prior
 * temporary credential. `currentPassword` is the existing credential (the
 * temporary one on the forced first-login path); `newPassword` is the new
 * credential, subject to the new-password policy floor.
 */
export const ChangePasswordRequestSchema = z.object({
  /**
   * The current/temporary password being replaced. OPTIONAL: the change-password
   * endpoint authenticates via the active session (the operator just logged in
   * with the temporary credential), and the forced first-login dialog collects
   * only the new password. When present it is verified as an extra check; when
   * absent the valid session is the proof of identity.
   */
  currentPassword: z.string().min(1).max(200).optional(),
  /** The new password — subject to the policy floor. */
  newPassword: PasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// ---------------------------------------------------------------------------
// Admin account DTOs (create / enable / disable / reset / role)
// ---------------------------------------------------------------------------

/**
 * The initial-credential choice when an admin creates a local account
 * (`account-administration`):
 *   - `password` — set an initial password (stored as an argon2 hash) and flag
 *     `mustChangePassword` so the user must change it on first login.
 *   - `otp-only` — create NO password identity; the account logs in by email
 *     verification code once SMTP is configured.
 */
export const InitialCredentialKindSchema = z.enum(['password', 'otp-only']);
export type InitialCredentialKind = z.infer<typeof InitialCredentialKindSchema>;

/**
 * Request body for an admin creating a local account. Creating a local account
 * sets `allowed = true`. When `credential.kind === "password"` an
 * `initialPassword` MUST be present and a `password` identity is created with its
 * argon2 hash plus `mustChangePassword = true`; `otp-only` creates no password
 * identity. There is NO public registration — accounts come only from this admin
 * flow or the default-admin seed.
 */
export const AdminCreateAccountRequestSchema = z
  .object({
    email: EmailSchema,
    /** Display name for the new account (required). */
    name: z.string().trim().min(1).max(200),
    /** Assigned role. */
    role: RoleSchema,
    /** Initial-credential choice: a one-time password, or verification-code only. */
    initialCredential: InitialCredentialKindSchema,
    /**
     * The initial password — REQUIRED when `initialCredential === "password"`
     * (stored as an argon2 hash; forces a first-login change), omitted for
     * `otp-only`. The cross-field rule is enforced below so an invalid combination
     * is a 400, not a runtime surprise.
     */
    password: PasswordSchema.optional(),
  })
  .refine(
    (v) => v.initialCredential !== 'password' || typeof v.password === 'string',
    {
      message: 'A password is required when initialCredential is "password".',
      path: ['password'],
    },
  );
export type AdminCreateAccountRequest = z.infer<
  typeof AdminCreateAccountRequestSchema
>;

/**
 * Request body for an admin enabling/disabling an account (sets `allowed`).
 * Applies to every account row under the pure-DB runtime gate. Takes effect on
 * the account's next request.
 */
export const AdminSetEnabledRequestSchema = z.object({
  /** New enabled state: `true` sets `allowed = true`, `false` sets `allowed = false`. */
  allowed: z.boolean(),
});
export type AdminSetEnabledRequest = z.infer<typeof AdminSetEnabledRequestSchema>;

/**
 * Request body for an admin resetting a LOCAL account's password. Stores the new
 * argon2 hash and flags `mustChangePassword`; not available for rows without a
 * password identity.
 */
export const AdminResetPasswordRequestSchema = z.object({
  /** The new temporary password (stored as an argon2 hash; forces a change). */
  password: PasswordSchema,
});
export type AdminResetPasswordRequest = z.infer<
  typeof AdminResetPasswordRequestSchema
>;

/** Request body for an admin assigning an account's role. */
export const AdminSetRoleRequestSchema = z.object({
  role: RoleSchema,
});
export type AdminSetRoleRequest = z.infer<typeof AdminSetRoleRequestSchema>;

/** Path-parameter shape addressing a single account by id for admin operations. */
export const AdminAccountParamsSchema = z.object({
  /** The account (`User`) id. */
  id: z.string().uuid(),
});
export type AdminAccountParams = z.infer<typeof AdminAccountParamsSchema>;

/**
 * A single row in the admin account-administration list (`account-administration`).
 * Carries identity + lifecycle facts ONLY — never a password hash, OTP code, or
 * any secret. This shape mirrors the api's projection EXACTLY (the single wire
 * contract both the backend list endpoint and the console read): `identity` is
 * the display handle (normally the email), `loginMethods` is the set of local
 * ways this account can authenticate, and `isGithubLinked` flags a legacy
 * GitHub identity row for display/compatibility only.
 */
export const AdminAccountListItemSchema = z.object({
  /** The account (`User`) id. */
  id: z.string(),
  /**
   * Canonical account email, or null when the account has none.
   * A STORED value for display, NOT input — kept a lenient nullable string (not
   * the strict `EmailSchema`) so the list never fails to parse on an
   * operator-provided address that the strict form would reject (e.g. an intranet
   * `admin@local`). Strict email validation belongs on the create REQUEST.
   */
  email: z.string().nullable(),
  /** Display name. */
  name: z.string(),
  /** The primary display handle, normally the email. */
  identity: z.string(),
  /** Assigned role. */
  role: RoleSchema,
  /** Whether the account is currently allowed (enabled). */
  allowed: z.boolean(),
  /** The login methods this account can use. */
  loginMethods: z.array(z.enum(['password', 'otp'])),
  /** Whether a legacy github identity is linked. It is not a login method. */
  isGithubLinked: z.boolean(),
});
export type AdminAccountListItem = z.infer<typeof AdminAccountListItemSchema>;

/** Response body for the admin account list. */
export const AdminAccountListResponseSchema = z.object({
  accounts: z.array(AdminAccountListItemSchema),
});
export type AdminAccountListResponse = z.infer<
  typeof AdminAccountListResponseSchema
>;

// ---------------------------------------------------------------------------
// One-time default-admin credential reveal
// ---------------------------------------------------------------------------

/**
 * The one-time default-admin credential reveal response (`default-admin-bootstrap`).
 * Returns the seeded admin email and the GENERATED plaintext password EXACTLY
 * ONCE — guarded by a persisted consumed flag (`SystemSettings.adminRevealConsumedAt`)
 * and only while the plaintext is still held in process memory. After consume the
 * in-memory plaintext is cleared and any further reveal returns nothing.
 *
 * NOTE: this is the SOLE channel through which the generated plaintext is ever
 * transmitted; it is never persisted to the database or logs as plaintext.
 */
export const AdminRevealResponseSchema = z.object({
  /** The seeded admin email. */
  email: EmailSchema,
  /** The generated plaintext password — transmitted exactly once. */
  password: z.string().min(1),
});
export type AdminRevealResponse = z.infer<typeof AdminRevealResponseSchema>;
