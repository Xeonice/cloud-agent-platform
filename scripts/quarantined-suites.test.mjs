import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  QUARANTINED_SUITES,
  QUARANTINED_FILES,
  auditQuarantine,
  auditQuarantineEntries,
} from './quarantined-suites.mjs';

/**
 * Guards the quarantine list against becoming the thing it replaced.
 *
 * A skip list is not dangerous because it exists; it is dangerous when nobody
 * can see it, when entries outlive their reason, and when adding one is easier
 * than fixing the test. These tests attack all three: the list must be printed,
 * every entry must carry its reason and the change accountable for it, and a
 * suite that no longer exists must not linger.
 *
 * Run: node --test scripts/quarantined-suites.test.mjs
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('every entry names a real file, a reason, evidence, and a tracking change', () => {
  const problems = auditQuarantine((rel) => existsSync(path.join(ROOT, rel)));
  assert.deepEqual(
    problems,
    [],
    'a quarantine entry that cannot say what fails and who removes it is an unexplained skip',
  );
});

test('an empty list is the healthy state, and the mechanism survives it', () => {
  // The list emptied on 2026-07-31 (close-gate-blindspots-and-ci-hygiene).
  // This does NOT forbid future entries — it proves the machinery keeps
  // working with nothing in it, which is how forty invisible skips began.
  assert.deepEqual(
    auditQuarantineEntries([], () => false),
    [],
    'zero entries must audit clean without touching the filesystem',
  );
  assert.deepEqual(
    auditQuarantine(() => true),
    [],
    'the live list must pass its own audit',
  );
});

test('the audit rejects the shapes an entry decays into', () => {
  const always = () => true;
  const never = () => false;
  const honest = {
    file: 'scripts/example.test.mjs',
    reason: 'fails on the runner in a way the fixture describes fully',
    evidence: 'four runner logs captured and compared across reruns',
    change: 'some-accountable-openspec-change',
  };

  assert.deepEqual(
    auditQuarantineEntries([honest], always),
    [],
    'a fully attributed entry naming a real file must pass',
  );

  assert.notEqual(
    auditQuarantineEntries([honest], never).length,
    0,
    'a listed file that no longer exists must be reported, not silently ignored',
  );

  assert.notEqual(
    auditQuarantineEntries([honest, { ...honest }], always).length,
    0,
    'the same file listed twice would let one reason hide behind another',
  );

  assert.notEqual(
    auditQuarantineEntries([{ ...honest, file: '' }], always).length,
    0,
    'an entry without a file is an unattributed skip',
  );

  // A FUTURE entry must carry all three attribution fields; each missing or
  // vacuous field must be named individually.
  for (const field of ['reason', 'evidence', 'change']) {
    for (const value of [undefined, '', 'too short']) {
      const problems = auditQuarantineEntries(
        [{ ...honest, [field]: value }],
        always,
      );
      assert.ok(
        problems.some((problem) => problem.includes(field)),
        `an entry with ${field}=${JSON.stringify(value)} must fail the audit naming "${field}"`,
      );
    }
  }
});

test('the runner refuses to run when the list is dishonest', () => {
  const runner = read('scripts/run-suite.mjs');
  assert.match(
    runner,
    /auditQuarantine/u,
    'the runner must audit before running, not merely at review time',
  );
  assert.match(
    runner,
    /process\.exit\(1\)/u,
    'a dishonest list must stop the suite rather than degrade it',
  );
});

test('a skipped suite is announced, with its reason, every run', () => {
  const runner = read('scripts/run-suite.mjs');
  assert.match(runner, /QUARANTINED/u, 'the banner must name what it is');
  for (const field of ['reason', 'evidence', 'change']) {
    assert.match(
      runner,
      new RegExp(`suite\\.${field}`, 'u'),
      `the banner must print ${field}; a skip without its reason on screen is the invisible kind`,
    );
  }
});

test('an empty glob is a failure, not a pass', () => {
  const runner = read('scripts/run-suite.mjs');
  assert.match(
    runner,
    /matched nothing/u,
    'a suite that runs zero tests must fail — that is precisely how forty suites went unnoticed',
  );
});

test('quarantined suites can still be run on purpose', () => {
  const runner = read('scripts/run-suite.mjs');
  assert.match(
    runner,
    /--only-quarantined/u,
    'without a way to run them, the list has no path back to empty',
  );
  const root = JSON.parse(read('package.json'));
  assert.ok(
    root.scripts['test:quarantined'],
    'the escape hatch must be a named script, not folklore',
  );
});

test('the discovery gate and the runner read one list', () => {
  const discovery = read('scripts/test-discovery-check.mjs');
  assert.match(
    discovery,
    /quarantined-suites\.mjs/u,
    'two lists would drift; the gate must consume the same file the runner does',
  );
  assert.ok(
    QUARANTINED_FILES.size === QUARANTINED_SUITES.length,
    'duplicate entries would let one reason hide behind another',
  );
});
