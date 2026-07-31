#!/usr/bin/env node
/**
 * Provider contract parity gate.
 *
 * `enforce-provider-contract-parity` made most of the provider axis a type
 * problem: capability classification and conformance coverage are total
 * mappings, and the provider families derive from one declaration, so adding
 * any of them is a compile error rather than a silent divergence.
 *
 * Two things a type cannot carry, which this checks:
 *
 *   1. **No new duplicate capability spelling.** `lifecycle.readopt` and
 *      `lifecycle.readoption` were the same capability under two names, carried
 *      by an alias reconciliation copied into several places. Types cannot say
 *      "these two strings must not mean the same thing", so a near-identical
 *      pair is flagged for a human to confirm.
 *   2. **Every provider suite goes through the participation ledger.** The
 *      ledger only enforces what a provider owes if it is actually consulted; a
 *      provider test that builds conformance suites without one has opted out of
 *      the mechanism, which is exactly what the mechanism exists to prevent.
 *
 * The set of packages this runs against is DISCOVERED, never hand-maintained:
 * a package participates when its sources build a conformance suite. The
 * previous shape was a hardcoded three-directory list, which is exactly how
 * `packages/sandbox-cloud-http` would have been silently dropped had it not
 * been remembered — and how the next provider package WILL be dropped, because
 * nobody edits a list they do not know exists. Discovery is recursive over the
 * workspace (no directory list, no name glob encoding today's package names),
 * and a scan that discovers ZERO participants exits non-zero instead of
 * passing on an empty set.
 *
 * Like the discovery and agent-identity gates, the lists here are reviewable
 * DATA rather than inline suppressions, and the gate self-tests so one that
 * stopped being able to fail would itself fail.
 *
 * Run: node scripts/provider-contract-parity-check.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Where the capability vocabulary is declared. */
const CAPABILITY_VOCABULARY = 'packages/sandbox-core/src/capabilities.ts';

/** Directory names never descended into while discovering packages. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.turbo',
  'coverage',
]);

/** File extensions a conformance-building source can have. */
const SOURCE_EXTENSIONS = ['.mjs', '.ts', '.tsx'];

/** Builds a conformance suite. */
const BUILDS_CONFORMANCE = /conformance\.create\w*ConformanceScenarios\s*\(/;
/** Consults the ledger. */
const USES_LEDGER = /createConformanceParticipationLedger\s*\(/;

/**
 * Capability pairs that ARE distinct despite one name containing the other.
 * Data, so admitting one is a reviewable diff rather than an inline suppression.
 *
 * Empty today, and deliberately so: the current vocabulary has no such pair.
 * (`transcript.retained-read` / `transcript.retained-source` share a prefix but
 * neither contains the other, so they never reach this list.) An entry here
 * should be rare — the usual answer to two names that look like one capability
 * is that they ARE one capability.
 */
const KNOWN_DISTINCT_PAIRS = [];

/**
 * Conformance-building files that legitimately run WITHOUT a participation
 * ledger: the shared implementation's own conformance run. The ledger derives
 * required families from a PROVIDER's declared capabilities; a suite exercising
 * the shared implementation that providers delegate to has no provider
 * declaration to derive from — the spec calls this stated indirect coverage
 * ("exercised by a shared implementation ... stated explicitly as the coverage
 * for that capability").
 *
 * Three fields each — file, reason, change — so every entry is owned debt or
 * owned coverage, never an anonymous suppression. A malformed entry fails the
 * gate's audit.
 *
 * @type {ReadonlyArray<{ file: string, reason: string, change: string }>}
 */
const SHARED_COVERAGE = [
  {
    file: 'packages/sandbox/test/provider-conformance.test.mjs',
    reason:
      'runs the workspace-git conformance scenarios against the SHARED staged ' +
      'materialize/deliver/classify implementation that providers delegate to; ' +
      'there is no provider declaration to derive a ledger from, and this run ' +
      'IS the stated indirect coverage for the workspace.git.* families',
    change: 'close-gate-blindspots-and-ci-hygiene',
  },
];

function isKnownDistinct(a, b, pairs) {
  return pairs.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}

/**
 * Two capability names are suspiciously alike when one is a prefix of the other
 * within the same namespace — the readopt/readoption shape.
 */
function looksLikeSameCapability(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (!longer.startsWith(shorter)) return false;
  const namespaceOf = (value) => value.slice(0, value.indexOf('.'));
  return namespaceOf(a) === namespaceOf(b);
}

function readCapabilityNames(root) {
  let source;
  try {
    source = readFileSync(path.join(root, CAPABILITY_VOCABULARY), 'utf8');
  } catch {
    return [];
  }
  const union = source.slice(
    source.indexOf('export type SandboxProviderCapability'),
  );
  const end = union.indexOf(';');
  const names = [...union.slice(0, end).matchAll(/'([a-z][a-z.-]*\.[a-z.-]+)'/g)].map(
    (match) => match[1],
  );
  return [...new Set(names)];
}

function isSourceFile(name) {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Recursively walk the workspace and return every package directory — a
 * directory carrying a `package.json` — below `root` (the workspace root's own
 * manifest is not a package). Files belong to their NEAREST enclosing package,
 * so a nested package's sources are never attributed to its parent.
 *
 * @returns {Array<{ dir: string, files: string[] }>} package dirs and their
 *   source files, both relative to `root`.
 */
function discoverPackages(root) {
  const packages = [];

  const walk = (dirAbs, pkg) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    let current = pkg;
    const isPackageDir =
      dirAbs !== root && entries.some((e) => e.isFile() && e.name === 'package.json');
    if (isPackageDir) {
      current = { dir: path.relative(root, dirAbs), files: [] };
      packages.push(current);
    }
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs, current);
      } else if (current && isSourceFile(entry.name)) {
        current.files.push(path.relative(root, abs));
      }
    }
  };

  walk(root, null);
  return packages;
}

