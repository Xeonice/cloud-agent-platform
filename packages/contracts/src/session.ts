import { z } from 'zod';
import { RoleSchema, AuthCapabilitiesSchema } from './auth-account.js';

/**
 * Session identity shapes.
 *
 * These describe the authenticated console account that `GET /auth/session`
 * returns so the console can decide between the authenticated app shell and the
 * login gate. Authority is keyed on the DB account id (`id`), while `allowed`
 * is the fail-closed runtime enablement gate checked whenever a session resolves.
 *
 * This is the OPERATOR identity trust domain; it is distinct from the runner
 * `TASK_TOKEN` dial-back domain (`./dialback.js`), which authenticates a sandbox
 * dialling back and never a human operator.
 */

// ---------------------------------------------------------------------------
// Session user identity
// ---------------------------------------------------------------------------

/**
 * The authenticated console account rendered by the console.
 *
 * `id` is the stable account primary key used for per-account scoping.
 * `githubId`, `login`, and `avatarUrl` remain nullable compatibility/display
 * fields for accounts that were historically linked to GitHub. `allowed`
 * reflects DB-backed account enablement re-confirmed at session-resolution time.
 */
export const SessionUserSchema = z.object({
  /**
   * The DB account primary key (a string UUID) — the SINGLE per-account scope key
   * (fix-local-account-settings-scope). Present for BOTH local and GitHub accounts,
   * so per-account settings (Codex credential, forge credential, account
   * preferences, Codex device login) scope on this id directly rather than on the
   * GitHub identity. REQUIRED so TypeScript forces every SessionUser construction
   * site to supply it — no path can mint an id-less principal.
   */
  id: z.string(),
  /**
   * Optional GitHub numeric account id retained for legacy attribution/display.
   * It is NOT the per-account settings scope key (that is `id`, above).
   * NULLABLE (add-private-account-identity): a LOCAL account (password/OTP) has no
   * GitHub identity, so it carries `null` here. A GitHub-provisioned account still
   * sets it.
   */
  githubId: z.number().int().nullable(),
  /**
   * GitHub `login` (mutable username), refreshed on each login. NULLABLE
   * (add-private-account-identity): a local account has no GitHub handle. Consumers
   * fall back to the email / name for display.
   */
  login: z.string().min(1).nullable(),
  /** Display name, captured for console rendering (GitHub name or the local email). */
  name: z.string(),
  /**
   * GitHub avatar reference, captured for console rendering. NULLABLE
   * (add-private-account-identity): a local account has no GitHub avatar.
   */
  avatarUrl: z.string().nullable(),
  /**
   * Whether this account is presently enabled. A session user is only surfaced
   * for an enabled account; this field is the re-confirmed DB flag, never a
   * bypassable client-supplied value.
   */
  allowed: z.boolean(),
  /**
   * Console authorization role (add-private-account-identity). Gates ONLY the
   * admin panel — it carries NO execution privilege (every `allowed` account is
   * host-root regardless of role). The console reads it to decide whether to show
   * the account-administration entry.
   */
  role: RoleSchema,
  /**
   * Whether a forced first-login password change is pending
   * (add-private-account-identity, D9). When true the console MUST route the
   * operator into the forced-change flow before granting app-shell access; the
   * backend independently blocks every protected route (except change-password)
   * for such an account, so this is the UX signal, not the security gate.
   */
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

// ---------------------------------------------------------------------------
// Auth session
// ---------------------------------------------------------------------------

/**
 * The current authentication state: the authenticated {@link SessionUserSchema}
 * when a valid, non-expired session resolves to an enabled user, or `null` when
 * the request is unauthenticated (no session, expired, revoked, or disabled).
 * `null` returns the console to the login gate.
 */
export const AuthSessionSchema = SessionUserSchema.nullable();
export type AuthSession = z.infer<typeof AuthSessionSchema>;

// ---------------------------------------------------------------------------
// GET /auth/session response body
// ---------------------------------------------------------------------------

/**
 * Response body for `GET /auth/session`.
 *
 * The 200 body wraps the authenticated session user under a `user` key. Note
 * the WIRE protocol: an unauthenticated caller is NOT a
 * 200 with `user: null` — like every authenticated endpoint it is rejected with
 * HTTP 401 (no body of this shape). The nullable `user` models the CLIENT-SIDE
 * resolved {@link AuthSessionSchema} (`getAuthSession` maps that 401 to `null`),
 * which the console reads to choose between the app shell and the login gate.
 */
export const AuthSessionResponseSchema = z.object({
  user: AuthSessionSchema,
  /**
   * The unauthenticated auth-method capability flags (add-private-account-identity,
   * D11) the login modal reads to decide which methods to render. Surfaced on this
   * response — including the 401 logged-out body — so the login modal can discover
   * the enabled methods (e.g. whether OTP is available per SMTP config) without a
   * separate round trip. Optional for backward compatibility with callers/tests
   * that predate the flags.
   */
  capabilities: AuthCapabilitiesSchema.optional(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
