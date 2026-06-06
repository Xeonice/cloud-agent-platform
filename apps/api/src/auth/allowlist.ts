/**
 * Hard allowlist gate (be-oauth-allowlist, task 2.4).
 *
 * This is the LOAD-BEARING fail-closed security boundary: because the backend
 * runs tasks under a host-root `docker.sock` model, "who can log in" == "who can
 * run as root on the host". The gate therefore admits ONLY GitHub identities
 * whose immutable numeric `id` appears on the configured `AUTH_ALLOWLIST`, and
 * denies in EVERY ambiguous condition (unset / empty / unparseable).
 *
 * Matching keys on the immutable numeric `id`, NEVER the mutable `login`: a
 * renamed or reassigned GitHub username must not be able to impersonate an
 * allowlisted operator. `login` is display-only.
 *
 * The functions here are pure (no env capture, no I/O) so the verify phase can
 * unit-test allowlist parsing, empty/unparseable denial, and numeric-id matching
 * directly.
 */

/**
 * Parses the comma-separated `AUTH_ALLOWLIST` of GitHub NUMERIC ids into a set of
 * admitted ids.
 *
 * FAIL-CLOSED semantics:
 * - `undefined` / empty / whitespace-only  -> empty set (admits no one).
 * - any non-empty entry that is NOT a clean non-negative integer (e.g. a login
 *   string, a float, `1e3`, `0x10`, a negative) makes the WHOLE list
 *   unparseable -> empty set. We refuse a "best-effort partial parse" because a
 *   malformed allowlist is an ambiguous condition and the gate must deny rather
 *   than admit a possibly-wrong subset.
 *
 * Returning an empty set is what makes "empty or missing allowlist denies
 * everyone" hold: {@link isAllowlisted} can never match against an empty set.
 */
export function parseAllowlist(raw: string | undefined): Set<number> {
  if (typeof raw !== 'string') {
    return new Set();
  }
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return new Set();
  }

  const ids = new Set<number>();
  for (const entry of entries) {
    const id = parseNumericId(entry);
    if (id === null) {
      // Unparseable entry -> deny the whole list (fail closed), do not partial-parse.
      return new Set();
    }
    ids.add(id);
  }
  return ids;
}

/**
 * True iff `githubId` is admitted by `allowlist`. Matches on the numeric id only.
 *
 * Guards against a non-integer / non-finite `githubId` (which could otherwise
 * sneak through a `Set.has` against a coerced value) by rejecting anything that
 * is not a clean integer — a defensive complement to keying on the immutable id.
 */
export function isAllowlisted(githubId: number, allowlist: Set<number>): boolean {
  if (!Number.isInteger(githubId)) {
    return false;
  }
  return allowlist.has(githubId);
}

/**
 * Convenience over {@link parseAllowlist} + {@link isAllowlisted}: evaluates the
 * gate for a numeric id directly against the raw env value. Denies fail-closed
 * for an unset/empty/unparseable list.
 */
export function isAllowlistedRaw(githubId: number, rawAllowlist: string | undefined): boolean {
  return isAllowlisted(githubId, parseAllowlist(rawAllowlist));
}

/**
 * Parses a single allowlist entry into a non-negative integer GitHub id, or
 * `null` when the entry is not a clean base-10 non-negative integer. Rejects
 * floats, signs, exponents, hex, and any trailing/leading garbage so only
 * unambiguous numeric ids are admitted.
 */
function parseNumericId(entry: string): number | null {
  if (!/^[0-9]+$/.test(entry)) {
    return null;
  }
  const id = Number(entry);
  if (!Number.isSafeInteger(id)) {
    return null;
  }
  return id;
}
