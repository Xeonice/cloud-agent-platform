#!/usr/bin/env node
/**
 * The shared ratchet-baseline comparator — the ONLY implementation of
 * baseline-comparison semantics in this repository.
 *
 * A ratchet baseline is a committed JSON file under `scripts/ratchets/` that
 * tolerates a gate's known 存量 (pre-existing violations) so the gate can expand
 * its scope without landing red. The semantics are the strict fail-on-stale
 * variant (the ESLint bulk-suppressions model), NOT silent auto-reduce:
 *
 *   - measured count ABOVE the baselined count  → red (new violations the
 *     baseline does not cover, named in the output);
 *   - measured count BELOW the baselined count  → equally red (a stale entry —
 *     the fix must land WITH the matching baseline shrink in the same PR, so a
 *     fixed violation can never silently regrow up to a stale ceiling);
 *   - comparison keys on COUNT only — `samples[]` are documentation for the
 *     reviewer, never match keys, so entries survive refactors that move code
 *     without changing how many violations the gate measures.
 *
 * Baseline file shape — a JSON object mapping an entry key (typically a
 * repo-relative file path) to an entry carrying exactly these three fields:
 *
 *   {
 *     "apps/api/src/example/example.service.ts": {
 *       "count": 3,
 *       "samples": ["example.service.ts:3 import Docker from 'dockerode'"],
 *       "change": "阶段 7a 端口化根治"
 *     }
 *   }
 *
 *   - `count`   — the tolerated violation count (a positive integer);
 *   - `samples` — illustrative locations, the reviewer's anchor;
 *   - `change`  — the owning change responsible for eliminating the entry.
 *
 * An entry missing any of the three fields fails the audit, naming the entry
 * and the missing field. Tolerated debt without an owner is not tolerated.
 *
 * ENDGAME — a ratchet ends by deletion, never by an empty shell:
 *
 *   - when an entry's measured count reaches 0, the ENTRY is deleted from the
 *     baseline in the same PR as the fix (the comparator says so);
 *   - when the FILE's total tolerated count reaches 0 — every violation it
 *     tolerated has been eliminated — the baseline file itself is DELETED from
 *     `scripts/ratchets/` and the gate passes with no baseline present;
 *   - a baseline whose entries total zero tolerated violations is itself a
 *     failure: the comparator exits non-zero telling the operator to delete
 *     the file. Zero baseline files in `scripts/ratchets/` is the healthy
 *     state.
 *
 * Every ratcheting gate MUST consume this module by import — a gate MUST NOT
 * re-implement the comparison loop. Later ratchets (R7/R11/S2 in subsequent
 * phases) reuse this comparator unchanged.
 *
 * Run standalone (canon shape — `node <script> && node --test <script>.test.mjs`):
 *
 *   node scripts/ratchets/comparator.mjs
 *
 * The standalone run audits the FORMAT of every committed baseline file in
 * this directory (three-field entries, positive counts, non-zero totals).
 * Comparing a baseline against a live measurement is each owning gate's job.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** The directory holding this module and every committed baseline file. */
export const RATCHETS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The three fields every baseline entry must carry. */
export const ENTRY_FIELDS = Object.freeze(['count', 'samples', 'change']);

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Map.prototype
  );
}

/**
 * Audits a parsed baseline's format: every entry must be an object carrying
 * `{count, samples[], change}` — a missing field is named together with its
 * entry. Counts must be positive integers (a zero-count entry is a stale
 * shell), samples must be a non-empty string array, change must name the
 * owning change.
 *
 * @param {unknown} baseline parsed baseline JSON
 * @returns {string[]} problems, empty when the format is sound
 */
export function auditBaselineFormat(baseline) {
  if (!isPlainObject(baseline)) {
    return [
      'baseline must be a JSON object mapping entry keys to {count, samples, change}',
    ];
  }
  const problems = [];
  for (const key of Object.keys(baseline).sort()) {
    const entry = baseline[key];
    if (!isPlainObject(entry)) {
      problems.push(`${key}: entry must be an object with {count, samples, change}`);
      continue;
    }
    for (const field of ENTRY_FIELDS) {
      if (!(field in entry)) problems.push(`${key}: missing field "${field}"`);
    }
    if ('count' in entry && (!Number.isInteger(entry.count) || entry.count < 1)) {
      problems.push(
        `${key}: count must be a positive integer — a zero-count entry is a stale shell, delete the entry`,
      );
    }
    if (
      'samples' in entry &&
      (!Array.isArray(entry.samples) ||
        entry.samples.length === 0 ||
        entry.samples.some((sample) => typeof sample !== 'string' || sample.trim() === ''))
    ) {
      problems.push(
        `${key}: samples must be a non-empty array of strings — the reviewer's anchor, never a match key`,
      );
    }
    if (
      'change' in entry &&
      (typeof entry.change !== 'string' || entry.change.trim() === '')
    ) {
      problems.push(
        `${key}: change must name the owning change responsible for eliminating the entry`,
      );
    }
  }
  return problems;
}

