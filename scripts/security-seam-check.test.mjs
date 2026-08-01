/**
 * Guards the R9 security-seam gate.
 *
 * The failure this gate exists to prevent is quiet: a security seam gets a
 * second implementation, or moves away from the path the D table registers, and
 * everything still compiles and passes. So the cases that matter here are the
 * gate's RED paths, plus the two ways a seam gate can pass while proving
 * nothing — an empty seam set and an empty scan.
 *
 * Everything runs against committed fixtures under
 * `scripts/fixtures/security-seam-check/`; the real tree is never touched. The
 * three spec-named red paths are also driven through the executable so the
 * non-zero EXIT is proven, not just the violation list.
 *
 * Run: node --test scripts/security-seam-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { findSeamViolations } from './security-seam-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'security-seam-check.mjs');
const FIXTURES = path.join(HERE, 'fixtures', 'security-seam-check');

const tree = (name) => path.join(FIXTURES, 'trees', name);
const manifest = (name) => path.join(FIXTURES, 'manifests', `${name}.json`);

function scan(treeName, manifestName = 'healthy') {
  return findSeamViolations({ root: tree(treeName), manifestPath: manifest(manifestName) });
}

/** Run the gate the way CI runs it, and report what an operator would see. */
function run(treeName, manifestName = 'healthy') {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', tree(treeName), '--manifest', manifest(manifestName)],
    { encoding: 'utf8' },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const kinds = (violations) => violations.map((violation) => violation.kind);

// ---- healthy ---------------------------------------------------------------

test('a tree where every declared seam exists once passes', () => {
  assert.deepEqual(scan('healthy'), []);
  const { status, out } = run('healthy');
  assert.equal(status, 0, out);
  assert.match(out, /2 registered seam\(s\) exist/);
});

test('consumers importing a seam do not trip uniqueness', () => {
  // auth.guard.ts imports and calls isTrustedRequestOrigin. A predicate written
  // the way the DEFINITION is written is what makes that free — a call site is
  // not a second implementation.
  const violations = scan('healthy');
  assert.deepEqual(
    violations,
    [],
    'an importing consumer must not be counted as a duplicate implementation',
  );
});

test('an excluded test double does not count as an implementation', () => {
  // request-origin.legacy-spec.ts redefines the seam and is excluded by the
  // manifest entry; if the exclude were ignored the healthy tree would be red.
  assert.deepEqual(scan('healthy'), []);
});

// ---- red paths -------------------------------------------------------------

test('a missing seam file is red, naming the seam and its expected path', () => {
  const violations = scan('missing');
  assert.deepEqual(kinds(violations), ['missing-seam']);
  assert.equal(violations[0].seam, 'origin-computation');
  assert.match(violations[0].detail, /apps\/api\/src\/auth\/request-origin\.ts/);

  const { status, out } = run('missing');
  assert.equal(status, 1);
  assert.match(out, /missing-seam/);
});

test('a duplicate implementation is red, naming canonical and duplicate', () => {
  const violations = scan('duplicate');
  assert.deepEqual(kinds(violations), ['duplicate-implementation']);
  assert.match(violations[0].detail, /apps\/api\/src\/auth\/request-origin\.ts/);
  assert.match(violations[0].detail, /apps\/api\/src\/terminal\/origin-copy\.ts/);

  const { status, out } = run('duplicate');
  assert.equal(status, 1);
  assert.match(out, /duplicate-implementation/);
});

test('an empty seam set is red rather than a vacuous pass', () => {
  const violations = scan('healthy', 'empty-seams');
  assert.deepEqual(kinds(violations), ['empty-seam-set']);

  const { status, out } = run('healthy', 'empty-seams');
  assert.equal(status, 1);
  assert.match(out, /empty-seam-set/);
});

test('an entry missing its change provenance is rejected as malformed', () => {
  const violations = scan('healthy', 'malformed-entry');
  assert.deepEqual(kinds(violations), ['malformed-entry']);
  assert.match(violations[0].detail, /`change`/);
});

test('scan roots that resolve to zero files fail the seam', () => {
  const violations = scan('healthy', 'empty-scan');
  assert.deepEqual(kinds(violations), ['empty-scan']);
  assert.match(violations[0].detail, /empty scan/);
});

test('an absent manifest is red — the gate keeps no copy of the seam list', () => {
  const violations = findSeamViolations({
    root: tree('healthy'),
    manifestPath: path.join(FIXTURES, 'manifests', 'does-not-exist.json'),
  });
  assert.deepEqual(kinds(violations), ['manifest-missing']);
});

test('the gate holds no hardcoded seam path or predicate', () => {
  // The seam list is manifest data. If a path or predicate were pasted into the
  // script, editing the manifest would stop being the way to move a seam.
  const source = readFileSync(SCRIPT, 'utf8');
  const body = source.slice(source.indexOf('*/') + 2);
  assert.doesNotMatch(body, /apps\/api\/src\//, 'no seam path may be embedded in the gate');
  assert.doesNotMatch(
    body,
    /decryptStored|assertSafeProviderUrl|isTrustedRequestOrigin/,
    'no uniqueness predicate may be embedded in the gate',
  );
});
