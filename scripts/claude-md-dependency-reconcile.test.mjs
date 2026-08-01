/**
 * Guards the R10 CLAUDE.md ⇄ manifest reconciliation gate.
 *
 * The whole value of this gate is in what it REFUSES to do quietly: skip a file
 * whose section is missing, believe a section that contradicts the A table, or
 * report success after examining nothing. So the cases below are the red paths,
 * plus the two shapes of "passed without proving anything" — an empty A table
 * and an empty governed set.
 *
 * The section parser gets its own cases because it decides what counts as a
 * declaration, and "no packages named" must split into `None` (a real, empty
 * declaration) and unreadable prose (a rejection).
 *
 * Everything runs against committed fixtures under
 * `scripts/fixtures/claude-md-dependency-reconcile/`; the real tree is never
 * touched. The three spec-named red paths are also driven through the
 * executable so the non-zero EXIT is proven, not just the violation list.
 *
 * Run: node --test scripts/claude-md-dependency-reconcile.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  findDependencyMismatches,
  readDependencySection,
  rootIsInsideSubtree,
} from './claude-md-dependency-reconcile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'claude-md-dependency-reconcile.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'claude-md-dependency-reconcile');

const GOVERNED = ['apps/web', 'packages/contracts'];

const tree = (name) => path.join(FIXTURES, 'trees', name);
const manifest = (name) => path.join(FIXTURES, 'manifests', `${name}.json`);

function scan(treeName, manifestName = 'healthy', governed = GOVERNED) {
  return findDependencyMismatches({
    root: tree(treeName),
    manifestPath: manifest(manifestName),
    governed,
  });
}

/** Run the gate the way CI runs it, and report what an operator would see. */
function run(treeName, manifestName = 'healthy', governed = GOVERNED) {
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--root',
      tree(treeName),
      '--manifest',
      manifest(manifestName),
      '--governed',
      governed.join(','),
    ],
    { encoding: 'utf8' },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const kinds = (violations) => violations.map((violation) => violation.kind);

// ---- aligned ---------------------------------------------------------------

test('sections that agree with the A table pass', () => {
  assert.deepEqual(scan('aligned'), []);
  const { status, out } = run('aligned');
  assert.equal(status, 0, out);
  assert.match(out, /agree with the boundaries manifest/);
});

test('only the first paragraph is the declaration', () => {
  // The aligned fixture names `@cap-console/api` in its commentary to explain
  // that the console cannot reach it. Prose about a forbidden dependency is not
  // a claim to have one, and reading it as one would make honest docs unwritable.
  assert.deepEqual(scan('aligned'), []);
});

// ---- red paths -------------------------------------------------------------

test('a declaration the A table forbids is red, naming file and entry', () => {
  const violations = scan('contradicting');
  assert.deepEqual(kinds(violations), ['contradicting-declaration']);
  assert.equal(violations[0].file, 'apps/web/CLAUDE.md');
  assert.match(violations[0].detail, /@cap-console\/sandbox-core/);
  assert.match(violations[0].detail, /P1/);

  const { status, out } = run('contradicting');
  assert.equal(status, 1);
  assert.match(out, /contradicting-declaration/);
});

test('a missing section is rejected by name, not skipped', () => {
  const violations = scan('missing-section');
  assert.deepEqual(kinds(violations), ['missing-section']);
  assert.equal(violations[0].file, 'apps/web/CLAUDE.md');

  const { status, out } = run('missing-section');
  assert.equal(status, 1);
  assert.match(out, /missing-section/);
  assert.match(out, /apps\/web\/CLAUDE\.md/, 'the rejected file must be named in the output');
});

test('zero governed files resolved is red, and the empty set is reported', () => {
  const violations = scan('empty');
  assert.ok(kinds(violations).includes('empty-governed-set'), kinds(violations).join(', '));

  const { status, out } = run('empty');
  assert.equal(status, 1);
  assert.match(out, /empty-governed-set/);
  assert.match(out, /zero governed CLAUDE\.md files/);
});

