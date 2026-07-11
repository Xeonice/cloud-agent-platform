#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeExactSandboxVersionValue } from './sandbox-version-selector.mjs';

export const IMAGE_ASSET_MANIFEST = 'cap-image-assets.json';
export const MAX_RELEASE_ASSET_PART_BYTES = 1900 * 1024 * 1024;

const SANDBOX_METADATA_RELATIVE_PATH = 'etc/cap/sandbox-metadata.json';
const SANDBOX_DEPENDENCY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REQUIRED_OFFICIAL_DEPENDENCIES = ['codex', 'claude-code', 'openspec'];
const FILE_IO_BUFFER_BYTES = 8 * 1024 * 1024;
const RELEASE_ASSET_PART_DIGITS = 4;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GITHUB_RELEASE_ASSET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const GITHUB_RELEASE_MAX_ASSETS = 1000;

export const SANDBOX_IMAGE_ASSET_DEFINITIONS = [
  {
    id: 'aio-sandbox-linux-amd64',
    provider: 'aio',
    packageName: 'cap-aio-sandbox',
    platform: 'linux/amd64',
    platformSlug: 'linux-amd64',
    kind: 'docker-archive',
    suffix: '.docker.tar.zst',
  },
  {
    id: 'boxlite-sandbox-linux-arm64',
    provider: 'boxlite',
    packageName: 'cap-boxlite-sandbox',
    platform: 'linux/arm64',
    platformSlug: 'linux-arm64',
    kind: 'oci-layout',
    suffix: '.oci.tar.zst',
  },
  {
    id: 'boxlite-sandbox-linux-amd64',
    provider: 'boxlite',
    packageName: 'cap-boxlite-sandbox',
    platform: 'linux/amd64',
    platformSlug: 'linux-amd64',
    kind: 'oci-layout',
    suffix: '.oci.tar.zst',
  },
];

export function normalizeVersion(version) {
  const value = String(version ?? '').trim();
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`version must be a v-prefixed semver tag, received: ${JSON.stringify(version)}`);
  }
  return value;
}

export function assetFileName(definition, version) {
  const tag = normalizeVersion(version);
  return `${definition.packageName}-${tag}-${definition.platformSlug}${definition.suffix}`;
}

export function checksumFileName(definition, version) {
  return `${assetFileName(definition, version)}.sha256`;
}

export function expectedReleaseAssetNames(version, manifest) {
  const tag = normalizeVersion(version);
  if (manifest !== undefined) {
    validateManifest(manifest, { version: tag });
    const names = [IMAGE_ASSET_MANIFEST];
    for (const entry of manifest.assets) {
      if (entry.parts) {
        for (const part of entry.parts) names.push(part.asset, part.checksumAsset);
      } else {
        names.push(entry.asset);
      }
      names.push(entry.checksumAsset);
    }
    return names;
  }
  const names = [IMAGE_ASSET_MANIFEST];
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    names.push(assetFileName(definition, tag), checksumFileName(definition, tag));
  }
  return names;
}

