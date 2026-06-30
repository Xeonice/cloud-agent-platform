#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IMAGE_ASSET_MANIFEST = 'cap-image-assets.json';

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

export function buildManifest({ version, owner = 'xeonice', outDir = '.', generatedAt = new Date().toISOString() }) {
  const tag = normalizeVersion(version);
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
  }
  const requiredIds = new Set(SANDBOX_IMAGE_ASSET_DEFINITIONS.map((definition) => definition.id));
  for (const id of requiredIds) {
    if (!ids.has(id)) throw new Error(`asset manifest missing required entry: ${id}`);
  }
}

export function writeManifest({ version, owner, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const manifest = buildManifest({ version, owner, outDir });
  validateManifest(manifest, { version });
  writeFileSync(join(outDir, IMAGE_ASSET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function verifyLocalAssetSet({ version, outDir }) {
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
  for (const definition of SANDBOX_IMAGE_ASSET_DEFINITIONS) {
    if (definition.kind === 'docker-archive') {
      packageDockerArchive(definition, { version: tag, owner, outDir });
    } else if (definition.kind === 'oci-layout') {
      packageOciLayout(definition, { version: tag, owner, outDir });
    } else {
      throw new Error(`unsupported asset kind: ${definition.kind}`);
    }
  }
  writeManifest({ version: tag, owner, outDir });
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
    '  node scripts/release-image-assets.mjs manifest --version vX.Y.Z --out <dir> [--owner xeonice]',
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
    writeManifest({ version, owner: args.owner ?? 'xeonice', outDir });
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
