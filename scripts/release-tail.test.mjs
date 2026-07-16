import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = join(repoRoot, 'scripts', 'release.sh');
const version = 'v1.2.3';
const metadata = {
  schemaVersion: 1,
  sandboxVersion: version,
  dependencies: { 'claude-code': '2.1.207', codex: '0.144.1', openspec: '1.4.1' },
};

function writeCommand(binDir, name, body) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function entry(definition) {
  const asset = `${definition.package}-${version}-${definition.slug}.${definition.extension}`;
  const image = `ghcr.io/xeonice/${definition.package}:${version}`;
  return {
    id: definition.id,
    provider: definition.provider,
    package: definition.package,
    image,
    platform: definition.platform,
    kind: definition.kind,
    asset,
    checksumAsset: `${asset}.sha256`,
    ...(definition.kind === 'docker-archive'
      ? { loadedTag: image }
      : { rootfsPathRelative: `boxlite/${definition.package}/${version}/${definition.slug}/oci` }),
    sandboxMetadata: metadata,
    sha256: definition.sha256,
    sizeBytes: definition.sizeBytes,
    ...(definition.parts ? { parts: definition.parts.map((part, index) => {
      const partAsset = `${asset}.part-${String(index + 1).padStart(4, '0')}`;
      return {
        asset: partAsset,
        checksumAsset: `${partAsset}.sha256`,
        sha256: part.sha256,
        sizeBytes: part.sizeBytes,
      };
    }) } : {}),
  };
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cap-release-tail-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const logPath = join(root, 'commands.log');
  const manifestPath = join(root, 'cap-image-assets.json');
  const releaseAssetsPath = join(root, 'release-assets.json');
  const badReleaseAssetsPath = join(root, 'release-assets-bad.json');

  const manifest = {
    schemaVersion: 2,
    version,
    owner: 'xeonice',
    generatedAt: '2026-07-11T00:00:00Z',
    sandboxMetadata: metadata,
    assets: [
      entry({
        id: 'aio-sandbox-linux-amd64',
        provider: 'aio',
        package: 'cap-aio-sandbox',
        platform: 'linux/amd64',
        slug: 'linux-amd64',
        kind: 'docker-archive',
        extension: 'docker.tar.zst',
        sha256: 'a'.repeat(64),
        sizeBytes: 2,
        parts: [
          { sha256: 'b'.repeat(64), sizeBytes: 1 },
          { sha256: 'c'.repeat(64), sizeBytes: 1 },
        ],
      }),
      entry({
        id: 'boxlite-sandbox-linux-arm64',
        provider: 'boxlite',
        package: 'cap-boxlite-sandbox',
        platform: 'linux/arm64',
        slug: 'linux-arm64',
        kind: 'oci-layout',
        extension: 'oci.tar.zst',
        sha256: 'd'.repeat(64),
        sizeBytes: 3,
      }),
      entry({
        id: 'boxlite-sandbox-linux-amd64',
        provider: 'boxlite',
        package: 'cap-boxlite-sandbox',
        platform: 'linux/amd64',
        slug: 'linux-amd64',
        kind: 'oci-layout',
        extension: 'oci.tar.zst',
        sha256: 'e'.repeat(64),
        sizeBytes: 4,
      }),
    ],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const names = [
    'docker-compose.prod.yml',
    'docker-compose.prod.env.example',
    'cap-image-assets.json',
  ];
  const dataAssets = [];
  for (const asset of manifest.assets) {
    names.push(asset.checksumAsset);
    if (asset.parts) {
      for (const part of asset.parts) {
        names.push(part.asset, part.checksumAsset);
        dataAssets.push({ name: part.asset, digest: `sha256:${part.sha256}`, size: part.sizeBytes });
      }
    } else {
      names.push(asset.asset);
      dataAssets.push({ name: asset.asset, digest: `sha256:${asset.sha256}`, size: asset.sizeBytes });
    }
  }
  const assets = [
    ...dataAssets,
    ...names.map((name) => ({ name, digest: `sha256:${'f'.repeat(64)}`, size: 64 })),
  ].filter((asset, index, all) => all.findIndex((candidate) => candidate.name === asset.name) === index);
  writeFileSync(releaseAssetsPath, JSON.stringify({ assets }), 'utf8');
  const badAssets = structuredClone(assets);
  badAssets.find((asset) => asset.name.endsWith('.part-0002')).digest = `sha256:${'0'.repeat(64)}`;
  writeFileSync(badReleaseAssetsPath, JSON.stringify({ assets: badAssets }), 'utf8');

  writeCommand(binDir, 'gh', `
echo "gh $*" >> "$CAP_TEST_LOG"
case "$1 $2" in
  "auth status") echo "Logged in to github.com account test"; exit 0 ;;
  "release view")
    case "$*" in
      *"--json assets"*) cat "$CAP_FAKE_RELEASE_ASSETS" ;;
      *) exit 0 ;;
    esac
    ;;
  "release download")
    out=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--dir" ]; then out="$arg"; fi
      prev="$arg"
    done
    cp "$CAP_FAKE_MANIFEST" "$out/cap-image-assets.json"
    ;;
  "run list") echo 123 ;;
  "run watch") exit 0 ;;
  *) exit 1 ;;
esac
`);
  writeCommand(binDir, 'curl', `
case "$*" in
  *"%{http_code}"*) printf 200 ;;
  *) printf '{"token":"test"}' ;;
esac
`);
  writeCommand(binDir, 'docker', `
echo "docker $*" >> "$CAP_TEST_LOG"
case "$1" in
  pull) exit 0 ;;
  run)
    case "$*" in
      *"--entrypoint git"*)
        if [ "$CAP_FAKE_GIT_MISSING" = "1" ]; then
          echo "ENOENT cap-release-tail-secret-canary" >&2
          exit 127
        fi
        echo "git version 2.39.5"
        ;;
      *"--entrypoint /usr/local/bin/node"*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`);
  writeCommand(binDir, 'sleep', 'exit 0');

  return { root, binDir, logPath, manifestPath, releaseAssetsPath, badReleaseAssetsPath };
}

function runRelease(fixture, releaseAssetsPath, extraEnv = {}) {
  return spawnSync('bash', [releaseScript, version], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      CAP_TEST_LOG: fixture.logPath,
      CAP_FAKE_MANIFEST: fixture.manifestPath,
      CAP_FAKE_RELEASE_ASSETS: releaseAssetsPath,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

const fixture = makeFixture();
const success = runRelease(fixture, fixture.releaseAssetsPath);
assert.equal(success.status, 0, success.stderr || success.stdout);
assert.match(success.stdout, /part-0001 -> digest and size verified/);
assert.match(success.stdout, /part-0002 -> digest and size verified/);
assert.match(success.stdout, /cap-api image smoke passed: Git and startup preflight verified/);
assert.doesNotMatch(success.stdout, /cap-aio-sandbox-v1\.2\.3-linux-amd64\.docker\.tar\.zst -> present/);
const commands = readFileSync(fixture.logPath, 'utf8');
assert.match(commands, /run list .*--branch v1\.2\.3 .*--event release/);
assert.match(
  commands,
  /docker pull --platform linux\/amd64 ghcr\.io\/xeonice\/cap-api:v1\.2\.3/,
);
assert.match(
  commands,
  /docker run --rm --pull=never --platform linux\/amd64 --entrypoint git ghcr\.io\/xeonice\/cap-api:v1\.2\.3 --version/,
);
assert.match(
  commands,
  /docker run --rm --pull=never --platform linux\/amd64 --entrypoint \/usr\/local\/bin\/node ghcr\.io\/xeonice\/cap-api:v1\.2\.3 -e/,
);

const missingGit = runRelease(fixture, fixture.releaseAssetsPath, {
  CAP_FAKE_GIT_MISSING: '1',
});
assert.notEqual(missingGit.status, 0);
assert.match(
  `${missingGit.stdout}\n${missingGit.stderr}`,
  /published cap-api:v1\.2\.3 is missing its required Git runtime dependency/,
);
assert.doesNotMatch(
  `${missingGit.stdout}\n${missingGit.stderr}`,
  /cap-release-tail-secret-canary|ENOENT/,
);

const failure = runRelease(fixture, fixture.badReleaseAssetsPath);
assert.notEqual(failure.status, 0);
assert.match(`${failure.stdout}\n${failure.stderr}`, /part-0002 -> digest\/size mismatch/);

console.log('release tail split-asset verification passed');