function updateHashFromFile(hash, path, buffer) {
  const input = openSync(path, 'r');
  try {
    while (true) {
      const bytesRead = readSync(input, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(input);
  }
}

export function sha256Files(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('at least one file is required for SHA-256');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(FILE_IO_BUFFER_BYTES);
  for (const path of paths) updateHashFromFile(hash, path, buffer);
  return hash.digest('hex');
}

export function sha256File(path) {
  return sha256Files([path]);
}

export function assetPartFileName(asset, index) {
  if (!Number.isSafeInteger(index) || index < 1 || index >= 10 ** RELEASE_ASSET_PART_DIGITS) {
    throw new Error(`release asset part index is out of range: ${index}`);
  }
  return `${asset}.part-${String(index).padStart(RELEASE_ASSET_PART_DIGITS, '0')}`;
}

export function validateSandboxReleaseMetadata(metadata, { version } = {}) {
  if (!metadata || typeof metadata !== 'object' || metadata.schemaVersion !== 1) {
    throw new Error('sandbox metadata must use schemaVersion 1');
  }
  const sandboxVersion = validateExactMetadataValue(metadata.sandboxVersion, 'sandboxVersion');
  if (version !== undefined && sandboxVersion !== normalizeVersion(version)) {
    throw new Error(`sandbox metadata version ${sandboxVersion} does not match ${normalizeVersion(version)}`);
  }
  if (!metadata.dependencies || typeof metadata.dependencies !== 'object' || Array.isArray(metadata.dependencies)) {
    throw new Error('sandbox metadata dependencies must be an object');
  }
  const dependencyEntries = Object.entries(metadata.dependencies);
  if (dependencyEntries.length === 0) {
    throw new Error('sandbox metadata dependencies must not be empty');
  }
  const dependencies = {};
  for (const [id, value] of dependencyEntries.sort(([left], [right]) => left.localeCompare(right))) {
    if (id.length > 64 || !SANDBOX_DEPENDENCY_ID_PATTERN.test(id)) {
      throw new Error(`sandbox metadata invalid dependency id: ${id}`);
    }
    dependencies[id] = validateExactMetadataValue(value, `dependency ${id}`);
  }
  for (const id of REQUIRED_OFFICIAL_DEPENDENCIES) {
    if (!(id in dependencies)) throw new Error(`sandbox metadata missing exact ${id} version`);
  }
  return { schemaVersion: 1, sandboxVersion, dependencies };
}

function validateExactMetadataValue(value, label) {
  return normalizeExactSandboxVersionValue(value, `sandbox metadata ${label}`);
}

function assertSandboxMetadataEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: sandbox toolchain metadata drift`);
  }
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checksumDigest(checksumPath, label) {
  if (!existsSync(checksumPath)) throw new Error(`missing checksum ${label}`);
  const digest = readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0];
  if (!SHA256_PATTERN.test(digest ?? '')) {
    throw new Error(`checksum mismatch for ${label}: checksum file does not contain a SHA-256 digest`);
  }
  return digest;
}

function discoverReleaseAssetParts(assetPath) {
  const directory = dirname(assetPath);
  if (!existsSync(directory)) return [];
  const asset = basename(assetPath);
  const pattern = new RegExp(`^${escapedRegExp(asset)}\\.part-(\\d{${RELEASE_ASSET_PART_DIGITS}})$`);
  const names = readdirSync(directory)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter(({ match }) => match)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  for (let index = 0; index < names.length; index += 1) {
    const expected = assetPartFileName(asset, index + 1);
    if (names[index].name !== expected) {
      throw new Error(`release asset ${asset} has a non-contiguous part sequence at ${names[index].name}`);
    }
  }
  return names.map(({ name }) => join(directory, name));
}

function removeReleaseAssetParts(assetPath) {
  const directory = dirname(assetPath);
  if (!existsSync(directory)) return;
  const asset = basename(assetPath);
  const pattern = new RegExp(
    `^${escapedRegExp(asset)}\\.part-\\d{${RELEASE_ASSET_PART_DIGITS}}(?:\\.sha256(?:\\.captmp)?)?$`,
  );
  for (const name of readdirSync(directory)) {
    if (pattern.test(name)) rmSync(join(directory, name), { force: true });
  }
}

function writeChecksumFile(checksumPath, digest, asset) {
  const tempPath = `${checksumPath}.captmp`;
  writeFileSync(tempPath, `${digest}  ${asset}\n`, 'utf8');
  renameSync(tempPath, checksumPath);
}

function writeBuffer(output, buffer, bytes) {
  let offset = 0;
  while (offset < bytes) {
    const written = writeSync(output, buffer, offset, bytes - offset);
    if (written === 0) throw new Error('could not make progress while writing a Release asset part');
    offset += written;
  }
}

export function finalizeReleaseAsset(
  assetPath,
  { maxPartBytes = MAX_RELEASE_ASSET_PART_BYTES } = {},
) {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes <= 0 || maxPartBytes > MAX_RELEASE_ASSET_PART_BYTES) {
    throw new Error(
      `release asset max part size must be a positive integer at most ${MAX_RELEASE_ASSET_PART_BYTES} bytes, received ${maxPartBytes}`,
    );
  }
  const asset = basename(assetPath);
  const info = statSync(assetPath);
  if (!info.isFile()) throw new Error(`release asset is not a regular file: ${assetPath}`);
  const checksumPath = `${assetPath}.sha256`;
  rmSync(checksumPath, { force: true });
  rmSync(`${checksumPath}.captmp`, { force: true });
  removeReleaseAssetParts(assetPath);

  if (info.size <= maxPartBytes) {
    const digest = sha256File(assetPath);
    writeChecksumFile(checksumPath, digest, asset);
    return { asset, checksumAsset: `${asset}.sha256`, sha256: digest, sizeBytes: info.size };
  }

  const partCount = Math.ceil(info.size / maxPartBytes);
  if (partCount >= 10 ** RELEASE_ASSET_PART_DIGITS) {
    throw new Error(`release asset ${asset} requires too many parts: ${partCount}`);
  }

  const overallHash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(FILE_IO_BUFFER_BYTES, maxPartBytes));
  const input = openSync(assetPath, 'r');
  const parts = [];
  let totalBytes = 0;
  const cleanupParts = () => {
    removeReleaseAssetParts(assetPath);
    rmSync(checksumPath, { force: true });
    rmSync(`${checksumPath}.captmp`, { force: true });
  };
  try {
    for (let index = 1; index <= partCount; index += 1) {
      const partAsset = assetPartFileName(asset, index);
      const partPath = join(dirname(assetPath), partAsset);
      const partHash = createHash('sha256');
      const output = openSync(partPath, 'wx');
      let partBytes = 0;
      try {
        while (partBytes < maxPartBytes && totalBytes < info.size) {
          const requested = Math.min(buffer.length, maxPartBytes - partBytes, info.size - totalBytes);
          const bytesRead = readSync(input, buffer, 0, requested, null);
          if (bytesRead === 0) throw new Error(`unexpected EOF while splitting release asset ${asset}`);
          const chunk = buffer.subarray(0, bytesRead);
          overallHash.update(chunk);
          partHash.update(chunk);
          writeBuffer(output, buffer, bytesRead);
          partBytes += bytesRead;
          totalBytes += bytesRead;
        }
      } finally {
        closeSync(output);
      }
      const digest = partHash.digest('hex');
      writeChecksumFile(`${partPath}.sha256`, digest, partAsset);
      parts.push({
        asset: partAsset,
        checksumAsset: `${partAsset}.sha256`,
        sha256: digest,
        sizeBytes: partBytes,
      });
    }
  } catch (error) {
    cleanupParts();
    throw error;
  } finally {
    closeSync(input);
  }

  try {
    if (totalBytes !== info.size) {
      throw new Error(`release asset ${asset} split size mismatch: expected ${info.size}, got ${totalBytes}`);
    }
    const digest = overallHash.digest('hex');
    writeChecksumFile(checksumPath, digest, asset);
    rmSync(assetPath);
    return { asset, checksumAsset: `${asset}.sha256`, sha256: digest, sizeBytes: info.size, parts };
  } catch (error) {
    cleanupParts();
    throw error;
  }
}

export function buildManifest({ version, owner = 'xeonice', outDir = '.', generatedAt = new Date().toISOString(), sandboxMetadata }) {
  const tag = normalizeVersion(version);
  const metadata = sandboxMetadata
    ? validateSandboxReleaseMetadata(sandboxMetadata, { version: tag })
    : undefined;
  const resolvedOutDir = resolve(outDir);
  const assets = SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => {
    const asset = assetFileName(definition, tag);
    const assetPath = join(resolvedOutDir, asset);
    const checksumAsset = `${asset}.sha256`;
    const entry = {
      id: definition.id,
      provider: definition.provider,
      package: definition.packageName,
      image: `ghcr.io/${owner}/${definition.packageName}:${tag}`,
      platform: definition.platform,
      kind: definition.kind,
      asset,
      checksumAsset,
      ...(metadata ? { sandboxMetadata: metadata } : {}),
    };
    if (definition.kind === 'docker-archive') {
      entry.loadedTag = entry.image;
    }
    if (definition.kind === 'oci-layout') {
      entry.rootfsPathRelative =
        `boxlite/${definition.packageName}/${tag}/${definition.platformSlug}/oci`;
    }
    const partPaths = discoverReleaseAssetParts(assetPath);
    if (existsSync(assetPath) && partPaths.length > 0) {
      throw new Error(`release asset ${asset} cannot include both a logical file and parts`);
    }
    if (partPaths.length > 0) {
      const parts = partPaths.map((partPath) => {
        const partAsset = basename(partPath);
        const digest = sha256File(partPath);
        const expected = checksumDigest(`${partPath}.sha256`, partAsset);
        if (digest !== expected) {
          throw new Error(`checksum mismatch for ${partAsset}: expected ${expected}, got ${digest}`);
        }
        return {
          asset: partAsset,
          checksumAsset: `${partAsset}.sha256`,
          sha256: digest,
          sizeBytes: statSync(partPath).size,
        };
      });
      const digest = sha256Files(partPaths);
      const expected = checksumDigest(join(resolvedOutDir, checksumAsset), asset);
      if (digest !== expected) {
        throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${digest}`);
      }
      entry.sha256 = digest;
      entry.sizeBytes = parts.reduce((total, part) => total + part.sizeBytes, 0);
      entry.parts = parts;
    } else if (existsSync(assetPath)) {
      entry.sha256 = sha256File(assetPath);
      entry.sizeBytes = statSync(assetPath).size;
    }
    return entry;
  });
  return {
    schemaVersion: 2,
    version: tag,
    owner,
    generatedAt,
    ...(metadata ? { sandboxMetadata: metadata } : {}),
    assets,
  };
}

