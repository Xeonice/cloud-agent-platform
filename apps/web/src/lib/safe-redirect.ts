/**
 * Client-side open-redirect guard for the post-login deep-link
 * (auth-redirects-and-landing). Mirrors the backend `safeRedirectPath` (the
 * AUTHORITATIVE guard at the trust boundary): the client only ever forwards /
 * navigates to a SAME-ORIGIN RELATIVE path, so a tampered `?redirect=` cannot
 * bounce the operator off-origin even before the request reaches the backend.
 * Pure (no window/DOM) so it is unit-testable and usable in SSR.
 */

/**
 * Returns `raw` when it is a safe same-origin relative path (begins with a single
 * `/`, not `//`, no backslash, no scheme/authority), else `null`.
 */
export function safeRelativePath(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  if (value[0] !== "/" || value[1] === "/") return null;
  if (value.includes("\\")) return null;
  if (value.includes("://")) return null;
  return value;
}
