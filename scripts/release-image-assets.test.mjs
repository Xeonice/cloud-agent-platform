import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  IMAGE_ASSET_MANIFEST,
  MAX_RELEASE_ASSET_PART_BYTES,
  SANDBOX_IMAGE_ASSET_DEFINITIONS,
  assetFileName,
  assetPartFileName,
  buildManifest,
  checksumFileName,
  expectedReleaseAssetNames,
  finalizeReleaseAsset,
  inspectPackagedAssetMetadata,
  sha256File,
  sha256Files,
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
  : (source, target) => {
    const sources = Array.isArray(source) ? source : [source];
    if (sources.length === 1) {
      copyFileSync(sources[0], target);
      return;
    }
    writeFileSync(target, Buffer.concat(sources.map((path) => readFileSync(path))));
  };

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
  assert.equal(MAX_RELEASE_ASSET_PART_BYTES, 1900 * 1024 * 1024);
  assert.ok(MAX_RELEASE_ASSET_PART_BYTES < 2 * 1024 * 1024 * 1024);
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

test('accepts metadata-free schemaVersion 1 manifests only for legacy single-file assets', () => {
  const version = 'v0.36.1';
  const owner = 'xeonice';
  const assets = SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => {
    const asset = assetFileName(definition, version);
    const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
    return {
      id: definition.id,
      provider: definition.provider,
      package: definition.packageName,
      image,
      platform: definition.platform,
      kind: definition.kind,
      asset,
      checksumAsset: `${asset}.sha256`,
      ...(definition.kind === 'docker-archive' ? { loadedTag: image } : {
        rootfsPathRelative:
          `boxlite/${definition.packageName}/${version}/${definition.platformSlug}/oci`,
      }),
      sha256: '0'.repeat(64),
      sizeBytes: 1,
    };
  });
  const legacy = { schemaVersion: 1, version, owner, assets };

  assert.doesNotThrow(() => validateManifest(legacy, { version }));
  assert.deepEqual(expectedReleaseAssetNames(version, legacy), [
    IMAGE_ASSET_MANIFEST,
    ...assets.flatMap((entry) => [entry.asset, entry.checksumAsset]),
  ]);

  const invalidParts = structuredClone(legacy);
  invalidParts.assets[0].parts = [
    {
      asset: `${invalidParts.assets[0].asset}.part-0001`,
      checksumAsset: `${invalidParts.assets[0].asset}.part-0001.sha256`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
    },
    {
      asset: `${invalidParts.assets[0].asset}.part-0002`,
      checksumAsset: `${invalidParts.assets[0].asset}.part-0002.sha256`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
    },
  ];
  invalidParts.assets[0].sizeBytes = 2;
  assert.throws(
    () => validateManifest(invalidParts, { version }),
    /parts require asset manifest schemaVersion 2/,
  );
});

test('finalizes a small Release asset as one streamed-checksum file', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'cap-release-single-'));
  const asset = 'fixture.tar.zst';
  const assetPath = join(outDir, asset);
  writeFileSync(assetPath, 'small release asset\n', 'utf8');

  const result = finalizeReleaseAsset(assetPath, { maxPartBytes: 1024 });

  assert.equal(result.asset, asset);
  assert.equal(result.parts, undefined);
  assert.equal(result.sizeBytes, statSync(assetPath).size);
  assert.equal(result.sha256, sha256File(assetPath));
  assert.equal(
    readFileSync(`${assetPath}.sha256`, 'utf8'),
    `${result.sha256}  ${asset}\n`,
  );
  assert.throws(
    () => finalizeReleaseAsset(assetPath, { maxPartBytes: 2 * 1024 * 1024 * 1024 }),
    /at most 1992294400 bytes/,
  );
});

