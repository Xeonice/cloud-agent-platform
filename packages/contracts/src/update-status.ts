import { z } from 'zod';

import { UNKNOWN_VERSION_VALUE } from './version.js';

/**
 * Update-availability contract (update-availability-check, Phase 2 of the OSS
 * self-update epic). Phase 1 shipped `/version` (running identity); this closes
 * the NOTIFY half: compare the running version against the latest GitHub Release
 * and tell the operator.
 *
 * The api exposes an operator-guarded `GET /update-status` (see design D1) that
 * does ONE cached GitHub Releases fetch per TTL and reports this discriminated
 * {@link UpdateStatus}. The shape is HONEST and degrades safely (design D2): an
 * update is signalled ONLY when the current version is known, a latest Release
 * exists, and latest > current. A source build (`"unknown"` current), a repo
 * with no releases, an unparseable tag, or a failed fetch all report
 * `updateAvailable: false` with `latestVersion` null — never a fabricated prompt.
 *
 * The web console validates the endpoint response against {@link UpdateStatusSchema}
 * on the standard real/mock query seam and renders a dismissible banner from it.
 */

/**
 * The `GET /update-status` response body. `updateAvailable` is the load-bearing
 * boolean the banner gates on; the remaining fields carry the comparison detail.
 *
 * - `currentVersion` — the running `CAP_VERSION` (or the `"unknown"` sentinel
 *   for a source build); always a non-empty string, mirroring `/version`.
 * - `latestVersion` — the latest GitHub Release tag, or `null` when none exists,
 *   the repo is unreachable, or the fetch failed (degraded).
 * - `updateAvailable` — `true` ONLY when `currentVersion` is known AND a
 *   `latestVersion` exists AND latest > current; honest `false` otherwise.
 * - `releaseUrl` / `releaseName` — the changelog link + display name for the
 *   latest Release, or `null` when there is no latest Release.
 * - `checkedAt` — ISO 8601 timestamp of when the comparison was computed (may be
 *   served from cache within the TTL).
 */
export const UpdateStatusSchema = z.object({
  /** The running `CAP_VERSION`, or the `"unknown"` sentinel for a source build. */
  currentVersion: z.string().min(1),
  /** The latest GitHub Release tag, or `null` when unknown/unreachable. */
  latestVersion: z.string().min(1).nullable(),
  /** `true` only when current is known + a newer latest Release exists. */
  updateAvailable: z.boolean(),
  /** Link to the latest Release (changelog), or `null` when none. */
  releaseUrl: z.string().url().nullable(),
  /** Display name of the latest Release, or `null` when none. */
  releaseName: z.string().min(1).nullable(),
  /** ISO 8601 timestamp the comparison was computed (cacheable within TTL). */
  checkedAt: z.string().datetime(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

/**
 * A degraded {@link UpdateStatus} for when no comparison is possible — a source
 * build, a repo with no releases, an unreachable/private repo, or a failed
 * fetch. `updateAvailable` is honestly `false` with every latest-Release field
 * null. Pure; callers supply the known `currentVersion` and `checkedAt`.
 */
export function degradedUpdateStatus(
  currentVersion: string,
  checkedAt: string,
): UpdateStatus {
  return {
    currentVersion: currentVersion.trim().length > 0 ? currentVersion : UNKNOWN_VERSION_VALUE,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    checkedAt,
  };
}

/**
 * A parsed semantic version: the numeric `major.minor.patch` core plus an
 * optional pre-release identifier. The build-metadata segment (`+...`) is
 * ignored for ordering, per semver §10.
 */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The dot-separated pre-release identifiers (empty for a release version). */
  prerelease: string[];
}

/**
 * Parses a version string into its numeric core + pre-release identifiers,
 * tolerant of a leading `v`/`V` prefix (e.g. `v1.2.3`). Missing minor/patch
 * segments default to `0` (`1` → `1.0.0`, `1.2` → `1.2.0`). Returns `null` for
 * anything unparseable — the caller then treats it as "not newer" (fail safe,
 * never a false prompt). Build metadata (`+...`) is stripped and ignored.
 */
function parseVersion(raw: string): ParsedVersion | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let s = raw.trim();
  if (s.length === 0) {
    return null;
  }
  // Tolerate a leading v / V prefix.
  if (s[0] === 'v' || s[0] === 'V') {
    s = s.slice(1);
  }
  // Build metadata does not affect ordering — drop it.
  const plus = s.indexOf('+');
  if (plus !== -1) {
    s = s.slice(0, plus);
  }
  // Split off the pre-release segment.
  const dash = s.indexOf('-');
  let core = s;
  let prerelease: string[] = [];
  if (dash !== -1) {
    core = s.slice(0, dash);
    const pre = s.slice(dash + 1);
    if (pre.length === 0) {
      return null;
    }
    prerelease = pre.split('.');
    if (prerelease.some((id) => id.length === 0)) {
      return null;
    }
  }
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 3) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    nums.push(Number.parseInt(part, 10));
  }
  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease,
  };
}

/** Compares two pre-release identifier lists per semver §11 precedence rules. */
function comparePrerelease(a: string[], b: string[]): number {
  // A version WITHOUT a pre-release has higher precedence than one WITH it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const idA = a[i] as string;
    const idB = b[i] as string;
    const numA = /^\d+$/.test(idA);
    const numB = /^\d+$/.test(idB);
    if (numA && numB) {
      const diff = Number.parseInt(idA, 10) - Number.parseInt(idB, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (numA) {
      // Numeric identifiers have lower precedence than alphanumeric.
      return -1;
    } else if (numB) {
      return 1;
    } else if (idA !== idB) {
      return idA < idB ? -1 : 1;
    }
  }
  // A larger set of pre-release fields (all prior equal) has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Compares two version strings (v-prefix tolerant). Returns a negative number if
 * `a < b`, `0` if equal, a positive number if `a > b`, and `null` if EITHER
 * side is unparseable. Pure and trivially testable; the api uses it to decide
 * `updateAvailable` and the result is the single source of comparison truth.
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) {
    return null;
  }
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Whether `candidate` is strictly NEWER than `current` (v-prefix tolerant).
 * Returns `false` — never throws — when either is unparseable OR the current
 * version is the `"unknown"` sentinel (a source build), so an unknown/garbage
 * input can never produce a false update prompt. This is the exact predicate
 * `updateAvailable` is built on.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (current === UNKNOWN_VERSION_VALUE || candidate === UNKNOWN_VERSION_VALUE) {
    return false;
  }
  const cmp = compareVersions(candidate, current);
  if (cmp === null) {
    return false;
  }
  return cmp > 0;
}
