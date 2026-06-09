import { z } from 'zod';

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
  /** Stable, immutable GitHub numeric account id; the allowlist + user-record key. */
  githubId: z.number().int(),
  /** GitHub `login` (mutable username), refreshed on each login. */
  login: z.string().min(1),
  /** GitHub display name, captured for console rendering. */
  name: z.string(),
  /** GitHub avatar reference, captured for console rendering. */
  avatarUrl: z.string(),
  /**
   * Whether this identity is presently on the fail-closed allowlist. A session
   * user is only ever surfaced for an allowlisted identity; this field is the
   * re-confirmed membership flag, never a bypassable client-supplied value.
   */
  allowed: z.boolean(),
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
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;
