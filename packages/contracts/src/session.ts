import { z } from 'zod';
import { RoleSchema, AuthCapabilitiesSchema } from './auth-account.js';

/**
 * Session identity shapes (multi-user-oauth spec).
 *
 * These describe the authenticated GitHub operator identity the rebuilt console
 * renders, and the shape `GET /auth/session` returns so the console can decide
 * between the authenticated app shell and the login gate ("GitHub 授权登录").
 *
 * The identity is keyed on the immutable GitHub numeric `id` ("Match keys on
 * immutable numeric id, not mutable login") — `login`, `name`, and `avatarUrl`
 * are mutable profile fields refreshed on each login ("Subsequent login
 * refreshes mutable profile fields"). `allowed` reflects the load-bearing
 * fail-closed allowlist gate ("Allowlist gate is the load-bearing fail-closed
 * security boundary"): only an allowlisted identity is ever surfaced as a
 * session user.
 *
 * This is the OPERATOR identity trust domain; it is distinct from the runner
 * `TASK_TOKEN` dial-back domain (`./dialback.js`), which authenticates a sandbox
 * dialling back and never a human operator.
 */

// ---------------------------------------------------------------------------
// Session user identity
// ---------------------------------------------------------------------------

/**
 * The authenticated GitHub operator identity rendered by the console.
 *
 * `githubId` is the stable, immutable GitHub numeric identity the user record
 * and allowlist key on. `login`, `name`, and `avatarUrl` are mutable GitHub
 * profile fields captured for console rendering. `allowed` reflects allowlist
 * membership re-confirmed at session-resolution time; a session user is only
 * ever produced for an identity that has already passed the fail-closed
 * allowlist gate.
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
   * Stable GitHub numeric account id; the GitHub LOGIN-PROVISIONING / ALLOWLIST key
   * only (e.g. `AUTH_ALLOWLIST`, self-update admin list) — it is NOT the per-account
   * settings scope key (that is `id`, above).
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
   * Whether this identity is presently on the fail-closed allowlist. A session
   * user is only ever surfaced for an allowlisted identity; this field is the
   * re-confirmed membership flag, never a bypassable client-supplied value.
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
 * when a valid, non-expired session resolves to an allowlisted user, or `null`
 * when the request is unauthenticated (no session, expired, revoked, or
 * de-allowlisted). `null` returns the console to the login gate.
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
 * the WIRE protocol per `multi-user-oauth`: an unauthenticated caller is NOT a
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
