/**
 * Suites deliberately kept out of the default run, with the reason each is out.
 *
 * This is a skip list, and skip lists are what the test-discovery gate exists to
 * abolish. The distinction that makes this one acceptable is not that it is
 * smaller — it is that the previous list was invisible. Forty suites had stopped
 * running with nothing saying so; this one is printed, in full, every time a
 * suite runs, and a gate fails if an entry is undocumented or its file has moved.
 *
 * The rules that keep it from becoming the thing it replaced:
 *
 *   1. Every entry names a reason, the evidence behind it, and the change
 *      tracking its removal. An entry without all three fails `pnpm test:scripts`.
 *   2. Nothing lands here to make CI green. It lands here when the failure is
 *      understood well enough to describe and NOT understood well enough to fix,
 *      and the description has to say which.
 *   3. `pnpm test:quarantined` runs them anyway. A quarantined suite that starts
 *      passing is a suite to release, and the tracking change is where that gets
 *      decided.
 *
 * An empty array is the healthy state. It was empty before 2026-07-29, and it
 * is empty again since 2026-07-31: the three entries quarantined on 2026-07-29
 * were diagnosed from the GitHub-runner logs and fixed at their root causes by
 * change `close-gate-blindspots-and-ci-hygiene`
 * (see its tasks.md track "quarantine-clearing" for the run-level evidence):
 *
 *   - scripts/install-preflight.test.mjs — the harness PATH tail
 *     (`/usr/bin:/bin`) leaked the runner's REAL usable Docker into every
 *     "Docker absent" case; the harness now runs cases against a hermetic
 *     whitelisted tool dir and prints per-case diagnostics on failure.
 *   - scripts/aio-terminal-pair-stale-sweep-canary.test.mjs — the canary
 *     imported bare `ws`, which no root manifest declares; it resolved through
 *     an accidental ancestor node_modules locally and ERR_MODULE_NOT_FOUND'd
 *     on a fresh runner install. It now resolves `ws` from
 *     packages/sandbox-provider-aio, the package that declares it.
 *   - apps/api/src/terminal/readoption-history.test.mjs — a real product race:
 *     cast resume corrected `startMs` asynchronously, so an append landing in
 *     the window stamped a regressed event time and parseCast truncated at it;
 *     armCast now settles resume state synchronously.
 */

/**
 * @typedef {Object} QuarantinedSuite
 * @property {string} file      Repository-relative path.
 * @property {string} reason    What fails, stated as behaviour rather than blame.
 * @property {string} evidence  How that was established — the part that stops
 *                              this from being a guess someone wrote down.
 * @property {string} change    The OpenSpec change accountable for removing it.
 */

/** @type {ReadonlyArray<QuarantinedSuite>} */
export const QUARANTINED_SUITES = [];

/** @type {ReadonlySet<string>} */
export const QUARANTINED_FILES = new Set(
  QUARANTINED_SUITES.map((suite) => suite.file),
);

/**
 * Audits any prospective quarantine list: every entry must name a real file
 * once, and carry a substantive reason, evidence, and owning change. Split
 * from {@link auditQuarantine} so the paired self-test can prove the
 * rejection shapes on fixtures even while the live list is (healthily) empty.
 *
 * @param {ReadonlyArray<QuarantinedSuite>} suites
 * @param {(relativePath: string) => boolean} fileExists
 * @returns {string[]} problems, empty when the list is honest
 */
export function auditQuarantineEntries(suites, fileExists) {
  const problems = [];
  const seen = new Set();
  for (const suite of suites) {
    const where = suite.file || '<missing file>';
    if (!suite.file) problems.push('an entry has no file');
    else if (seen.has(suite.file)) problems.push(`${where}: listed twice`);
    else if (!fileExists(suite.file)) {
      problems.push(
        `${where}: no such file — a quarantined suite that moved or was deleted must leave this list`,
      );
    }
    seen.add(suite.file);
    for (const field of ['reason', 'evidence', 'change']) {
      const value = suite[field];
      if (typeof value !== 'string' || value.trim().length < 20) {
        problems.push(`${where}: ${field} is missing or too short to be a reason`);
      }
    }
  }
  return problems;
}

/**
 * Fails loudly on an entry that has decayed into an unexplained skip.
 *
 * @param {(relativePath: string) => boolean} fileExists
 * @returns {string[]} problems, empty when the list is honest
 */
export function auditQuarantine(fileExists) {
  return auditQuarantineEntries(QUARANTINED_SUITES, fileExists);
}
