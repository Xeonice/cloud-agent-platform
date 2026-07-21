import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  attestationAssetName,
  attestationChecksumAssetName,
  writeAttestationAsset,
} from './generate-task-model-attestation.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = join(repoRoot, 'scripts', 'release.sh');
const version = 'v1.2.3';
const metadata = {
  schemaVersion: 1,
  sandboxVersion: version,
  dependencies: { 'claude-code': '2.1.207', codex: '0.144.1', openspec: '1.4.1' },
};
// The GIT_SHA the fake published cap-api image "bakes" — the attestation
// fixture is generated against it so the buildIdentity verification passes.
const imageGitSha = 'a1b2c3d4'.repeat(5);

// release.sh validates the attestation against the REAL contracts schema via
// the generator module; build the dist output when absent (CI runs this after
// `pnpm turbo build`, so this is a no-op there).
const contractsDistModule = join(
  repoRoot,
  'packages/contracts/dist/task-model-capability.js',
);
if (!existsSync(contractsDistModule)) {
  const build = spawnSync('pnpm', ['--filter', '@cap/contracts', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  assert.equal(build.status, 0, 'could not build @cap/contracts for attestation validation');
}

// Valid attestation fixture (build-matched to the fake image GIT_SHA) plus a
// tampered copy whose bytes no longer match the checksum companion.
const attestationDir = mkdtempSync(join(tmpdir(), 'cap-release-tail-attestation-'));
const attestationFixture = await writeAttestationAsset({
  version,
  gitSha: imageGitSha,
  compatVerified: true,
  outDir: attestationDir,
});
const attestationPath = attestationFixture.assetPath;
const attestationChecksumPath = join(attestationDir, attestationChecksumAssetName(version));
const tamperedDir = mkdtempSync(join(tmpdir(), 'cap-release-tail-attestation-bad-'));
const tamperedAttestationPath = join(tamperedDir, attestationAssetName(version));
writeFileSync(
  tamperedAttestationPath,
  `${readFileSync(attestationPath, 'utf8').trimEnd()} \n`,
  'utf8',
);

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
  const noAttestationAssetsPath = join(root, 'release-assets-no-attestation.json');

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
    attestationAssetName(version),
    attestationChecksumAssetName(version),
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
  // Images and sandbox assets are all present, but the attestation asset is
  // absent — release verification must fail closed on it.
  const withoutAttestation = assets.filter(
    (asset) => !asset.name.startsWith('cap-task-model-attestation-'),
  );
  writeFileSync(
    noAttestationAssetsPath,
    JSON.stringify({ assets: withoutAttestation }),
    'utf8',
  );

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
    case "$*" in
      *"cap-task-model-attestation-"*)
        cp "$CAP_FAKE_ATTESTATION" "$out/cap-task-model-attestation-\${CAP_TEST_VERSION}.json"
        cp "$CAP_FAKE_ATTESTATION_CHECKSUM" "$out/cap-task-model-attestation-\${CAP_TEST_VERSION}.json.sha256"
        ;;
      *) cp "$CAP_FAKE_MANIFEST" "$out/cap-image-assets.json" ;;
    esac
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
      *"process.env.GIT_SHA"*) printf '%s' "$CAP_FAKE_IMAGE_GIT_SHA" ;;
      *"--entrypoint /usr/local/bin/node"*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
`);
  writeCommand(binDir, 'sleep', 'exit 0');

  return {
    root,
    binDir,
    logPath,
    manifestPath,
    releaseAssetsPath,
    badReleaseAssetsPath,
    noAttestationAssetsPath,
  };
}

function runRelease(fixture, releaseAssetsPath, extraEnv = {}) {
  return spawnSync('bash', [releaseScript, version], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:${process.env.PATH}`,
      CAP_TEST_LOG: fixture.logPath,
      CAP_TEST_VERSION: version,
      CAP_FAKE_MANIFEST: fixture.manifestPath,
      CAP_FAKE_RELEASE_ASSETS: releaseAssetsPath,
      CAP_FAKE_ATTESTATION: attestationPath,
      CAP_FAKE_ATTESTATION_CHECKSUM: attestationChecksumPath,
      CAP_FAKE_IMAGE_GIT_SHA: imageGitSha,
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
assert.match(
  success.stdout,
  /cap-task-model-attestation-v1\.2\.3\.json -> present/,
);
assert.match(
  success.stdout,
  /cap-task-model-attestation-v1\.2\.3\.json\.sha256 -> present/,
);
assert.match(
  success.stdout,
  /cap-task-model-attestation-v1\.2\.3\.json -> checksum, schema, and buildIdentity verified/,
);
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

// Fail closed: images and sandbox assets present, attestation asset absent.
const missingAttestation = runRelease(fixture, fixture.noAttestationAssetsPath);
assert.notEqual(missingAttestation.status, 0);
assert.match(
  `${missingAttestation.stdout}\n${missingAttestation.stderr}`,
  /release images are present but the task-model attestation asset is missing at v1\.2\.3/,
);

// Fail closed: attestation bytes do not match the .sha256 companion.
const tampered = runRelease(fixture, fixture.releaseAssetsPath, {
  CAP_FAKE_ATTESTATION: tamperedAttestationPath,
});
assert.notEqual(tampered.status, 0);
assert.match(
  `${tampered.stdout}\n${tampered.stderr}`,
  /attestation checksum mismatch/,
);
assert.match(
  `${tampered.stdout}\n${tampered.stderr}`,
  /task-model attestation asset for v1\.2\.3 failed verification/,
);

// Fail closed: attested buildIdentity differs from the published cap-api
// image's baked GIT_SHA.
const identityMismatch = runRelease(fixture, fixture.releaseAssetsPath, {
  CAP_FAKE_IMAGE_GIT_SHA: 'f'.repeat(40),
});
assert.notEqual(identityMismatch.status, 0);
assert.match(
  `${identityMismatch.stdout}\n${identityMismatch.stderr}`,
  /attestation buildIdentity does not match the published cap-api baked GIT_SHA/,
);

console.log('release tail split-asset and attestation verification passed');
