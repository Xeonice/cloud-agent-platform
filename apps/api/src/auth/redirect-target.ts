/**
 * Open-redirect guard for the post-login deep-link return (auth-redirects-and-landing).
 *
 * Login grants host-root task execution, so a reflected post-login redirect is a
 * phishing vector: an attacker who gets an operator to complete a login carrying
 * an attacker-chosen `redirect` could bounce them to a look-alike off-origin page.
 * Therefore the orchestrator accepts a `redirect` ONLY when it is a SAME-ORIGIN
 * RELATIVE path; anything else is rejected and the caller falls back to the
 * default console target. PURE (no I/O, no env) so it is unit-testable in isolation
 * and applied at BOTH ends (when the cookie is set at /login and when it is read at
 * the callback) as defense-in-depth.
 */

/** Upper bound on an accepted path length (defensive; real app paths are short). */
const MAX_REDIRECT_LENGTH = 512;

/**
 * Returns `raw` when it is a safe same-origin relative app path, else `null`.
 *
 * Accepted: a path beginning with a single `/` followed by URL path-safe
 * characters (e.g. `/dashboard`, `/tasks/abc`, `/tasks/abc?tab=logs`).
 *
 * Rejected (→ `null`, caller falls back to the default target):
 *  - missing / empty / non-string;
 *  - protocol-relative (`//evil.example`) — would navigate off-origin;
 *  - any backslash (`/\evil`, `\\evil`) — browsers can treat `\` as `/`;
 *  - a scheme/authority (`http:`, `https:`, `javascript:`, `://`);
 *  - whitespace or control characters;
 *  - anything not starting with `/`, or over the length bound.
 */
export function safeRedirectPath(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) return null;

  // Must be a relative path rooted at `/`, but NOT protocol-relative `//`.
  if (value[0] !== '/' || value[1] === '/') return null;
  // No backslashes (browsers may normalize `\` → `/`, enabling `/\evil`).
  if (value.includes('\\')) return null;
  // No scheme/authority marker anywhere.
  if (value.includes('://')) return null;
  // Only URL path-safe characters (RFC 3986 path + query + percent); this also
  // rejects whitespace and control characters by construction.
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(value)) return null;

  return value;
}
