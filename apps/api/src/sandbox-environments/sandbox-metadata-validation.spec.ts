import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimeDeclared,
  metadataFromProbes,
  runtimeArtifactChecksumFromProbes,
  runtimeArtifactChecksumsFromProbes,
} from './sandbox-environments.validator';

test('metadata probe accepts arbitrary declared custom dependency keys', () => {
  const metadata = metadataFromProbes([
    {
      name: 'sandbox-metadata',
      ok: true,
      output: JSON.stringify({
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { codex: '0.132.0', 'company-cli': '4.5.6' },
      }),
    },
  ]);
  assert.equal(metadata.dependencies['company-cli'], '4.5.6');
  assert.doesNotThrow(() => assertRuntimeDeclared('codex', metadata));
});

test('runtime artifact checksum accepts only a successful SHA-256 probe', () => {
  const digest = 'a'.repeat(64);
  assert.equal(
    runtimeArtifactChecksumFromProbes('claude-code', [
      {
        name: 'runtime-artifact-checksum',
        ok: true,
        output: digest,
      },
    ]),
    `sha256:${digest}`,
  );
  assert.throws(
    () => runtimeArtifactChecksumFromProbes('codex', []),
    /checksum is unavailable/,
  );
  assert.throws(
    () =>
      runtimeArtifactChecksumFromProbes('codex', [
        { name: 'runtime-artifact-checksum', ok: true, output: 'not-a-digest' },
      ]),
    /checksum is unavailable/,
  );
  assert.throws(
    () =>
      runtimeArtifactChecksumFromProbes('codex', [
        {
          name: 'runtime-artifact-checksum',
          ok: true,
          output: `${digest} /private/path`,
        },
      ]),
    /checksum is unavailable/,
  );
  assert.equal(runtimeArtifactChecksumFromProbes('custom-runtime', []), null);
});

test('multi-runtime checksum probes remain attributed to the correct CLI', () => {
  const codex = 'a'.repeat(64);
  const claude = 'b'.repeat(64);
  assert.deepEqual(
    runtimeArtifactChecksumsFromProbes(['codex', 'claude-code'], [
      {
        name: 'runtime-artifact-checksum:codex',
        ok: true,
        output: codex,
      },
      {
        name: 'runtime-artifact-checksum:claude-code',
        ok: true,
        output: claude,
      },
    ]),
    {
      codex: `sha256:${codex}`,
      'claude-code': `sha256:${claude}`,
    },
  );
});

test('metadata probe fails missing, malformed, moving, and selected-runtime omissions', () => {
  assert.throws(() => metadataFromProbes([]), /missing or unreadable/);
  assert.throws(
    () => metadataFromProbes([{ name: 'sandbox-metadata', ok: true, output: '{bad' }]),
    /invalid sandbox metadata JSON/,
  );
  assert.throws(
    () =>
      metadataFromProbes([
        {
          name: 'sandbox-metadata',
          ok: true,
          output: JSON.stringify({
            schemaVersion: 1,
            sandboxVersion: 'v1.2.3',
            dependencies: { codex: 'latest' },
          }),
        },
      ]),
    /exact version/,
  );
  assert.throws(
    () =>
      assertRuntimeDeclared('claude-code', {
        schemaVersion: 1,
        sandboxVersion: 'v1.2.3',
        dependencies: { codex: '0.132.0' },
      }),
    /claude-code is not declared/,
  );
});
