import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  IMAGE_ASSET_MANIFEST,
  SANDBOX_IMAGE_ASSET_DEFINITIONS,
  assetFileName,
  buildManifest,
  checksumFileName,
  expectedReleaseAssetNames,
  inspectPackagedAssetMetadata,
  sha256File,
  validateManifest,
  validateSandboxReleaseMetadata,
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

const hasZstd = spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
const fixtureDecompressAsset = hasZstd
  ? undefined
  : (source, target) => copyFileSync(source, target);

function runFixtureCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
}

function compressFixture(tarPath, assetPath) {
  if (hasZstd) {
    runFixtureCommand('zstd', ['-q', '-f', tarPath, '-o', assetPath]);
  } else {
    copyFileSync(tarPath, assetPath);
  }
}

function writeLayerTar(path, metadata) {
  const root = mkdtempSync(join(tmpdir(), 'cap-release-layer-'));
  try {
    if (metadata) {
      const metadataDir = join(root, 'etc', 'cap');
      mkdirSync(metadataDir, { recursive: true });
      writeFileSync(
        join(metadataDir, 'sandbox-metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      );
    } else {
      writeFileSync(join(root, 'fixture.txt'), 'metadata intentionally absent\n', 'utf8');
    }
    runFixtureCommand('tar', ['-C', root, '-cf', path, '.']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeDockerArchiveFixture(assetPath, metadata) {
  const root = mkdtempSync(join(tmpdir(), 'cap-docker-archive-'));
  const archiveRoot = join(root, 'archive');
  const tarPath = join(root, 'asset.tar');
  mkdirSync(archiveRoot, { recursive: true });
  try {
    writeLayerTar(join(archiveRoot, 'layer.tar'), metadata);
    writeFileSync(join(archiveRoot, 'config.json'), '{}\n', 'utf8');
    writeFileSync(
      join(archiveRoot, 'manifest.json'),
      `${JSON.stringify([{
        Config: 'config.json',
        RepoTags: ['fixture:test'],
        Layers: ['layer.tar'],
      }])}\n`,
      'utf8',
    );
    runFixtureCommand('tar', ['-C', archiveRoot, '-cf', tarPath, '.']);
    compressFixture(tarPath, assetPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeOciBlob(archiveRoot, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const digest = createHash('sha256').update(buffer).digest('hex');
  const path = join(archiveRoot, 'blobs', 'sha256', digest);
  mkdirSync(join(archiveRoot, 'blobs', 'sha256'), { recursive: true });
  writeFileSync(path, buffer);
  return { digest: `sha256:${digest}`, size: buffer.length };
}

function writeOciArchiveFixture(assetPath, metadata) {
  const root = mkdtempSync(join(tmpdir(), 'cap-oci-archive-'));
  const archiveRoot = join(root, 'archive');
  const layerPath = join(root, 'layer.tar');
  const tarPath = join(root, 'asset.tar');
  mkdirSync(archiveRoot, { recursive: true });
  try {
    writeLayerTar(layerPath, metadata);
    const config = writeOciBlob(archiveRoot, '{}\n');
    const layer = writeOciBlob(archiveRoot, readFileSync(layerPath));
    const manifest = writeOciBlob(archiveRoot, `${JSON.stringify({
      schemaVersion: 2,
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        ...config,
      },
      layers: [{
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        ...layer,
      }],
    })}\n`);
    writeFileSync(
      join(archiveRoot, 'index.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        manifests: [{
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          ...manifest,
        }],
      })}\n`,
      'utf8',
    );
    writeFileSync(
      join(archiveRoot, 'oci-layout'),
      `${JSON.stringify({ imageLayoutVersion: '1.0.0' })}\n`,
      'utf8',
    );
    runFixtureCommand('tar', ['-C', archiveRoot, '-cf', tarPath, '.']);
    compressFixture(tarPath, assetPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeAssetFixture(definition, path, metadata) {
  if (definition.kind === 'docker-archive') {
    writeDockerArchiveFixture(path, metadata);
  } else {
    writeOciArchiveFixture(path, metadata);
  }
}

function makeAssetSet(version = 'v1.2.3', metadataById = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'cap-release-assets-'));
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    const asset = assetFileName(definition, version);
    const path = join(outDir, asset);
    const metadata = Object.hasOwn(metadataById, definition.id)
      ? metadataById[definition.id]
      : sandboxMetadata;
    writeAssetFixture(definition, path, metadata);
    writeFileSync(join(outDir, checksumFileName(definition, version)), `${sha256File(path)}  ${asset}\n`, 'utf8');
  }
  return { outDir, decompressAsset: fixtureDecompressAsset };
}

const sandboxMetadata = {
  schemaVersion: 1,
  sandboxVersion: 'v1.2.3',
  dependencies: { codex: '0.132.0', 'claude-code': '2.1.181', openspec: '1.4.1' },
};

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
  const { outDir } = makeAssetSet();
  const manifest = buildManifest({ version: 'v1.2.3', owner: 'xeonice', outDir, generatedAt: '2026-06-30T00:00:00Z', sandboxMetadata });
  validateManifest(manifest, { version: 'v1.2.3' });
  const aio = manifest.assets.find((entry) => entry.provider === 'aio');
  const boxlite = manifest.assets.find((entry) => entry.provider === 'boxlite' && entry.platform === 'linux/arm64');
  assert.equal(aio.kind, 'docker-archive');
  assert.equal(aio.loadedTag, 'ghcr.io/xeonice/cap-aio-sandbox:v1.2.3');
  assert.equal(boxlite.kind, 'oci-layout');
  assert.equal(boxlite.rootfsPathRelative, 'boxlite/cap-boxlite-sandbox/v1.2.3/linux-arm64/oci');
  assert.match(aio.sha256, /^[0-9a-f]{64}$/);
  assert.equal(typeof aio.sizeBytes, 'number');
  assert.deepEqual(aio.sandboxMetadata, sandboxMetadata);
  assert.deepEqual(manifest.sandboxMetadata, sandboxMetadata);
});

test('local asset set verification detects checksum mismatch and missing files', () => {
  const { outDir, decompressAsset } = makeAssetSet();
  writeManifest({ version: 'v1.2.3', owner: 'xeonice', outDir, sandboxMetadata });
  verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset });

  const first = SANDBOX_IMAGE_ASSET_DEFINITIONS[0];
  writeFileSync(join(outDir, checksumFileName(first, 'v1.2.3')), `bad  ${assetFileName(first, 'v1.2.3')}\n`, 'utf8');
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset }),
    /checksum mismatch/,
  );
});

test('manifest validation rejects invalid version and duplicate entries', () => {
  assert.throws(() => expectedReleaseAssetNames('1.2.3'), /v-prefixed semver/);
  const manifest = {
    schemaVersion: 1,
    version: 'v1.2.3',
    sandboxMetadata,
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
        sandboxMetadata,
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
        sandboxMetadata,
      },
    ],
  };
  assert.throws(() => validateManifest(manifest, { version: 'v1.2.3' }), /duplicate id/);
});

test('release metadata rejects missing files, wrong CAP versions, moving versions, and provider drift', () => {
  assert.throws(() => validateSandboxReleaseMetadata(undefined, { version: 'v1.2.3' }), /schemaVersion 1/);
  assert.throws(
    () => validateSandboxReleaseMetadata({ ...sandboxMetadata, sandboxVersion: 'v1.2.4' }, { version: 'v1.2.3' }),
    /does not match/,
  );
  assert.throws(
    () => validateSandboxReleaseMetadata({ ...sandboxMetadata, dependencies: { ...sandboxMetadata.dependencies, codex: 'latest' } }, { version: 'v1.2.3' }),
    /dependency codex must be an exact version/,
  );

  assert.throws(
    () => validateSandboxReleaseMetadata({
      ...sandboxMetadata,
      dependencies: { ...sandboxMetadata.dependencies, BadKey: '1.0.0' },
    }, { version: 'v1.2.3' }),
    /invalid dependency id/,
  );
  assert.throws(
    () => validateSandboxReleaseMetadata({
      ...sandboxMetadata,
      dependencies: { ...sandboxMetadata.dependencies, 'custom-cli': 'latest' },
    }, { version: 'v1.2.3' }),
    /dependency custom-cli must be an exact version/,
  );

  for (const selector of [
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
  ]) {
    assert.throws(
      () => validateSandboxReleaseMetadata({
        ...sandboxMetadata,
        sandboxVersion: selector,
      }),
      /sandboxVersion must be an exact version/,
      `release sandboxVersion accepted ${selector}`,
    );
    assert.throws(
      () => validateSandboxReleaseMetadata({
        ...sandboxMetadata,
        dependencies: { ...sandboxMetadata.dependencies, 'custom-cli': selector },
      }, { version: 'v1.2.3' }),
      /dependency custom-cli must be an exact version/,
      `release metadata accepted ${selector}`,
    );
  }

  const exactCustom = validateSandboxReleaseMetadata({
    ...sandboxMetadata,
    sandboxVersion: 'v1.2.3-rc.1+build.4',
    dependencies: {
      ...sandboxMetadata.dependencies,
      'custom-cli': 'revision-42',
    },
  });
  assert.equal(exactCustom.sandboxVersion, 'v1.2.3-rc.1+build.4');
  assert.equal(exactCustom.dependencies['custom-cli'], 'revision-42');

  const { outDir } = makeAssetSet();
  const manifest = buildManifest({ version: 'v1.2.3', outDir, sandboxMetadata });
  manifest.assets[1].sandboxMetadata = {
    ...sandboxMetadata,
    dependencies: { ...sandboxMetadata.dependencies, codex: '0.999.0' },
  };
  assert.throws(() => validateManifest(manifest, { version: 'v1.2.3' }), /toolchain metadata drift/);
});

test('reads metadata from real Docker and OCI archive fixtures', () => {
  const { outDir, decompressAsset } = makeAssetSet();
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    const actual = inspectPackagedAssetMetadata(
      definition,
      join(outDir, assetFileName(definition, 'v1.2.3')),
      { version: 'v1.2.3', decompressAsset },
    );
    assert.deepEqual(actual, sandboxMetadata);
  }
});

test('packaged archive verification rejects missing Docker metadata and OCI drift', () => {
  const aio = SANDBOX_IMAGE_ASSET_DEFINITIONS.find((entry) => entry.kind === 'docker-archive');
  const boxlite = SANDBOX_IMAGE_ASSET_DEFINITIONS.find((entry) => entry.kind === 'oci-layout');

  const missingSet = makeAssetSet('v1.2.3', { [aio.id]: null });
  writeManifest({
    version: 'v1.2.3',
    owner: 'xeonice',
    outDir: missingSet.outDir,
    sandboxMetadata,
  });
  assert.throws(
    () => verifyLocalAssetSet({
      version: 'v1.2.3',
      outDir: missingSet.outDir,
      decompressAsset: missingSet.decompressAsset,
    }),
    /missing \/etc\/cap\/sandbox-metadata\.json/,
  );

  const driftedMetadata = {
    ...sandboxMetadata,
    dependencies: { ...sandboxMetadata.dependencies, codex: '0.999.0' },
  };
  const driftSet = makeAssetSet('v1.2.3', { [boxlite.id]: driftedMetadata });
  writeManifest({
    version: 'v1.2.3',
    owner: 'xeonice',
    outDir: driftSet.outDir,
    sandboxMetadata,
  });
  assert.throws(
    () => verifyLocalAssetSet({
      version: 'v1.2.3',
      outDir: driftSet.outDir,
      decompressAsset: driftSet.decompressAsset,
    }),
    /packaged asset .* metadata drift/,
  );
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
}
console.error('SOME TESTS FAILED');
process.exit(1);
