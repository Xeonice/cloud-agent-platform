import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IMAGE_ASSET_MANIFEST,
  SANDBOX_IMAGE_ASSET_DEFINITIONS,
  assetFileName,
  buildManifest,
  checksumFileName,
  expectedReleaseAssetNames,
  sha256File,
  validateManifest,
  verifyLocalAssetSet,
  writeManifest,
} from './release-image-assets.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function makeAssetSet(version = 'v1.2.3') {
  const outDir = mkdtempSync(join(tmpdir(), 'cap-release-assets-'));
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    const asset = assetFileName(definition, version);
    const path = join(outDir, asset);
    writeFileSync(path, `asset ${definition.id}\n`, 'utf8');
    writeFileSync(join(outDir, checksumFileName(definition, version)), `${sha256File(path)}  ${asset}\n`, 'utf8');
  }
  return outDir;
}

test('expected release asset names are deterministic', () => {
  assert.deepEqual(expectedReleaseAssetNames('v1.2.3'), [
    IMAGE_ASSET_MANIFEST,
    'cap-aio-sandbox-v1.2.3-linux-amd64.docker.tar.zst',
    'cap-aio-sandbox-v1.2.3-linux-amd64.docker.tar.zst.sha256',
    'cap-boxlite-sandbox-v1.2.3-linux-arm64.oci.tar.zst',
    'cap-boxlite-sandbox-v1.2.3-linux-arm64.oci.tar.zst.sha256',
    'cap-boxlite-sandbox-v1.2.3-linux-amd64.oci.tar.zst',
    'cap-boxlite-sandbox-v1.2.3-linux-amd64.oci.tar.zst.sha256',
  ]);
});

test('manifest includes provider staging contracts', () => {
  const outDir = makeAssetSet();
  const manifest = buildManifest({ version: 'v1.2.3', owner: 'xeonice', outDir, generatedAt: '2026-06-30T00:00:00Z' });
  validateManifest(manifest, { version: 'v1.2.3' });
  const aio = manifest.assets.find((entry) => entry.provider === 'aio');
  const boxlite = manifest.assets.find((entry) => entry.provider === 'boxlite' && entry.platform === 'linux/arm64');
  assert.equal(aio.kind, 'docker-archive');
  assert.equal(aio.loadedTag, 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3');
  assert.equal(boxlite.kind, 'oci-layout');
  assert.equal(boxlite.rootfsPathRelative, 'boxlite/cap-boxlite-sandbox/v1.2.3/linux-arm64/oci');
  assert.match(aio.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof aio.sizeBytes, 'number');
});

test('local asset set verification detects checksum mismatch and missing files', () => {
  const outDir = makeAssetSet();
  writeManifest({ version: 'v1.2.3', owner: 'xeonice', outDir });
  verifyLocalAssetSet({ version: 'v1.2.3', outDir });

  const first = SANDBOX_IMAGE_ASSET_DEFINITIONS[0];
  writeFileSync(join(outDir, checksumFileName(first, 'v1.2.3')), `bad  ${assetFileName(first, 'v1.2.3')}\n`, 'utf8');
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir }),
    /checksum mismatch/,
  );
});

test('manifest validation rejects invalid version and duplicate entries', () => {
  assert.throws(() => expectedReleaseAssetNames('1.2.3'), /v-prefixed semver/);
  const manifest = {
    schemaVersion: 1,
    version: 'v1.2.3',
    assets: [
      {
        id: 'aio-sandbox-linux-amd64',
        provider: 'aio',
        package: 'cap-aio-sandbox',
        image: 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3',
        platform: 'linux/amd64',
        kind: 'docker-archive',
        asset: 'a',
        checksumAsset: 'a.sha256',
        loadedTag: 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3',
      },
      {
        id: 'aio-sandbox-linux-amd64',
        provider: 'aio',
        package: 'cap-aio-sandbox',
        image: 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3',
        platform: 'linux/amd64',
        kind: 'docker-archive',
        asset: 'b',
        checksumAsset: 'b.sha256',
        loadedTag: 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3',
      },
    ],
  };
  assert.throws(() => validateManifest(manifest, { version: 'v1.2.3' }), /duplicate id/);
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
