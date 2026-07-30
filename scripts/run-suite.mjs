#!/usr/bin/env node
/**
 * Runs a package's test glob, minus the quarantined suites, and says so.
 *
 * `node --test "<glob>"` cannot exclude a file, so a quarantined suite would
 * otherwise have to be excluded by editing the glob — which is how a skip
 * becomes invisible. This wrapper expands the glob itself, removes what
 * `quarantined-suites.mjs` lists, and prints every removal with its reason
 * before running anything. A skip nobody can miss is the whole point.
 *
 *   node scripts/run-suite.mjs "src/**\/*.test.mjs"        # skip quarantined
 *   node scripts/run-suite.mjs --only-quarantined "<glob>"  # run ONLY those
 *
 * The second mode is what stops the list from becoming permanent: a quarantined
 * suite that passes is a suite to release.
 */

import { globSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  QUARANTINED_SUITES,
  auditQuarantine,
} from './quarantined-suites.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const onlyQuarantined = argv.includes('--only-quarantined');
const patterns = argv.filter((arg) => !arg.startsWith('--'));

if (patterns.length === 0) {
  console.error('run-suite: at least one glob is required');
  process.exit(2);
}

const problems = auditQuarantine((rel) => existsSync(path.join(ROOT, rel)));
if (problems.length > 0) {
  console.error('run-suite: the quarantine list is not honest:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nAn entry must name a real file, a reason, the evidence, and the change that removes it.',
  );
  process.exit(1);
}

/** Absolute repo-relative paths of everything the glob matches, sorted. */
const matched = [
  ...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: process.cwd() }))),
]
  .map((file) => path.relative(ROOT, path.resolve(process.cwd(), file)))
  .sort();

const quarantinedHere = QUARANTINED_SUITES.filter((suite) =>
  matched.includes(suite.file),
);
const quarantinedSet = new Set(quarantinedHere.map((suite) => suite.file));
const selected = onlyQuarantined
  ? matched.filter((file) => quarantinedSet.has(file))
  : matched.filter((file) => !quarantinedSet.has(file));

if (onlyQuarantined && selected.length === 0) {
  console.log('run-suite: nothing quarantined in this glob.');
  process.exit(0);
}

if (!onlyQuarantined && quarantinedHere.length > 0) {
  console.log(
    `\n[33m▲ ${quarantinedHere.length} suite(s) QUARANTINED — not run below[0m`,
  );
  for (const suite of quarantinedHere) {
    console.log(`\n  ${suite.file}`);
    console.log(`    why      ${suite.reason}`);
    console.log(`    evidence ${suite.evidence}`);
    console.log(`    tracked  ${suite.change}`);
  }
  console.log(
    `\n  Run them with: node scripts/run-suite.mjs --only-quarantined "${patterns.join('" "')}"\n`,
  );
}

if (selected.length === 0) {
  console.error('run-suite: the glob matched nothing — a suite that runs no tests is not a passing suite');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-force-exit', ...selected.map((file) => path.join(ROOT, file))],
  { stdio: 'inherit', cwd: process.cwd() },
);
process.exit(result.status ?? 1);
