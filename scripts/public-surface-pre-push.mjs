#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO_SHA = /^0+$/u;

export function pushedRemoteShas(input) {
  const shas = new Set();
  for (const line of input.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 4) {
      throw new Error(`Malformed pre-push ref line: ${line}`);
    }
    const remoteSha = fields[3];
    if (!ZERO_SHA.test(remoteSha)) shas.add(remoteSha);
  }
  if (shas.size > 1) {
    throw new Error(
      'Multiple remote bases are being pushed; run pnpm verify:public-surface for each ref.',
    );
  }
  return [...shas][0];
}

function gitOutput(args, { cwd, spawnSyncImpl }) {
  const result = spawnSyncImpl('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return undefined;
  return String(result.stdout ?? '').trim() || undefined;
}

export function resolvePushBase({
  input,
  remoteName,
  cwd = REPO_ROOT,
  spawnSyncImpl = spawnSync,
}) {
  const existing = pushedRemoteShas(input);
  if (existing) return existing;

  if (!remoteName) {
    throw new Error('A new-branch push requires the Git remote name.');
  }
  const defaultRef = gitOutput(
    ['symbolic-ref', '--short', `refs/remotes/${remoteName}/HEAD`],
    { cwd, spawnSyncImpl },
  );
  if (!defaultRef) {
    throw new Error(
      `Unable to resolve ${remoteName}'s default branch for a complete pre-push diff.`,
    );
  }
  const mergeBase = gitOutput(['merge-base', 'HEAD', defaultRef], {
    cwd,
    spawnSyncImpl,
  });
  if (!mergeBase) {
    throw new Error(`Unable to resolve a merge base with ${defaultRef}.`);
  }
  return mergeBase;
}

export function runPrePush({
  input,
  remoteName,
  cwd = REPO_ROOT,
  env = process.env,
  spawnSyncImpl = spawnSync,
}) {
  const base = resolvePushBase({ input, remoteName, cwd, spawnSyncImpl });
  const result = spawnSyncImpl('pnpm', ['verify:public-surface'], {
    cwd,
    env: { ...env, CAP_PUBLIC_SURFACE_BASE_SHA: base },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `verify:public-surface failed with exit status ${result.status ?? 'unknown'}`,
    );
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    throw new Error('Usage: public-surface-pre-push.mjs [remote-name]');
  }
  runPrePush({
    input: readFileSync(0, 'utf8'),
    remoteName: argv[0],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