function validateManifestAssetName(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || basename(value) !== value) {
    throw new Error(`${label} must be a non-empty file name`);
  }
}

function validateManifestDigest(value, label) {
  if (!SHA256_PATTERN.test(value ?? '')) throw new Error(`${label} must be a SHA-256 digest`);
}

function validateManifestSize(value, label, { allowZero = true } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
}

export function validateManifest(manifest, { version } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('asset manifest must be a JSON object');
  }
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(`asset manifest schemaVersion must be 1 or 2, received ${manifest.schemaVersion}`);
  }
  if (version !== undefined && manifest.version !== normalizeVersion(version)) {
    throw new Error(`asset manifest version ${manifest.version} does not match ${normalizeVersion(version)}`);
  }
  if (!Array.isArray(manifest.assets)) {
    throw new Error('asset manifest assets must be an array');
  }
  if (typeof manifest.owner !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(manifest.owner)) {
    throw new Error('asset manifest owner must be a lowercase GitHub namespace');
  }
  if (manifest.assets.length !== SANDBOX_IMAGE_ASSET_DEFINITIONS.length) {
    throw new Error(
      `asset manifest must contain exactly ${SANDBOX_IMAGE_ASSET_DEFINITIONS.length} official entries`,
    );
  }
  const manifestMetadata = manifest.sandboxMetadata === undefined && manifest.schemaVersion === 1
    ? undefined
    : validateSandboxReleaseMetadata(manifest.sandboxMetadata, { version: manifest.version });
  const definitionsById = new Map(
    SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => [definition.id, definition]),
  );
  const ids = new Set();
  const logicalAssets = new Set();
  const uploadedAssets = new Set([IMAGE_ASSET_MANIFEST]);
  for (const entry of manifest.assets) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('asset manifest entry must be an object');
    }
    for (const key of ['id', 'provider', 'package', 'image', 'platform', 'kind', 'asset', 'checksumAsset']) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        throw new Error(`asset manifest entry missing ${key}`);
      }
    }
    if (ids.has(entry.id)) {
      throw new Error(`asset manifest duplicate id: ${entry.id}`);
    }
    ids.add(entry.id);
    const definition = definitionsById.get(entry.id);
    if (!definition) throw new Error(`asset manifest unexpected entry: ${entry.id}`);
    const expectedAsset = assetFileName(definition, manifest.version);
    const expectedImage = `ghcr.io/${manifest.owner}/${definition.packageName}:${manifest.version}`;
    const expectedFields = {
      provider: definition.provider,
      package: definition.packageName,
      platform: definition.platform,
      kind: definition.kind,
      asset: expectedAsset,
      checksumAsset: `${expectedAsset}.sha256`,
      image: expectedImage,
    };
    for (const [key, expected] of Object.entries(expectedFields)) {
      if (entry[key] !== expected) {
        throw new Error(`asset ${entry.id} ${key} must be ${expected}`);
      }
    }
    validateManifestAssetName(entry.asset, `asset ${entry.id}`);
    validateManifestAssetName(entry.checksumAsset, `asset ${entry.id} checksum`);
    if (entry.checksumAsset !== `${entry.asset}.sha256`) {
      throw new Error(`asset ${entry.id} checksum file must be ${entry.asset}.sha256`);
    }
    if (logicalAssets.has(entry.asset)) throw new Error(`asset manifest duplicate logical asset: ${entry.asset}`);
    logicalAssets.add(entry.asset);
    if (entry.sha256 !== undefined) validateManifestDigest(entry.sha256, `asset ${entry.id} sha256`);
    if (entry.sizeBytes !== undefined) validateManifestSize(entry.sizeBytes, `asset ${entry.id} sizeBytes`);

    if (entry.parts !== undefined) {
      if (manifest.schemaVersion !== 2) {
        throw new Error(`asset ${entry.id} parts require asset manifest schemaVersion 2`);
      }
      if (!Array.isArray(entry.parts) || entry.parts.length < 2) {
        throw new Error(`asset ${entry.id} parts must contain at least two ordered entries`);
      }
      validateManifestDigest(entry.sha256, `asset ${entry.id} sha256`);
      validateManifestSize(entry.sizeBytes, `asset ${entry.id} sizeBytes`, { allowZero: false });
      let totalSize = 0;
      for (let index = 0; index < entry.parts.length; index += 1) {
        const part = entry.parts[index];
        if (!part || typeof part !== 'object') throw new Error(`asset ${entry.id} part ${index + 1} must be an object`);
        for (const key of ['asset', 'checksumAsset']) {
          validateManifestAssetName(part[key], `asset ${entry.id} part ${index + 1} ${key}`);
        }
        const expectedPartAsset = assetPartFileName(entry.asset, index + 1);
        if (part.asset !== expectedPartAsset) {
          throw new Error(`asset ${entry.id} part ${index + 1} must be ${expectedPartAsset}`);
        }
        if (part.checksumAsset !== `${part.asset}.sha256`) {
          throw new Error(`asset ${entry.id} part ${index + 1} checksum file must be ${part.asset}.sha256`);
        }
        validateManifestDigest(part.sha256, `asset ${entry.id} part ${index + 1} sha256`);
        validateManifestSize(part.sizeBytes, `asset ${entry.id} part ${index + 1} sizeBytes`, { allowZero: false });
        if (part.sizeBytes >= GITHUB_RELEASE_ASSET_LIMIT_BYTES) {
          throw new Error(`asset ${entry.id} part ${index + 1} must be smaller than 2 GiB`);
        }
        for (const name of [part.asset, part.checksumAsset]) {
          if (uploadedAssets.has(name)) throw new Error(`asset manifest duplicate uploaded asset: ${name}`);
          uploadedAssets.add(name);
        }
        totalSize += part.sizeBytes;
      }
      if (totalSize !== entry.sizeBytes) {
        throw new Error(`asset ${entry.id} parts total ${totalSize} bytes does not match ${entry.sizeBytes}`);
      }
    } else {
      if (uploadedAssets.has(entry.asset)) throw new Error(`asset manifest duplicate uploaded asset: ${entry.asset}`);
      uploadedAssets.add(entry.asset);
    }
    if (uploadedAssets.has(entry.checksumAsset)) {
      throw new Error(`asset manifest duplicate uploaded asset: ${entry.checksumAsset}`);
    }
    uploadedAssets.add(entry.checksumAsset);
    if (entry.kind === 'docker-archive' && entry.loadedTag !== expectedImage) {
      throw new Error(`docker archive asset ${entry.id} loadedTag must be ${expectedImage}`);
    }
    if (entry.kind === 'oci-layout') {
      const expectedRootfs =
        `boxlite/${definition.packageName}/${manifest.version}/${definition.platformSlug}/oci`;
      if (entry.rootfsPathRelative !== expectedRootfs) {
        throw new Error(`oci layout asset ${entry.id} rootfsPathRelative must be ${expectedRootfs}`);
      }
    }
    if (manifestMetadata) {
      const entryMetadata = validateSandboxReleaseMetadata(entry.sandboxMetadata, {
        version: manifest.version,
      });
      assertSandboxMetadataEqual(entryMetadata, manifestMetadata, `asset ${entry.id}`);
    } else if (entry.sandboxMetadata !== undefined) {
      throw new Error(`legacy asset ${entry.id} cannot include metadata without manifest metadata`);
    }
  }
  const requiredIds = new Set(SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => definition.id));
  for (const id of requiredIds) {
    if (!ids.has(id)) throw new Error(`asset manifest missing required entry: ${id}`);
  }
  if (uploadedAssets.size > GITHUB_RELEASE_MAX_ASSETS) {
    throw new Error(
      `asset manifest requires ${uploadedAssets.size} uploads, exceeding GitHub's ${GITHUB_RELEASE_MAX_ASSETS}-asset limit`,
    );
  }
}