test('an empty A table is red rather than agreeing with everything', () => {
  const violations = scan('aligned', 'empty-a-table');
  assert.deepEqual(kinds(violations), ['empty-a-table']);
});

test('an A-table entry missing its provenance is rejected as malformed', () => {
  const violations = scan('aligned', 'malformed-entry');
  assert.deepEqual(kinds(violations), ['malformed-entry']);
  assert.match(violations[0].detail, /`provenance`/);
});

test('a subtree governed only by a by-reference entry has nothing to reconcile', () => {
  // P3/P7 are registered by reference and deliberately carry no rule data. If
  // such an entry counted as governance, the doc would be "checked" against an
  // empty pattern list and pass whatever it declared.
  const violations = scan('aligned', 'reference-only', ['apps/web']);
  assert.deepEqual(kinds(violations), ['no-governing-rule']);
});

test('an absent manifest is red — the gate keeps no copy of the dependency rules', () => {
  const violations = findDependencyMismatches({
    root: tree('aligned'),
    manifestPath: manifest('does-not-exist'),
    governed: GOVERNED,
  });
  assert.deepEqual(kinds(violations), ['manifest-missing']);
});

// ---- the section parser ----------------------------------------------------

test('a package list is read as the declared set', () => {
  const section = readDependencySection(
    ['# x', '', '## What this subtree may depend on', '', '`@cap-console/contracts` · `@cap-console/ui`', ''].join('\n'),
  );
  assert.deepEqual(section.packages, ['@cap-console/contracts', '@cap-console/ui']);
});

test('a wrapped list is one declaration, not just its first line', () => {
  const section = readDependencySection(
    [
      '## What this subtree may depend on',
      '',
      '`@cap-console/contracts` ·',
      '`@cap-console/sandbox-core`',
      '',
      'commentary',
    ].join('\n'),
  );
  assert.deepEqual(section.packages, ['@cap-console/contracts', '@cap-console/sandbox-core']);
});

test('"None" is an empty declaration, unreadable prose is a rejection', () => {
  const none = readDependencySection(
    ['## What this subtree may depend on', '', 'None — nothing but tooling config.'].join('\n'),
  );
  assert.deepEqual(none.packages, []);

  const prose = readDependencySection(
    ['## What this subtree may depend on', '', 'It depends on the situation, really.'].join('\n'),
  );
  assert.equal(prose.problem, 'unparseable-section');
});

test('an empty section is unparseable rather than an empty set', () => {
  const section = readDependencySection(
    ['## What this subtree may depend on', '', '## Next'].join('\n'),
  );
  assert.equal(section.problem, 'unparseable-section');
});

test('"None" followed by package names is ambiguous, and ambiguity is red', () => {
  const section = readDependencySection(
    ['## What this subtree may depend on', '', 'None, apart from `@cap-console/contracts`.'].join('\n'),
  );
  assert.equal(section.problem, 'ambiguous-declaration');
});

// ---- scan-root matching ----------------------------------------------------

test('a wildcard scan root matches the subtrees it spans, and only those', () => {
  assert.equal(rootIsInsideSubtree('packages/*/src', 'packages/contracts'), true);
  assert.equal(rootIsInsideSubtree('packages/*/src', 'apps/web'), false);
  assert.equal(rootIsInsideSubtree('apps/web/src', 'apps/web'), true);
  assert.equal(rootIsInsideSubtree('apps/web/src', 'apps/api'), false);
  assert.equal(
    rootIsInsideSubtree('packages/sandbox-core/src', 'packages/sandbox'),
    false,
    'sandbox-core is a different package from the sandbox facade',
  );
});

// ---- the gate holds no rule data ------------------------------------------

test('the gate embeds no dependency rule of its own', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const body = source.slice(source.indexOf('*/') + 2);
  assert.doesNotMatch(
    body,
    /@cap-console\/(api|web|ui|sandbox|contracts)\b/,
    'the forbidden/allowed package names are manifest data, not gate data',
  );
});
