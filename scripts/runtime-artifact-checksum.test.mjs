import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  runtimeArtifactChecksum,
  runtimeArtifactPath,
} from './runtime-artifact-checksum.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cap-runtime-artifact-'));
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  return {
    root,
    bin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('Claude checksum follows the executable symlink and hashes the actual artifact', async () => {
  const files = fixture();
  try {
    const artifact = join(files.root, 'claude-real');
    const bytes = Buffer.from('claude-binary-fixture\0contents');
    writeFileSync(artifact, bytes);
    chmodSync(artifact, 0o755);
    symlinkSync(artifact, join(files.bin, 'claude'));

    assert.equal(
      await runtimeArtifactChecksum('claude-code', {
        pathEnv: [files.bin, '/unused'].join(delimiter),
      }),
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.equal(
      await runtimeArtifactPath('claude-code', { pathEnv: files.bin }),
      realpathSync(artifact),
    );
  } finally {
    files.cleanup();
  }
});

test('Codex hashes the platform-native binary rather than the JavaScript launcher', async () => {
  const files = fixture();
  try {
    const launcher = join(files.bin, 'codex');
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    chmodSync(launcher, 0o755);
    const native = join(
      files.root,
      'vendor',
      'aarch64-apple-darwin',
      'bin',
      'codex',
    );
    mkdirSync(join(native, '..'), { recursive: true });
    const nativeBytes = Buffer.from('native-codex-artifact');
    writeFileSync(native, nativeBytes);
    chmodSync(native, 0o755);

    assert.equal(
      await runtimeArtifactChecksum('codex', {
        platform: 'darwin',
        arch: 'arm64',
        pathEnv: files.bin,
      }),
      createHash('sha256').update(nativeBytes).digest('hex'),
    );
  } finally {
    files.cleanup();
  }
});

test('unknown runtime and missing executable fail closed', async () => {
  await assert.rejects(
    runtimeArtifactChecksum('unknown', { pathEnv: '' }),
    /Unsupported runtime artifact/,
  );
  await assert.rejects(
    runtimeArtifactChecksum('claude-code', { pathEnv: '' }),
    /Runtime executable is unavailable/,
  );
});
