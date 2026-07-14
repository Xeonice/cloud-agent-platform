#!/usr/bin/env node

import {
  constants,
  createReadStream,
  existsSync,
  realpathSync,
} from 'node:fs';
import { access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CODEX_PACKAGE_BY_TARGET = {
  'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};

export async function runtimeArtifactPath(runtime, options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const executable = options.executable ?? (await findExecutable(runtimeCommand(runtime), pathEnv));
  const resolvedExecutable = realpathSync(executable);
  if (runtime !== 'codex') return resolvedExecutable;

  const packageTarget = CODEX_PACKAGE_BY_TARGET[`${platform}-${arch}`];
  if (!packageTarget) {
    throw new Error(`Unsupported Codex artifact platform: ${platform}/${arch}`);
  }
  const [platformPackage, targetTriple] = packageTarget;
  const requireFromLauncher = createRequire(pathToFileURL(resolvedExecutable));
  let vendorRoot;
  try {
    const packageJson = requireFromLauncher.resolve(`${platformPackage}/package.json`);
    vendorRoot = join(dirname(packageJson), 'vendor');
  } catch {
    vendorRoot = join(dirname(resolvedExecutable), '..', 'vendor');
  }
  const binary = join(
    vendorRoot,
    targetTriple,
    'bin',
    platform === 'win32' ? 'codex.exe' : 'codex',
  );
  if (!existsSync(binary)) {
    throw new Error('Codex native artifact is unavailable.');
  }
  return realpathSync(binary);
}

export async function runtimeArtifactChecksum(runtime, options = {}) {
  const artifact = await runtimeArtifactPath(runtime, options);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  return hash.digest('hex');
}

async function findExecutable(command, pathEnv) {
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH without exposing host paths in errors.
    }
  }
  throw new Error(`Runtime executable is unavailable: ${command}`);
}

function runtimeCommand(runtime) {
  if (runtime === 'codex') return 'codex';
  if (runtime === 'claude-code' || runtime === 'claude') return 'claude';
  throw new Error(`Unsupported runtime artifact: ${runtime}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runtimeArtifactChecksum(process.argv[2])
    .then((checksum) => process.stdout.write(`${checksum}\n`))
    .catch(() => {
      process.stderr.write('runtime artifact checksum unavailable\n');
      process.exitCode = 1;
    });
}
