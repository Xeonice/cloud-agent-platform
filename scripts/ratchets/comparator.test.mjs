/**
 * Self-test for the shared ratchet-baseline comparator.
 *
 * Proves — against inline fixtures and throwaway temp directories, never by
 * touching a committed baseline file — that the comparator goes red on every
 * path it exists to catch: a count above baseline (new violation), a count
 * below baseline (stale entry), a malformed entry (missing one of the three
 * fields), and a zero-total baseline (an empty shell that should have been
 * deleted). Canon invocation:
 *
 *   node scripts/ratchets/comparator.mjs && node --test scripts/ratchets/comparator.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  RATCHETS_DIR,
  auditBaselineFormat,
  auditRatchetsDir,
  compareToBaseline,
} from './comparator.mjs';

const COMPARATOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'comparator.mjs',
);

/** A well-formed two-entry baseline used as the fixture default. */
function fixtureBaseline() {
  return {
    'apps/api/src/a/a.service.ts': {
      count: 3,
      samples: ["a.service.ts:3 import Docker from 'dockerode'"],
      change: '阶段 7a 端口化根治',
    },
    'apps/api/src/b/b.validator.ts': {
      count: 1,
      samples: ["b.validator.ts:9 import Docker from 'dockerode'"],
      change: '阶段 7a 端口化根治',
    },
  };
}

test('green: a measurement matching every baselined count exactly passes', () => {
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 3, 'apps/api/src/b/b.validator.ts': 1 },
    fixtureBaseline(),
  );
  assert.deepEqual(problems, []);
});

test('green: comparison keys on COUNT — changed samples do not break the baseline', () => {
  // The refactor-survival scenario: code inside a baselined file moved, the
  // recorded sample locations are stale as documentation, but the violation
  // count is unchanged — the gate still passes. Samples are never match keys.
  const baseline = fixtureBaseline();
  baseline['apps/api/src/a/a.service.ts'].samples = [
    'a.service.ts:812 (moved by an unrelated refactor)',
  ];
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 3, 'apps/api/src/b/b.validator.ts': 1 },
    baseline,
  );
  assert.deepEqual(problems, []);
});

test('red: a count above baseline names the entry and the uncovered violations', () => {
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 5, 'apps/api/src/b/b.validator.ts': 1 },
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/api\/src\/a\/a\.service\.ts/);
  assert.match(problems[0], /measured 5 exceeds the baselined 3/);
  assert.match(problems[0], /2 new violation\(s\) the baseline does not cover/);
});

test('red: a measured violation with no baseline entry is uncovered', () => {
  const problems = compareToBaseline(
    {
      'apps/api/src/a/a.service.ts': 3,
      'apps/api/src/b/b.validator.ts': 1,
      'apps/api/src/c/brand-new.ts': 2,
    },
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/api\/src\/c\/brand-new\.ts/);
  assert.match(problems[0], /no baseline entry/);
  assert.match(problems[0], /does not cover/);
});

test('red: a stale entry names the entry and the lower count it must shrink to', () => {
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 2, 'apps/api/src/b/b.validator.ts': 1 },
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/api\/src\/a\/a\.service\.ts/);
  assert.match(problems[0], /stale entry/);
  assert.match(problems[0], /tolerates 3 but only 2 are measured/);
  assert.match(problems[0], /shrink count to 2 in the same PR/);
});

test('red: an entry whose violations are all fixed must be deleted, not kept', () => {
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 3 },
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/api\/src\/b\/b\.validator\.ts/);
  assert.match(problems[0], /0 are measured/);
  assert.match(problems[0], /delete the entry/);
});

test('red: an entry missing count, samples, or change is named with its missing field', () => {
  for (const field of ['count', 'samples', 'change']) {
    const baseline = fixtureBaseline();
    delete baseline['apps/api/src/a/a.service.ts'][field];
    const problems = compareToBaseline(
      { 'apps/api/src/a/a.service.ts': 3, 'apps/api/src/b/b.validator.ts': 1 },
      baseline,
    );
    assert.equal(problems.length, 1, `expected exactly one problem for missing ${field}`);
    assert.match(problems[0], /apps\/api\/src\/a\/a\.service\.ts/);
    assert.match(problems[0], new RegExp(`missing field "${field}"`));
  }
});

test('red: a zero-count entry, an empty samples array, and an empty change are malformed', () => {
  const baseline = fixtureBaseline();
  baseline['apps/api/src/a/a.service.ts'].count = 0;
  baseline['apps/api/src/a/a.service.ts'].samples = [];
  baseline['apps/api/src/a/a.service.ts'].change = '  ';
  const problems = auditBaselineFormat(baseline);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /count must be a positive integer/);
  assert.match(problems[1], /samples must be a non-empty array of strings/);
  assert.match(problems[2], /change must name the owning change/);
});

test('red: a baseline that is not an object of entries is rejected', () => {
  assert.notDeepEqual(auditBaselineFormat(null), []);
  assert.notDeepEqual(auditBaselineFormat([{ count: 1 }]), []);
  assert.notDeepEqual(auditBaselineFormat({ 'a.ts': 3 }), []);
});

test('red: a zero-total baseline tells the operator to delete the file', () => {
  const problems = compareToBaseline({}, {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /zero violations in total/);
  assert.match(problems[0], /delete the baseline file/);
});

test('red: a non-integer measured count is rejected before comparison', () => {
  const problems = compareToBaseline(
    { 'apps/api/src/a/a.service.ts': 2.5 },
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /measured count must be a non-negative integer/);
});

test('measured input may be a Map and unmeasured baseline keys count as 0', () => {
  const problems = compareToBaseline(
    new Map([['apps/api/src/a/a.service.ts', 3]]),
    fixtureBaseline(),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /apps\/api\/src\/b\/b\.validator\.ts/);
  assert.match(problems[0], /stale entry/);
});

test('dir audit: an empty ratchets directory is the healthy state', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ratchets-empty-'));
  try {
    const { files, problems } = auditRatchetsDir(dir);
    assert.deepEqual(files, []);
    assert.deepEqual(problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dir audit: invalid JSON, malformed entries, and zero-total files are named', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ratchets-red-'));
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    writeFileSync(
      path.join(dir, 'malformed.json'),
      JSON.stringify({ 'x.ts': { count: 1, samples: ['x.ts:1'] } }),
    );
    writeFileSync(path.join(dir, 'zero-total.json'), '{}');
    const { files, problems } = auditRatchetsDir(dir);
    assert.deepEqual(files, ['broken.json', 'malformed.json', 'zero-total.json']);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /broken\.json: not valid JSON/);
    assert.match(problems[1], /malformed\.json: x\.ts: missing field "change"/);
    assert.match(problems[2], /zero-total\.json: .*delete the baseline file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('standalone: the comparator audits the committed ratchets dir and exits zero', () => {
  // The canon `node <script>` half. This runs against the REAL directory but
  // only reads it — the committed state must always be green (zero baseline
  // files is the healthy state; any committed baseline must be well-formed).
  const result = spawnSync(process.execPath, [COMPARATOR], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ratchets:/);
});

test('the committed ratchets dir currently holds no malformed baseline', () => {
  const { problems } = auditRatchetsDir(RATCHETS_DIR);
  assert.deepEqual(problems, []);
});
