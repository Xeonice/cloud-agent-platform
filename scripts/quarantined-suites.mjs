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
 * An empty array is the healthy state. It was empty before 2026-07-29.
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
export const QUARANTINED_SUITES = [
  {
    file: 'scripts/install-preflight.test.mjs',
    reason:
      'Seventeen of forty-eight cases fail on the GitHub runner, all of them in the paths where the installer actually installs something — Homebrew bootstrap, apt-get, Colima. The other thirty-one pass.',
    evidence:
      'Passes 48/48 on macOS, 48/48 in node:22-slim with curl, and 48/48 in that container with real tools planted in /usr/local/bin. Four hypotheses were tested and all rejected: platform, missing curl, Homebrew probing of /usr/local/bin, and a CI-specific branch (the scripts contain none). The suite prints only PASS/FAIL, so the failing cases carry no diagnostic — which is itself part of what has to be fixed.',
    change: 'release-quarantined-installer-and-terminal-suites',
  },
  {
    file: 'scripts/aio-terminal-pair-stale-sweep-canary.test.mjs',
    reason:
      'Fails on the GitHub runner in three of four observed runs, alongside install-preflight and never independently of it.',
    evidence:
      'Passes locally. Newly mounted by 43aca22 and absent from main, so this is its first exposure to CI rather than a regression. Its correlation with install-preflight across runs suggests one shared cause, which the tracking change should establish before either is fixed.',
    change: 'release-quarantined-installer-and-terminal-suites',
  },
  {
    file: 'apps/api/src/terminal/readoption-history.test.mjs',
    reason:
      'One case — "session.cast resume preserves one header and monotonic event time" — intermittently observes a single cast event where two were written.',
    evidence:
      'Failed in one of four CI runs. Passes 5/5 standalone on macOS, 6/6 standalone on Linux, and inside the full 300-case suite. Unlike the two above it runs on main as well, so the flakiness predates this branch; the heavier suite that 9d43e75 mounted is the likely aggravator rather than the cause.',
    change: 'release-quarantined-installer-and-terminal-suites',
  },
];

/** @type {ReadonlySet<string>} */
export const QUARANTINED_FILES = new Set(
  QUARANTINED_SUITES.map((suite) => suite.file),
);

/**
 * Fails loudly on an entry that has decayed into an unexplained skip.
 *
 * @param {(relativePath: string) => boolean} fileExists
 * @returns {string[]} problems, empty when the list is honest
 */
export function auditQuarantine(fileExists) {
  const problems = [];
  const seen = new Set();
  for (const suite of QUARANTINED_SUITES) {
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
