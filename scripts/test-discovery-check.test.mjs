/**
 * Guards the test-discovery gate itself.
 *
 * The gate is the thing that stops the hand-written test allowlist from growing
 * back, so it needs to be provably able to fail. These cases build throwaway
 * workspaces on disk and run the real script against them.
 *
 * Run: node --test scripts/test-discovery-check.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'test-discovery-check.mjs');

/**
 * Build a throwaway workspace containing one package, then run the gate inside
 * it. `exclusions` is spliced into a copy of the script so the fixture can
 * exercise the exclusion list without mutating the real one.
 */
function runGate({ testScript, files, exclusions = '[]' }) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-gate-'));
  try {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    );
    const pkgDir = join(root, 'packages', 'sample');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@fixture/sample', scripts: { test: testScript } }, null, 2),
    );
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(pkgDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }

    const source = readFileSync(CHECK, 'utf8');
    const marker = 'const EXCLUSIONS = [];';
    assert.ok(source.includes(marker), 'gate must expose a substitutable exclusion list');
    const patched = source.replace(marker, `const EXCLUSIONS = ${exclusions};`);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const scriptPath = join(root, 'scripts', 'check.mjs');
    writeFileSync(scriptPath, patched);

    try {
      const stdout = execFileSync('node', [scriptPath], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return { code: 0, output: stdout };
    } catch (error) {
      return {
        code: error.status ?? 1,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


/**
 * Build a throwaway repository whose test files live OUTSIDE any package —
 * under `scripts/`, matched against the ROOT manifest's test scripts. This is
 * the scope the gate used to miss entirely.
 */
function runGateOnRepositoryScripts({ rootTestScript, files }) {
  const root = mkdtempSync(join(tmpdir(), 'discovery-gate-root-'));
  try {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(
        { name: 'fixture-root', scripts: rootTestScript ? { 'test:scripts': rootTestScript } : {} },
        null,
        2,
      ),
    );
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, 'scripts', rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const scriptPath = join(root, 'scripts', 'check.mjs');
    writeFileSync(scriptPath, readFileSync(CHECK, 'utf8'));
    try {
      const stdout = execFileSync('node', [scriptPath], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      return { code: 0, output: stdout };
    } catch (error) {
      return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a test file no runner would execute is reported and fails the gate', () => {
  const result = runGate({
    testScript: 'node --test "test/mounted.test.mjs"',
    files: {
      'test/mounted.test.mjs': '// named by the script\n',
      'test/forgotten.test.mjs': '// named by nothing\n',
    },
  });
  assert.equal(result.code, 1, 'gate must exit non-zero');
  assert.match(result.output, /forgotten\.test\.mjs/, 'names the undiscovered file');
  assert.doesNotMatch(result.output, /mounted\.test\.mjs/, 'does not name a covered file');
});

test('a glob covers files added later without touching any script', () => {
  const result = runGate({
    testScript: 'node --test "test/**/*.test.mjs"',
    files: {
      'test/one.test.mjs': '',
      'test/nested/two.test.mjs': '',
    },
  });
  assert.equal(result.code, 0, 'glob discovery leaves nothing undiscovered');
  assert.match(result.output, /all discovered by a runner/);
});

test('an excluded file passes the gate but stays visible in the list', () => {
  const result = runGate({
    testScript: 'node --test "test/mounted.test.mjs"',
    files: {
      'test/mounted.test.mjs': '',
      'test/quarantined.test.mjs': '',
    },
    exclusions: JSON.stringify([
      { file: 'packages/sample/test/quarantined.test.mjs', reason: 'needs a live daemon' },
    ]),
  });
  assert.equal(result.code, 0, 'an explicit exclusion is accepted');
  assert.match(result.output, /1 explicitly excluded/, 'the exclusion count is reported');
});

test('an exclusion naming a file that no longer exists fails the gate', () => {
  const result = runGate({
    testScript: 'node --test "test/**/*.test.mjs"',
    files: { 'test/one.test.mjs': '' },
    exclusions: JSON.stringify([
      { file: 'packages/sample/test/deleted.test.mjs', reason: 'stale entry' },
    ]),
  });
  assert.equal(result.code, 1, 'a stale exclusion must not rot silently');
  assert.match(result.output, /no longer exist/);
  assert.match(result.output, /deleted\.test\.mjs/);
});

test('a self-discovering runner covers its suffixes without naming paths', () => {
  const result = runGate({
    testScript: 'vitest run',
    files: {
      'src/component.test.ts': '',
      'src/other.test.tsx': '',
    },
  });
  assert.equal(result.code, 0, 'vitest discovers its own files by config');
});

test('a repository-level test file no root script would run is reported', () => {
  // The scope the gate used to miss: a test file outside every workspace
  // package. Sixteen such files existed, running nowhere, before this widened.
  const result = runGateOnRepositoryScripts({
    rootTestScript: 'node --test "scripts/mounted-*.test.mjs"',
    files: { 'orphan.test.mjs': 'export const x = 1;\n' },
  });
  assert.equal(result.code, 1, 'an unrun repository-level test must fail the gate');
  assert.match(result.output, /scripts\/orphan\.test\.mjs/);
});

test('a repository-level test file a root glob would run is silent', () => {
  const result = runGateOnRepositoryScripts({
    rootTestScript: 'node --test "scripts/*.test.mjs"',
    files: { 'covered.test.mjs': 'export const x = 1;\n' },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /all discovered by a runner/);
});

test('a root manifest with no test script leaves repository-level tests undiscovered', () => {
  // Guards the direction that would silently pass: reading no patterns must
  // mean "nothing is covered", never "everything is".
  const result = runGateOnRepositoryScripts({
    rootTestScript: null,
    files: { 'lonely.test.mjs': 'export const x = 1;\n' },
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /scripts\/lonely\.test\.mjs/);
});
