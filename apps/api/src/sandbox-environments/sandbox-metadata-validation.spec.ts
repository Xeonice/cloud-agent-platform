import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimeDeclared,
  metadataFromProbes,
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
