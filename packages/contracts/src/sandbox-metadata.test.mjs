import assert from 'node:assert/strict';
import test from 'node:test';

import { SandboxMetadataSchema, parseSandboxMetadataText } from '../dist/sandbox-metadata.js';

test('accepts official and builder-declared custom dependencies', () => {
  const metadata = SandboxMetadataSchema.parse({
    schemaVersion: 1,
    sandboxVersion: 'v0.37.0-rc.1+build.4',
    dependencies: {
      codex: '0.132.0',
      'claude-code': '2.1.181',
      openspec: '1.4.1',
      'company-cli': '2026.07.10',
      'source-revision': 'git:4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    },
  });
  assert.equal(metadata.dependencies['company-cli'], '2026.07.10');
});

test('rejects malformed, unsupported, empty, and moving metadata', () => {
  for (const value of [
    { schemaVersion: 2, sandboxVersion: 'v1.0.0', dependencies: { codex: '1.0.0' } },
    { schemaVersion: 1, sandboxVersion: '', dependencies: { codex: '1.0.0' } },
    { schemaVersion: 1, sandboxVersion: 'latest', dependencies: { codex: '1.0.0' } },
    { schemaVersion: 1, sandboxVersion: 'v1.0.0', dependencies: {} },
    { schemaVersion: 1, sandboxVersion: 'v1.0.0', dependencies: { Codex: '1.0.0' } },
    { schemaVersion: 1, sandboxVersion: 'v1.0.0', dependencies: { codex: 'latest' } },
  ]) {
    assert.equal(SandboxMetadataSchema.safeParse(value).success, false);
  }
  assert.throws(() => parseSandboxMetadataText('{not-json'), /invalid sandbox metadata JSON/);
});

test('rejects moving tags, semver ranges, partial versions, and wildcards', () => {
  const selectors = [
    'latest',
    'NEXT',
    '^1.2.3',
    '~1.2.3',
    '1.x',
    '1.*',
    '1.2',
    '>=1.2.3',
    '1.2.3 || 2.0.0',
    '1.2.3 - 2.0.0',
    '*',
  ];

  for (const selector of selectors) {
    assert.equal(
      SandboxMetadataSchema.safeParse({
        schemaVersion: 1,
        sandboxVersion: selector,
        dependencies: { codex: '1.2.3' },
      }).success,
      false,
      `sandboxVersion accepted moving selector ${selector}`,
    );
    assert.equal(
      SandboxMetadataSchema.safeParse({
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { codex: selector },
      }).success,
      false,
      `dependency accepted moving selector ${selector}`,
    );
  }
});

test('raw JSON parser rejects duplicate dependency ids before JSON.parse collapses them', () => {
  assert.throws(
    () =>
      parseSandboxMetadataText(
        '{"schemaVersion":1,"sandboxVersion":"v1.2.3","dependencies":{"codex":"1.2.3","codex":"2.0.0"}}',
      ),
    /duplicate sandbox dependency id: codex/,
  );
  assert.throws(
    () =>
      parseSandboxMetadataText(
        '{"schemaVersion":1,"sandboxVersion":"v1.2.3","dependencies":{"co\\u0064ex":"1.2.3","codex":"2.0.0"}}',
      ),
    /duplicate sandbox dependency id: codex/,
  );
});

test('raw JSON parser accepts distinct dependency ids and preserves schema validation', () => {
  const metadata = parseSandboxMetadataText(
    '{"schemaVersion":1,"sandboxVersion":"v1.2.3","dependencies":{"codex":"1.2.3","company-cli":"revision-42"}}',
  );
  assert.deepEqual(metadata.dependencies, {
    codex: '1.2.3',
    'company-cli': 'revision-42',
  });
});