export function writeManifest({ version, owner, outDir, sandboxMetadata }) {
  mkdirSync(outDir, { recursive: true });
  const manifest = buildManifest({ version, owner, outDir, sandboxMetadata });
  validateManifest(manifest, { version });
  writeFileSync(join(outDir, IMAGE_ASSET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function verifyLocalAssetSet({ version, outDir, decompressAsset }) {
  const manifestPath = join(outDir, IMAGE_ASSET_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`missing ${IMAGE_ASSET_MANIFEST}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest, { version });
  for (const entry of manifest.assets) {
    const checksumPath = join(outDir, basename(entry.checksumAsset));
    if (!existsSync(checksumPath)) throw new Error(`missing checksum ${entry.checksumAsset}`);
    const assetPaths = entry.parts
      ? entry.parts.map((part) => {
        const partPath = join(outDir, basename(part.asset));
        const partChecksumPath = join(outDir, basename(part.checksumAsset));
        if (!existsSync(partPath)) throw new Error(`missing asset part ${part.asset}`);
        if (!existsSync(partChecksumPath)) throw new Error(`missing checksum ${part.checksumAsset}`);
        const sizeBytes = statSync(partPath).size;
        if (sizeBytes !== part.sizeBytes) {
          throw new Error(`size mismatch for ${part.asset}: expected ${part.sizeBytes}, got ${sizeBytes}`);
        }
        const actualPart = sha256File(partPath);
        const expectedPart = checksumDigest(partChecksumPath, part.asset);
        if (actualPart !== expectedPart) {
          throw new Error(`checksum mismatch for ${part.asset}: expected ${expectedPart}, got ${actualPart}`);
        }
        if (part.sha256 !== actualPart) {
          throw new Error(`manifest checksum mismatch for ${part.asset}: expected ${part.sha256}, got ${actualPart}`);
        }
        return partPath;
      })
      : [join(outDir, basename(entry.asset))];
    if (!entry.parts && !existsSync(assetPaths[0])) throw new Error(`missing asset ${entry.asset}`);
    const actualSize = assetPaths.reduce((total, path) => total + statSync(path).size, 0);
    if (entry.sizeBytes !== undefined && actualSize !== entry.sizeBytes) {
      throw new Error(`size mismatch for ${entry.asset}: expected ${entry.sizeBytes}, got ${actualSize}`);
    }
    const actual = sha256Files(assetPaths);
    const expected = checksumDigest(checksumPath, entry.asset);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${entry.asset}: expected ${expected}, got ${actual}`);
    }
    if (entry.sha256 && entry.sha256 !== actual) {
      throw new Error(`manifest checksum mismatch for ${entry.asset}: expected ${entry.sha256}, got ${actual}`);
    }
    if (manifest.sandboxMetadata !== undefined) {
      const packagedMetadata = inspectPackagedAssetMetadata(entry, assetPaths, {
        version: manifest.version,
        decompressAsset,
      });
      const entryMetadata = validateSandboxReleaseMetadata(entry.sandboxMetadata, {
        version: manifest.version,
      });
      assertSandboxMetadataEqual(packagedMetadata, entryMetadata, `packaged asset ${entry.id}`);
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function runToFile(command, args, outputPath) {
  const output = openSync(outputPath, 'w');
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', output, 'pipe'],
    });
    if (result.status !== 0) {
      const detail = result.stderr?.trim();
      throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    closeSync(output);
  }
}

function decompressZstdAsset(source, target) {
  const sources = Array.isArray(source) ? source : [source];
  if (sources.length === 1) {
    run('zstd', ['-d', '-q', '-f', sources[0], '-o', target]);
    return;
  }
  run('sh', [
    '-c',
    'target=$1; shift; cat -- "$@" | zstd -d -q -f -o "$target"',
    'cap-zstd-parts',
    target,
    ...sources,
  ]);
}

function normalizedTarMember(member) {
  let normalized = member;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null;
  return normalized;
}

function tarMemberIndex(archivePath) {
  const result = spawnSync('tar', ['-tf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`could not list tar archive ${basename(archivePath)}: ${result.stderr?.trim() ?? ''}`);
  }
  const members = new Map();
  for (const raw of result.stdout.split('\n')) {
    const normalized = normalizedTarMember(raw);
    if (normalized) members.set(normalized, raw);
  }
  return members;
}

function requireTarMember(members, path, label) {
  const member = members.get(path);
  if (!member) throw new Error(`${label} missing ${path}`);
  return member;
}

function extractTarMemberToFile(archivePath, member, outputPath) {
  runToFile('tar', ['-xOf', archivePath, member], outputPath);
}

function extractTarMemberText(archivePath, member, label) {
  const result = spawnSync('tar', ['-xOf', archivePath, member], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} could not read ${member}: ${result.stderr?.trim() ?? ''}`);
  }
  return result.stdout;
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fileCompression(path, mediaType) {
  if (mediaType?.endsWith('+gzip')) return 'gzip';
  if (mediaType?.endsWith('+zstd')) return 'zstd';
  const header = Buffer.alloc(4);
  const input = openSync(path, 'r');
  let bytesRead;
  try {
    bytesRead = readSync(input, header, 0, header.length, 0);
  } finally {
    closeSync(input);
  }
  if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) return 'gzip';
  if (bytesRead === 4 && header.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  return 'none';
}

function materializeLayerTar(blobPath, mediaType, targetPath) {
  const compression = fileCompression(blobPath, mediaType);
  if (compression === 'gzip') {
    runToFile('gzip', ['-dc', blobPath], targetPath);
    return targetPath;
  }
  if (compression === 'zstd') {
    run('zstd', ['-d', '-q', '-f', blobPath, '-o', targetPath]);
    return targetPath;
  }
  return blobPath;
}

function layerRemovesSandboxMetadata(members) {
  return [
    'etc/cap/.wh.sandbox-metadata.json',
    'etc/cap/.wh..wh..opq',
    'etc/.wh.cap',
    'etc/.wh..wh..opq',
    '.wh.etc',
    '.wh..wh..opq',
  ].some((path) => members.has(path));
}

function readMetadataFromLayers(layers, extractLayer, { version, tempDir, label }) {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const blobPath = join(tempDir, `layer-${index}.blob`);
    const tarPath = join(tempDir, `layer-${index}.tar`);
    try {
      extractLayer(layers[index], blobPath);
      const effectiveTarPath = materializeLayerTar(blobPath, layers[index].mediaType, tarPath);
      const members = tarMemberIndex(effectiveTarPath);
      const metadataMember = members.get(SANDBOX_METADATA_RELATIVE_PATH);
      if (metadataMember) {
        const metadata = parseJsonText(
          extractTarMemberText(effectiveTarPath, metadataMember, label),
          `${label} sandbox metadata`,
        );
        return validateSandboxReleaseMetadata(metadata, { version });
      }
      if (layerRemovesSandboxMetadata(members)) {
        throw new Error(`${label} removes /${SANDBOX_METADATA_RELATIVE_PATH}`);
      }
    } finally {
      rmSync(blobPath, { force: true });
      rmSync(tarPath, { force: true });
    }
  }
  throw new Error(`${label} missing /${SANDBOX_METADATA_RELATIVE_PATH}`);
}

function readDockerArchiveMetadata(archivePath, { version, tempDir, label }) {
  const members = tarMemberIndex(archivePath);
  const manifestMember = requireTarMember(members, 'manifest.json', label);
  const manifest = parseJsonText(
    extractTarMemberText(archivePath, manifestMember, label),
    `${label} manifest.json`,
  );
  if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0]?.Layers)) {
    throw new Error(`${label} must contain exactly one Docker image manifest`);
  }
  const layers = manifest[0].Layers.map((path) => ({
    member: requireTarMember(members, normalizedTarMember(path), label),
  }));
  return readMetadataFromLayers(
    layers,
    (layer, outputPath) => extractTarMemberToFile(archivePath, layer.member, outputPath),
    { version, tempDir, label },
  );
}

function ociBlobPath(digest, label) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest ?? '');
  if (!match) throw new Error(`${label} contains unsupported OCI digest ${JSON.stringify(digest)}`);
  return `blobs/sha256/${match[1]}`;
}

function readOciArchiveMetadata(archivePath, { version, tempDir, label }) {
  const members = tarMemberIndex(archivePath);
  const indexMember = requireTarMember(members, 'index.json', label);
  const index = parseJsonText(
    extractTarMemberText(archivePath, indexMember, label),
    `${label} index.json`,
  );
  if (!Array.isArray(index?.manifests) || index.manifests.length !== 1) {
    throw new Error(`${label} must contain exactly one OCI image manifest`);
  }
  const manifestPath = ociBlobPath(index.manifests[0].digest, label);
  const manifestMember = requireTarMember(members, manifestPath, label);
  const manifest = parseJsonText(
    extractTarMemberText(archivePath, manifestMember, label),
    `${label} OCI manifest`,
  );
  if (!Array.isArray(manifest?.layers) || manifest.layers.length === 0) {
    throw new Error(`${label} OCI manifest must contain layers`);
  }
  const layers = manifest.layers.map((layer) => ({
    member: requireTarMember(members, ociBlobPath(layer.digest, label), label),
    mediaType: layer.mediaType,
  }));
  return readMetadataFromLayers(
    layers,
    (layer, outputPath) => extractTarMemberToFile(archivePath, layer.member, outputPath),
    { version, tempDir, label },
  );
}

export function inspectPackagedAssetMetadata(
  definition,
  assetPath,
  { version, decompressAsset = decompressZstdAsset } = {},
) {
  const assetPaths = Array.isArray(assetPath) ? assetPath : [assetPath];
  if (assetPaths.length === 0) throw new Error('packaged asset requires at least one file');
  const tempDir = mkdtempSync(join(tmpdir(), 'cap-sandbox-asset-metadata-'));
  const archivePath = join(tempDir, 'asset.tar');
  const label = `${definition.id ?? definition.kind} packaged asset`;
  try {
    decompressAsset(assetPaths.length === 1 ? assetPaths[0] : assetPaths, archivePath);
    if (definition.kind === 'docker-archive') {
      return readDockerArchiveMetadata(archivePath, { version, tempDir, label });
    }
    if (definition.kind === 'oci-layout') {
      return readOciArchiveMetadata(archivePath, { version, tempDir, label });
    }
    throw new Error(`unsupported asset kind: ${definition.kind}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function inspectImageMetadata(definition, { version, owner }) {
  const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
  run('docker', ['pull', '--platform', definition.platform, image]);
  const containerId = runCapture('docker', [
    'create', '--platform', definition.platform, image,
  ]);
  if (!containerId) throw new Error(`could not create ${definition.id} for metadata inspection`);
  const tempDir = mkdtempSync(join(tmpdir(), 'cap-sandbox-metadata-'));
  const metadataPath = join(tempDir, 'sandbox-metadata.json');
  try {
    run('docker', ['cp', `${containerId}:/etc/cap/sandbox-metadata.json`, metadataPath]);
    return validateSandboxReleaseMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')), {
      version,
    });
  } finally {
    run('docker', ['rm', '-f', containerId]);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function requireTool(name) {
  if (!runCapture('sh', ['-c', `command -v ${name}`])) {
    throw new Error(`${name} is required to package sandbox image assets`);
  }
}

function platformParts(platform) {
  const [os, arch] = platform.split('/');
  return { os, arch };
}

function compressTar(inputTar, outputAsset) {
  run('zstd', ['-T0', '-19', '-f', inputTar, '-o', outputAsset]);
}

function prepareReleaseAssetPath(assetPath) {
  rmSync(assetPath, { force: true });
  rmSync(`${assetPath}.sha256`, { force: true });
  rmSync(`${assetPath}.sha256.captmp`, { force: true });
  removeReleaseAssetParts(assetPath);
}

function packageDockerArchive(definition, { version, owner, outDir, maxPartBytes }) {
  const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
  const asset = join(outDir, assetFileName(definition, version));
  const tmpTar = `${asset}.tmp.tar`;
  prepareReleaseAssetPath(asset);
  rmSync(tmpTar, { force: true });
  run('docker', ['pull', '--platform', definition.platform, image]);
  try {
    run('docker', ['save', image, '-o', tmpTar]);
    compressTar(tmpTar, asset);
    rmSync(tmpTar, { force: true });
    finalizeReleaseAsset(asset, { maxPartBytes });
  } finally {
    rmSync(tmpTar, { force: true });
  }
}

function packageOciLayout(definition, { version, owner, outDir, maxPartBytes }) {
  const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
  const asset = join(outDir, assetFileName(definition, version));
  const tmpRoot = `${asset}.tmp.oci`;
  const tmpTar = `${asset}.tmp.tar`;
  const { os, arch } = platformParts(definition.platform);
  prepareReleaseAssetPath(asset);
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(tmpTar, { force: true });
  try {
    run('skopeo', [
      'copy',
      '--override-os',
      os,
      '--override-arch',
      arch,
      `docker://${image}`,
      `oci:${tmpRoot}:${version}`,
    ]);
    run('tar', ['-C', tmpRoot, '-cf', tmpTar, '.']);
    compressTar(tmpTar, asset);
    rmSync(tmpTar, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
    finalizeReleaseAsset(asset, { maxPartBytes });
  } finally {
    rmSync(tmpTar, { force: true });
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function packageAssets({
  version,
  owner = 'xeonice',
  outDir,
  maxPartBytes = MAX_RELEASE_ASSET_PART_BYTES,
  cleanupImages = false,
}) {
  const tag = normalizeVersion(version);
  mkdirSync(outDir, { recursive: true });
  requireTool('docker');
  requireTool('skopeo');
  requireTool('tar');
  requireTool('zstd');
  let officialMetadata;
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    const image = `ghcr.io/${owner}/${definition.packageName}:${tag}`;
    try {
      const imageMetadata = inspectImageMetadata(definition, { version: tag, owner });
      if (officialMetadata) {
        assertSandboxMetadataEqual(imageMetadata, officialMetadata, `registry image ${definition.id}`);
      }
      officialMetadata ??= imageMetadata;
      if (definition.kind === 'docker-archive') {
        packageDockerArchive(definition, { version: tag, owner, outDir, maxPartBytes });
      } else if (definition.kind === 'oci-layout') {
        packageOciLayout(definition, { version: tag, owner, outDir, maxPartBytes });
      } else {
        throw new Error(`unsupported asset kind: ${definition.kind}`);
      }
    } finally {
      if (cleanupImages) run('docker', ['image', 'rm', '--force', image]);
    }
  }
  writeManifest({ version: tag, owner, outDir, sandboxMetadata: officialMetadata });
  verifyLocalAssetSet({ version: tag, outDir });
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = '1';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function usage() {
  return [
    'usage:',
    '  node scripts/release-image-assets.mjs package --version vX.Y.Z --out <dir> [--owner xeonice] [--cleanup-images]',
    '  node scripts/release-image-assets.mjs manifest --version vX.Y.Z --out <dir> --metadata <sandbox-metadata.json> [--owner xeonice]',
    '  node scripts/release-image-assets.mjs verify --version vX.Y.Z --out <dir>',
    '  node scripts/release-image-assets.mjs list --version vX.Y.Z --manifest <cap-image-assets.json>',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  if (!command || args.help) {
    console.log(usage());
    return;
  }
  const version = args.version;
  if (!version) throw new Error(`--version is required\n${usage()}`);
  if (command === 'list') {
    if (!args.manifest) throw new Error(`list requires --manifest <cap-image-assets.json>\n${usage()}`);
    const manifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8'));
    for (const name of expectedReleaseAssetNames(version, manifest)) console.log(name);
    return;
  }
  const outDir = args.out ? resolve(args.out) : null;
  if (!outDir) throw new Error(`--out is required\n${usage()}`);
  if (command === 'package') {
    packageAssets({
      version,
      owner: args.owner ?? 'xeonice',
      outDir,
      cleanupImages: args['cleanup-images'] === '1',
    });
    return;
  }
  if (command === 'manifest') {
    if (!args.metadata) throw new Error(`manifest requires --metadata <sandbox-metadata.json>\n${usage()}`);
    const sandboxMetadata = JSON.parse(readFileSync(resolve(args.metadata), 'utf8'));
    writeManifest({ version, owner: args.owner ?? 'xeonice', outDir, sandboxMetadata });
    return;
  }
  if (command === 'verify') {
    verifyLocalAssetSet({ version, outDir });
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
