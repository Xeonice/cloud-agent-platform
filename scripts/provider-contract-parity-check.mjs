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

/**
 * Directories holding provider packages. A provider test that builds
 * conformance suites must consult the participation ledger.
 */
const PROVIDER_TEST_DIRS = [
  'packages/sandbox-provider-aio/test',
  'packages/sandbox-provider-boxlite/test',
  'packages/sandbox-cloud-http/test',
];

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

function listTestFiles(root, dir) {
  const abs = path.join(root, dir);
  try {
    if (!statSync(abs).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(abs)
    .filter((name) => name.endsWith('.mjs') || name.endsWith('.ts'))
    .map((name) => path.join(dir, name));
}

export function findProviderContractViolations({
  root = ROOT,
  providerTestDirs = PROVIDER_TEST_DIRS,
  knownDistinctPairs = KNOWN_DISTINCT_PAIRS,
} = {}) {
  const violations = [];

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

  for (const dir of providerTestDirs) {
    for (const rel of listTestFiles(root, dir)) {
      let source;
      try {
        source = readFileSync(path.join(root, rel), 'utf8');
      } catch {
        continue;
      }
      if (!BUILDS_CONFORMANCE.test(source)) continue;
      if (USES_LEDGER.test(source)) continue;
      violations.push({
        kind: 'unledgered-conformance',
        detail:
          'builds conformance suites without a participation ledger, so what it ' +
          'runs is chosen by this file rather than derived from what the provider declares',
        file: rel,
      });
    }
  }

  return violations;
}

function main() {
  const violations = findProviderContractViolations();
  if (violations.length === 0) {
    console.log(
      'provider-contract-parity: one spelling per capability, and every provider suite is ledgered',
    );
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
