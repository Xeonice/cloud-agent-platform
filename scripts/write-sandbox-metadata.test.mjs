import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSandboxMetadata } from './write-sandbox-metadata.mjs';

test('build helper sorts and preserves only declared dependencies', () => {
  assert.deepEqual(
    buildSandboxMetadata({
      sandboxVersion: 'v1.2.3',
      dependencies: ['z-tool=9.0.0', 'codex=0.132.0'],
    }),
    {
      schemaVersion: 1,
      sandboxVersion: 'v1.2.3',
      dependencies: { codex: '0.132.0', 'z-tool': '9.0.0' },
    },
  );
});

test('build helper rejects duplicate, malformed, and moving values', () => {
  assert.throws(
    () => buildSandboxMetadata({
      sandboxVersion: 'v1.0.0',
      dependencies: ['codex=1.0.0', 'codex=2.0.0'],
    }),
    /duplicate/,
  );
  assert.throws(
    () => buildSandboxMetadata({ sandboxVersion: 'latest', dependencies: ['codex=1'] }),
    /exact/,
  );
  assert.throws(
    () => buildSandboxMetadata({ sandboxVersion: 'v1.0.0', dependencies: ['Codex=1.0.0'] }),
    /invalid dependency id/,
  );
});

test('build helper rejects moving selectors for sandbox and dependency versions', () => {
  const selectors = [
    'latest',
    'next',
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
    assert.throws(
      () => buildSandboxMetadata({
        sandboxVersion: selector,
        dependencies: ['codex=1.2.3'],
      }),
      /exact version/,
      `sandboxVersion accepted ${selector}`,
    );
    assert.throws(
      () => buildSandboxMetadata({
        sandboxVersion: 'v1.2.3',
        dependencies: [`codex=${selector}`],
      }),
      /exact version/,
      `dependency accepted ${selector}`,
    );
  }
});

test('build helper accepts exact semver and explicit custom revisions', () => {
  const metadata = buildSandboxMetadata({
    sandboxVersion: 'v1.2.3-rc.1+build.4',
    dependencies: ['codex=1.2.3', 'company-cli=revision-42'],
  });
  assert.equal(metadata.sandboxVersion, 'v1.2.3-rc.1+build.4');
  assert.equal(metadata.dependencies['company-cli'], 'revision-42');
});

test('build helper validates inherited dependency versions with the same policy', () => {
  assert.throws(
    () => buildSandboxMetadata({
      inherited: {
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { codex: 'next' },
      },
      dependencies: ['company-cli=revision-42'],
    }),
    /dependency codex must be an exact version/,
  );
});

test('build helper inherits official metadata and adds only declared custom dependencies', () => {
  assert.deepEqual(
    buildSandboxMetadata({
      inherited: {
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { codex: '0.132.0' },
      },
      dependencies: ['company-cli=4.5.6'],
    }),
    {
      schemaVersion: 1,
      sandboxVersion: 'v1.2.3',
      dependencies: { codex: '0.132.0', 'company-cli': '4.5.6' },
    },
  );
});
