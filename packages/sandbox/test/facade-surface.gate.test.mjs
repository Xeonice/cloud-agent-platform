/**
 * Paired self-test for the facade surface gate (R6): proves the gate can go
 * RED for every failure class — wildcard re-export, unreviewed added export,
 * stale surface entry, kind flip, malformed expected data — and GREEN on a
 * matching pair. Runs the gate as a child process against throwaway fixtures
 * in a temp directory; the committed expected-surface data is never touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const gate = join(here, 'facade-surface.gate.mjs');

function runGate(entrySource, expectedData) {
  const dir = mkdtempSync(join(tmpdir(), 'facade-surface-gate-'));
  try {
    const entry = join(dir, 'index.ts');
    const expected = join(dir, 'expected.json');
    writeFileSync(entry, entrySource);
    writeFileSync(
      expected,
      typeof expectedData === 'string' ? expectedData : JSON.stringify(expectedData),
    );
    try {
      const stdout = execFileSync(process.execPath, [gate, entry, expected], {
        encoding: 'utf8',
      });
      return { code: 0, output: stdout };
    } catch (err) {
      return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MATCHING_ENTRY = [
  "export { alpha, beta } from './a.js';",
  "export type { Gamma } from './a.js';",
  '',
].join('\n');
const MATCHING_DATA = { values: ['alpha', 'beta'], types: ['Gamma'] };

test('matching entry and surface data is green', () => {
  const r = runGate(MATCHING_ENTRY, MATCHING_DATA);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /OK/);
});

test('a wildcard re-export line is red naming the ban', () => {
  const r = runGate(`export * from './a.js';\n${MATCHING_ENTRY}`, MATCHING_DATA);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /wildcard re-export/);
});

test('an export missing from the committed data is red naming the symbol', () => {
  const r = runGate(
    `${MATCHING_ENTRY}export { injected } from './b.js';\n`,
    MATCHING_DATA,
  );
  assert.notEqual(r.code, 0);
  assert.match(r.output, /UNREVIEWED EXPORT: `injected`/);
});

test('a stale committed entry the module no longer exports is red naming the symbol', () => {
  const r = runGate(MATCHING_ENTRY, {
    values: ['alpha', 'beta', 'ghost'],
    types: ['Gamma'],
  });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /STALE SURFACE ENTRY: `ghost`/);
});

test('a kind flip (value listed as type) is red in both directions', () => {
  const r = runGate(MATCHING_ENTRY, { values: ['alpha'], types: ['Gamma', 'beta'] });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /UNREVIEWED EXPORT: `beta` \(value\)/);
  assert.match(r.output, /STALE SURFACE ENTRY: `beta` \(type\)/);
});

test('malformed expected data is red naming the problem', () => {
  const missingTypes = runGate(MATCHING_ENTRY, { values: ['alpha', 'beta'] });
  assert.notEqual(missingTypes.code, 0);
  assert.match(missingTypes.output, /missing the `types` array/);

  const dupes = runGate(MATCHING_ENTRY, {
    values: ['alpha', 'alpha', 'beta'],
    types: ['Gamma'],
  });
  assert.notEqual(dupes.code, 0);
  assert.match(dupes.output, /lists "alpha" more than once/);

  const notJson = runGate(MATCHING_ENTRY, '{not json');
  assert.notEqual(notJson.code, 0);
  assert.match(notJson.output, /cannot load expected surface data/);
});

test('the real committed pair is green (facade matches reviewed surface)', () => {
  const stdout = execFileSync(process.execPath, [gate], { encoding: 'utf8' });
  assert.match(stdout, /OK/);
});