/**
 * Compares a gate's live measurement against a committed baseline with the
 * strict fail-on-stale semantics documented in the module header. The format
 * audit runs first — comparing malformed data would be meaningless.
 *
 * @param {Record<string, number> | Map<string, number>} measured
 *   the gate's live measurement: entry key → measured violation count.
 *   A key the gate did not measure counts as 0. Zero-count measured keys are
 *   equivalent to absent keys.
 * @param {unknown} baseline parsed baseline JSON (entry key → {count, samples, change})
 * @returns {string[]} problems, empty when measurement and baseline agree exactly
 */
export function compareToBaseline(measured, baseline) {
  const formatProblems = auditBaselineFormat(baseline);
  if (formatProblems.length > 0) return formatProblems;

  const measuredMap = new Map(
    measured instanceof Map ? measured : Object.entries(measured ?? {}),
  );
  const problems = [];
  for (const [key, count] of measuredMap) {
    if (!Number.isInteger(count) || count < 0) {
      problems.push(`${key}: measured count must be a non-negative integer`);
    }
  }
  if (problems.length > 0) return problems;

  const entryKeys = Object.keys(baseline);
  const total = entryKeys.reduce((sum, key) => sum + baseline[key].count, 0);
  if (total === 0) {
    return [
      'baseline tolerates zero violations in total — delete the baseline file; ' +
        'a ratchet that reaches zero ends by deleting its baseline, not by keeping an empty shell',
    ];
  }

  const keys = [...new Set([...entryKeys, ...measuredMap.keys()])].sort();
  for (const key of keys) {
    const tolerated = entryKeys.includes(key) ? baseline[key].count : 0;
    const found = measuredMap.get(key) ?? 0;
    if (found > tolerated) {
      problems.push(
        tolerated === 0
          ? `${key}: ${found} measured violation(s) with no baseline entry — new violations the baseline does not cover`
          : `${key}: measured ${found} exceeds the baselined ${tolerated} — ${found - tolerated} new violation(s) the baseline does not cover`,
      );
    } else if (found < tolerated) {
      problems.push(
        found === 0
          ? `${key}: stale entry — baseline tolerates ${tolerated} but 0 are measured; delete the entry in the same PR as the fix (delete the whole baseline file once it holds no entries)`
          : `${key}: stale entry — baseline tolerates ${tolerated} but only ${found} are measured; shrink count to ${found} in the same PR as the fix`,
      );
    }
  }
  return problems;
}

/**
 * Lists the committed baseline files (`*.json`) in a ratchets directory.
 *
 * @param {string} dirAbs
 * @returns {string[]} sorted file names (not paths)
 */
export function listBaselineFiles(dirAbs) {
  return readdirSync(dirAbs)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

/**
 * Reads and parses a baseline file. Gates load their committed baseline
 * through this so every consumer parses identically.
 *
 * @param {string} fileAbs
 * @returns {unknown} parsed baseline JSON
 */
export function readBaseline(fileAbs) {
  return JSON.parse(readFileSync(fileAbs, 'utf8'));
}

/**
 * Format-audits every baseline file in a ratchets directory: valid JSON,
 * three-field entries, non-zero totals. Zero files is the healthy state.
 *
 * @param {string} dirAbs
 * @returns {{ files: string[], problems: string[] }}
 */
export function auditRatchetsDir(dirAbs) {
  const files = listBaselineFiles(dirAbs);
  const problems = [];
  for (const file of files) {
    let baseline;
    try {
      baseline = readBaseline(path.join(dirAbs, file));
    } catch (error) {
      problems.push(`${file}: not valid JSON — ${error.message}`);
      continue;
    }
    for (const problem of auditBaselineFormat(baseline)) {
      problems.push(`${file}: ${problem}`);
    }
    if (
      isPlainObject(baseline) &&
      Object.values(baseline).every((entry) => isPlainObject(entry)) &&
      Object.values(baseline).reduce((sum, entry) => sum + (entry.count ?? 0), 0) === 0
    ) {
      problems.push(
        `${file}: baseline tolerates zero violations in total — delete the baseline file; ` +
          'a ratchet that reaches zero ends by deleting its baseline, not by keeping an empty shell',
      );
    }
  }
  return { files, problems };
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { files, problems } = auditRatchetsDir(RATCHETS_DIR);
  if (problems.length > 0) {
    console.error(`ratchets: ${problems.length} problem(s) in committed baselines:\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\nEvery entry needs {count, samples, change}; a zero-total baseline is deleted, not kept.',
    );
    process.exit(1);
  }
  if (files.length === 0) {
    console.log(
      'ratchets: no baseline files — the healthy state (a ratchet ends by deleting its baseline)',
    );
  } else {
    console.log(
      `ratchets: ${files.length} baseline file(s), every entry carrying {count, samples, change}:`,
    );
    for (const file of files) console.log(`  ${file}`);
    console.log(
      'ratchets: format audit only — each owning gate compares its baseline against the live measurement',
    );
  }
}