/**
 * The packages the parity check runs against: DISCOVERED as the packages whose
 * sources build a conformance suite. A new provider package enters on its
 * first conformance test with no registration step, and no rename or move can
 * silently drop one — there is no list to forget.
 *
 * @returns {string[]} participating package dirs, relative to `root`, sorted.
 */
export function discoverConformanceParticipants({ root = ROOT } = {}) {
  return collectParticipants(root).map((pkg) => pkg.dir).sort();
}

function collectParticipants(root) {
  const participants = [];
  for (const pkg of discoverPackages(root)) {
    const building = [];
    for (const rel of pkg.files) {
      let source;
      try {
        source = readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      if (BUILDS_CONFORMANCE.test(source)) building.push({ rel, source });
    }
    if (building.length > 0) participants.push({ dir: pkg.dir, building });
  }
  return participants;
}

export function findProviderContractViolations({
  root = ROOT,
  knownDistinctPairs = KNOWN_DISTINCT_PAIRS,
  sharedCoverage = SHARED_COVERAGE,
} = {}) {
  const violations = [];

  for (const entry of sharedCoverage) {
    const missing = ['file', 'reason', 'change'].filter(
      (field) => typeof entry[field] !== 'string' || entry[field].trim() === '',
    );
    if (missing.length > 0) {
      violations.push({
        kind: 'malformed-shared-coverage',
        detail: `shared-coverage entry ${JSON.stringify(
          entry.file ?? entry,
        )} is missing: ${missing.join(', ')} — every entry carries file, reason, change`,
        file: typeof entry.file === 'string' ? entry.file : '(no file)',
      });
    }
  }

  const names = readCapabilityNames(root);
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (!looksLikeSameCapability(names[i], names[j])) continue;
      if (isKnownDistinct(names[i], names[j], knownDistinctPairs)) continue;
      violations.push({
        kind: 'duplicate-spelling',
        detail: `"${names[i]}" and "${names[j]}" look like one capability under two names`,
        file: CAPABILITY_VOCABULARY,
      });
    }
  }

  const participants = collectParticipants(root);
  if (participants.length === 0) {
    violations.push({
      kind: 'no-participants',
      detail:
        'discovery found ZERO packages whose sources build a conformance suite — ' +
        'a glob typo or directory move would look exactly like this, so an empty ' +
        'set fails instead of passing vacuously',
      file: '(workspace)',
    });
    return violations;
  }

  const coveredFiles = new Set(sharedCoverage.map((entry) => entry.file));
  for (const pkg of participants) {
    for (const { rel, source } of pkg.building) {
      if (USES_LEDGER.test(source)) continue;
      if (coveredFiles.has(rel)) continue;
      violations.push({
        kind: 'unledgered-conformance',
        detail:
          `package ${pkg.dir} builds conformance suites without a participation ledger, ` +
          'so what it runs is chosen by this file rather than derived from what the ' +
          'provider declares',
        file: rel,
      });
    }
  }

  return violations;
}

function main() {
  const participants = discoverConformanceParticipants();
  const violations = findProviderContractViolations();
  if (violations.length === 0) {
    console.log(
      `provider-contract-parity: one spelling per capability, and every provider suite is ledgered (${participants.length} discovered participant(s))`,
    );
    for (const dir of participants) console.log(`  ${dir}`);
    return;
  }
  console.error(`provider-contract-parity: ${violations.length} violation(s):\n`);
  for (const violation of violations) {
    console.error(`  [${violation.kind}] ${violation.file}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    '\nA capability must have ONE internal spelling; a deprecated one is normalized',
  );
  console.error(
    'at the configuration boundary. A provider suite must derive what it runs from',
  );
  console.error('the provider\'s declared capabilities, via the participation ledger.');
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main();
}
