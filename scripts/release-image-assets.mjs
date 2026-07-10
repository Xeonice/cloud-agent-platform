#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeExactSandboxVersionValue } from './sandbox-version-selector.mjs';

export const IMAGE_ASSET_MANIFEST = 'cap-image-assets.json';

const SANDBOX_METADATA_RELATIVE_PATH = 'etc/cap/sandbox-metadata.json';
const SANDBOX_DEPENDENCY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const REQUIRED_OFFICIAL_DEPENDENCIES = ['codex', 'claude-code', 'openspec'];

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

export function expectedReleaseAssetNames(version) {
  const names = [IMAGE_ASSET_MANIFEST];
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    names.push(assetFileName(definition, version), checksumFileName(definition, version));
  }
  return names;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
    if (existsSync(assetPath)) {
      entry.sha256 = sha256File(assetPath);
      entry.sizeBytes = statSync(assetPath).size;
    }
    return entry;
  });
  return {
    schemaVersion: 1,
    version: tag,
    owner,
    generatedAt,
    ...(metadata ? { sandboxMetadata: metadata } : {}),
    assets,
  };
}

export function validateManifest(manifest, { version } = {}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('asset manifest must be a JSON object');
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error(`asset manifest schemaVersion must be 1, received ${manifest.schemaVersion}`);
  }
  if (version !== undefined && manifest.version !== normalizeVersion(version)) {
    throw new Error(`asset manifest version ${manifest.version} does not match ${normalizeVersion(version)}`);
  }
  if (!Array.isArray(manifest.assets)) {
    throw new Error('asset manifest assets must be an array');
  }
  const manifestMetadata = validateSandboxReleaseMetadata(manifest.sandboxMetadata, {
    version: manifest.version,
  });
  const ids = new Set();
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
    if (entry.kind === 'docker-archive' && typeof entry.loadedTag !== 'string') {
      throw new Error(`docker archive asset ${entry.id} must include loadedTag`);
    }
    if (entry.kind === 'oci-layout' && typeof entry.rootfsPathRelative !== 'string') {
      throw new Error(`oci layout asset ${entry.id} must include rootfsPathRelative`);
    }
    const entryMetadata = validateSandboxReleaseMetadata(entry.sandboxMetadata, {
      version: manifest.version,
    });
    assertSandboxMetadataEqual(entryMetadata, manifestMetadata, `asset ${entry.id}`);
  }
  const requiredIds = new Set(SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => definition.id));
  for (const id of requiredIds) {
    if (!ids.has(id)) throw new Error(`asset manifest missing required entry: ${id}`);
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
    const assetPath = join(outDir, basename(entry.asset));
    const checksumPath = join(outDir, basename(entry.checksumAsset));
    if (!existsSync(assetPath)) throw new Error(`missing asset ${entry.asset}`);
    if (!existsSync(checksumPath)) throw new Error(`missing checksum ${entry.checksumAsset}`);
    const actual = sha256File(assetPath);
    const checksumText = readFileSync(checksumPath, 'utf8').trim();
    const expected = checksumText.split(/\s+/)[0];
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${entry.asset}: expected ${expected}, got ${actual}`);
    }
    if (entry.sha256 && entry.sha256 !== actual) {
      throw new Error(`manifest checksum mismatch for ${entry.asset}: expected ${entry.sha256}, got ${actual}`);
    }
    const packagedMetadata = inspectPackagedAssetMetadata(entry, assetPath, {
      version: manifest.version,
      decompressAsset,
    });
    const entryMetadata = validateSandboxReleaseMetadata(entry.sandboxMetadata, {
      version: manifest.version,
    });
    assertSandboxMetadataEqual(packagedMetadata, entryMetadata, `packaged asset ${entry.id}`);
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
  run('zstd', ['-d', '-q', '-f', source, '-o', target]);
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
  const tempDir = mkdtempSync(join(tmpdir(), 'cap-sandbox-asset-metadata-'));
  const archivePath = join(tempDir, 'asset.tar');
  const label = `${definition.id ?? definition.kind} packaged asset`;
  try {
    decompressAsset(assetPath, archivePath);
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

function writeChecksum(assetPath) {
  const digest = sha256File(assetPath);
  writeFileSync(`${assetPath}.sha256`, `${digest}  ${basename(assetPath)}\n`, 'utf8');
}

function compressTar(inputTar, outputAsset) {
  run('zstd', ['-T0', '-19', '-f', inputTar, '-o', outputAsset]);
}

function packageDockerArchive(definition, { version, owner, outDir }) {
  const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
  const asset = join(outDir, assetFileName(definition, version));
  const tmpTar = `${asset}.tmp.tar`;
  run('docker', ['pull', '--platform', definition.platform, image]);
  run('docker', ['save', image, '-o', tmpTar]);
  compressTar(tmpTar, asset);
  rmSync(tmpTar, { force: true });
  writeChecksum(asset);
}

function packageOciLayout(definition, { version, owner, outDir }) {
  const image = `ghcr.io/${owner}/${definition.packageName}:${version}`;
  const asset = join(outDir, assetFileName(definition, version));
  const tmpRoot = `${asset}.tmp.oci`;
  const tmpTar = `${asset}.tmp.tar`;
  const { os, arch } = platformParts(definition.platform);
  rmSync(tmpRoot, { recursive: true, force: true });
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
  writeChecksum(asset);
}

export function packageAssets({ version, owner = 'xeonice', outDir }) {
  const tag = normalizeVersion(version);
  mkdirSync(outDir, { recursive: true });
  requireTool('docker');
  requireTool('skopeo');
  requireTool('tar');
  requireTool('zstd');
  let officialMetadata;
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    const imageMetadata = inspectImageMetadata(definition, { version: tag, owner });
    if (officialMetadata) {
      assertSandboxMetadataEqual(imageMetadata, officialMetadata, `registry image ${definition.id}`);
    }
    officialMetadata ??= imageMetadata;
    if (definition.kind === 'docker-archive') {
      packageDockerArchive(definition, { version: tag, owner, outDir });
    } else if (definition.kind === 'oci-layout') {
      packageOciLayout(definition, { version: tag, owner, outDir });
    } else {
      throw new Error(`unsupported asset kind: ${definition.kind}`);
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
    '  node scripts/release-image-assets.mjs package --version vX.Y.Z --out <dir> [--owner xeonice]',
    '  node scripts/release-image-assets.mjs manifest --version vX.Y.Z --out <dir> --metadata <sandbox-metadata.json> [--owner xeonice]',
    '  node scripts/release-image-assets.mjs verify --version vX.Y.Z --out <dir>',
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
  const outDir = args.out ? resolve(args.out) : null;
  if (!version || !outDir) throw new Error(`--version and --out are required\n${usage()}`);
  if (command === 'package') {
    packageAssets({ version, owner: args.owner ?? 'xeonice', outDir });
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