test('streams SHA-256 for a sparse file beyond the Node Buffer limit', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'cap-release-large-hash-'));
  const assetPath = join(outDir, 'larger-than-two-gib.bin');
  const sizeBytes = (2 * 1024 * 1024 * 1024) + 1;
  try {
    writeFileSync(assetPath, '');
    truncateSync(assetPath, sizeBytes);
    assert.equal(statSync(assetPath).size, sizeBytes);
    assert.match(sha256File(assetPath), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('splits an oversized asset, lists every part, and verifies metadata without reassembly', () => {
  const { outDir, decompressAsset } = makeAssetSet();
  const definition = SANDBOX_IMAGE_ASSET_DEFINITIONS[0];
  const asset = assetFileName(definition, 'v1.2.3');
  const assetPath = join(outDir, asset);
  const originalSize = statSync(assetPath).size;
  const maxPartBytes = Math.ceil(originalSize / 3);
  const split = finalizeReleaseAsset(assetPath, { maxPartBytes });

  assert.equal(existsSync(assetPath), false, 'the over-limit logical file is removed');
  assert.ok(split.parts.length >= 2);
  assert.equal(split.parts.reduce((total, part) => total + part.sizeBytes, 0), originalSize);
  assert.ok(split.parts.every((part) => part.sizeBytes <= maxPartBytes));
  assert.equal(split.sha256, sha256Files(split.parts.map((part) => join(outDir, part.asset))));
  for (let index = 0; index < split.parts.length; index += 1) {
    const part = split.parts[index];
    assert.equal(part.asset, assetPartFileName(asset, index + 1));
    assert.equal(part.checksumAsset, `${part.asset}.sha256`);
    assert.equal(part.sha256, sha256File(join(outDir, part.asset)));
    assert.ok(existsSync(join(outDir, part.checksumAsset)));
  }

  const manifest = writeManifest({
    version: 'v1.2.3',
    owner: 'xeonice',
    outDir,
    sandboxMetadata,
  });
  const entry = manifest.assets.find((candidate) => candidate.id === definition.id);
  assert.deepEqual(entry.parts, split.parts);
  assert.equal(entry.sha256, split.sha256);
  assert.equal(entry.sizeBytes, originalSize);
  const releaseNames = expectedReleaseAssetNames('v1.2.3', manifest);
  assert.equal(releaseNames.includes(asset), false, 'a split entry does not publish the logical file');
  assert.ok(releaseNames.includes(`${asset}.sha256`), 'the logical whole-file checksum remains published');
  for (const part of split.parts) {
    assert.ok(releaseNames.includes(part.asset));
    assert.ok(releaseNames.includes(part.checksumAsset));
  }
  const listed = spawnSync(process.execPath, [
    fileURLToPath(new URL('./release-image-assets.mjs', import.meta.url)),
    'list',
    '--version',
    'v1.2.3',
    '--manifest',
    join(outDir, IMAGE_ASSET_MANIFEST),
  ], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), releaseNames);
  const reordered = structuredClone(manifest);
  [reordered.assets[0].parts[0], reordered.assets[0].parts[1]] = [
    reordered.assets[0].parts[1],
    reordered.assets[0].parts[0],
  ];
  assert.throws(
    () => validateManifest(reordered, { version: 'v1.2.3' }),
    /part 1 must be .*part-0001/,
  );
  const oversizedPart = structuredClone(manifest);
  oversizedPart.assets[0].parts[0].sizeBytes = 2 * 1024 * 1024 * 1024;
  assert.throws(
    () => validateManifest(oversizedPart, { version: 'v1.2.3' }),
    /part 1 must be smaller than 2 GiB/,
  );
  const tooManyParts = structuredClone(manifest);
  tooManyParts.assets[0].parts = Array.from({ length: 500 }, (_, index) => {
    const partAsset = assetPartFileName(asset, index + 1);
    return {
      asset: partAsset,
      checksumAsset: `${partAsset}.sha256`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
    };
  });
  tooManyParts.assets[0].sizeBytes = 500;
  assert.throws(
    () => validateManifest(tooManyParts, { version: 'v1.2.3' }),
    /exceeding GitHub's 1000-asset limit/,
  );
  const traversal = structuredClone(manifest);
  traversal.assets[0].parts[0].asset = `../${traversal.assets[0].parts[0].asset}`;
  assert.throws(
    () => validateManifest(traversal, { version: 'v1.2.3' }),
    /must be a non-empty file name/,
  );
  verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset });

  const firstPartPath = join(outDir, split.parts[0].asset);
  const firstPartBytes = readFileSync(firstPartPath);
  rmSync(firstPartPath);
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset }),
    /missing asset part .*part-0001/,
  );
  writeFileSync(firstPartPath, firstPartBytes);

  const firstPartChecksumPath = join(outDir, split.parts[0].checksumAsset);
  const firstPartChecksum = readFileSync(firstPartChecksumPath, 'utf8');
  rmSync(firstPartChecksumPath);
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset }),
    /missing checksum .*part-0001\.sha256/,
  );
  writeFileSync(firstPartChecksumPath, firstPartChecksum, 'utf8');

  const wholeChecksumPath = join(outDir, `${asset}.sha256`);
  const wholeChecksum = readFileSync(wholeChecksumPath, 'utf8');
  writeFileSync(wholeChecksumPath, `${'0'.repeat(64)}  ${asset}\n`, 'utf8');
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset }),
    new RegExp(`checksum mismatch for ${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  writeFileSync(wholeChecksumPath, wholeChecksum, 'utf8');

  const tampered = Buffer.from(firstPartBytes);
  tampered[0] ^= 0xff;
  writeFileSync(firstPartPath, tampered);
  assert.throws(
    () => verifyLocalAssetSet({ version: 'v1.2.3', outDir, decompressAsset }),
    /checksum mismatch for .*part-0001/,
  );
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

  const legacyLargeSingleFile = structuredClone(manifest);
  legacyLargeSingleFile.assets[0].sizeBytes = MAX_RELEASE_ASSET_PART_BYTES + 1;
  assert.doesNotThrow(
    () => validateManifest(legacyLargeSingleFile, { version: 'v1.2.3' }),
    'the additive parts contract continues to accept schema v1 single-file entries',
  );
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
  const { outDir } = makeAssetSet();
  const manifest = buildManifest({ version: 'v1.2.3', owner: 'xeonice', outDir, sandboxMetadata });
  const duplicate = structuredClone(manifest);
  duplicate.assets[1] = structuredClone(duplicate.assets[0]);
  assert.throws(() => validateManifest(duplicate, { version: 'v1.2.3' }), /duplicate id/);

  const wrongMapping = structuredClone(manifest);
  wrongMapping.assets[0].provider = 'fake';
  assert.throws(
    () => validateManifest(wrongMapping, { version: 'v1.2.3' }),
    /provider must be aio/,
  );

  const extra = structuredClone(manifest);
  extra.assets.push(structuredClone(extra.assets[0]));
  assert.throws(
    () => validateManifest(extra, { version: 'v1.2.3' }),
    /must contain exactly 3 official entries/,
  );
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
