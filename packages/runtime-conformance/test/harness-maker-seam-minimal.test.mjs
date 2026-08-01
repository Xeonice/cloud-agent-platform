/**
 * Minimal ground-truth check for the requirement:
 * "The conformance suite owns all test logic behind a harness-maker seam"
 * (openspec/changes/unlock-extension-axes/specs/runtime-conformance/spec.md).
 *
 * Exercises the "Codex and claude participate through harness makers only"
 * scenario directly against the real source files on disk (no mocking):
 *
 *   WHEN the suite's per-runtime entry points are inspected
 *   THEN each runtime supplies a harness maker (construction + environment
 *        hooks) and zero scenario assertions, and every assertion lives in
 *        suite-owned shared scenario modules.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');

const RUNTIME_HARNESS_FILES = [
  join(SRC, 'runtimes', 'codex.harness.ts'),
  join(SRC, 'runtimes', 'claude-code.harness.ts'),
];

// Markers that would indicate a runtime entry point is contributing scenario
// assertion logic of its own, rather than only construction + environment
// hook data.
const ASSERTION_MARKERS = [
  /\bnode:assert\b/,
  /(^|[^.\w])node:test\b/,
  /\bassert\s*\.\s*(equal|deepEqual|ok|match|rejects|throws)\s*\(/,
  /\bdescribe\s*\(/,
  /\bit\s*\(\s*['"`]/,
  /\btest\s*\(\s*['"`]/,
  /\bexpect\s*\(/,
];

test('each per-runtime entry point supplies zero scenario assertions', () => {
  for (const file of RUNTIME_HARNESS_FILES) {
    const source = readFileSync(file, 'utf8');
    for (const marker of ASSERTION_MARKERS) {
      assert.equal(
        marker.test(source),
        false,
        `${file} must contribute construction + hooks only, but matched assertion marker ${marker}`,
      );
    }
  }
});

test('every assertion lives in suite-owned shared scenario modules', () => {
  const scenariosDir = join(SRC, 'scenarios');
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith('.ts'));

  // Five scenario families per the requirement's sibling spec: launch,
  // lifecycle, transcript, headless, secret-canary.
  assert.deepEqual(
    files.map((f) => f.replace(/\.ts$/, '')).sort(),
    ['headless', 'launch', 'lifecycle', 'secret-canary', 'transcript'],
    'exactly the five scenario family modules own assertion logic',
  );

  for (const file of files) {
    const source = readFileSync(join(scenariosDir, file), 'utf8');
    assert.match(
      source,
      /node:assert/,
      `${file} is expected to own real assertion logic (import node:assert)`,
    );
  }
});
