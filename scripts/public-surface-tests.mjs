#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERIFIER_ALLOWLIST } from './openspec-metadata.mjs';
import { cleanGitEnv } from './git-env.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const OPENSPEC_CHANGE_PATHSPEC = 'openspec/changes';

export const PUBLIC_SURFACE_FILTERS = Object.freeze([
  '@cap/contracts',
  '@cap/api',
  '@cap/web',
]);

const FILTER_ARGS = Object.freeze(
  PUBLIC_SURFACE_FILTERS.map((filter) => `--filter=${filter}`),
);

export const FAST_STEP = Object.freeze({
  name: 'focused public-surface tests',
  command: 'pnpm',
  args: Object.freeze([
    'exec',
    'turbo',
    'run',
    'test:public-surface',
    ...FILTER_ARGS,
  ]),
});

export const WATCH_STEP = Object.freeze({
  name: 'public-surface watch',
  command: 'pnpm',
  args: Object.freeze([
    'exec',
    'turbo',
    'watch',
    'test:public-surface',
    ...FILTER_ARGS,
  ]),
});

export const FULL_PREREQUISITE_STEPS = Object.freeze([
  Object.freeze({
    name: 'fresh public-surface build and code generation',
    command: 'pnpm',
    args: Object.freeze([
      'exec',
      'turbo',
      'run',
      'build',
      '--force',
      ...FILTER_ARGS,
    ]),
  }),
  Object.freeze({
    name: 'public-surface downstream typecheck',
    command: 'pnpm',
    args: Object.freeze([
      'exec',
      'turbo',
      'run',
      'typecheck',
      ...FILTER_ARGS,
    ]),
  }),
]);

const [
  metadataInvariantCommand,
  metadataInvariantFlag,
  metadataInvariantFile,
  ...unexpectedMetadataInvariantArgs
] = VERIFIER_ALLOWLIST['openspec-metadata'].argv[0];
if (
  metadataInvariantFlag !== '--test' ||
  !metadataInvariantFile ||
  unexpectedMetadataInvariantArgs.length > 0
) {
  throw new Error('openspec-metadata verifier must remain one fixed Node test');
}

export const WORKFLOW_TEST_FILES = Object.freeze([
  metadataInvariantFile,
  'scripts/task-admission-migration-workflow.test.mjs',
  'scripts/release-image-gates.test.mjs',
  'scripts/release-tail.test.mjs',
  'scripts/public-surface-adversarial.test.mjs',
  'scripts/public-surface-files.test.mjs',
  'scripts/public-surface-hook.test.mjs',
  'scripts/public-surface-pre-push.test.mjs',
  'scripts/public-surface-tests.test.mjs',
  'scripts/git-env.test.mjs',
]);

export const WORKFLOW_TEST_STEP = Object.freeze({
  name: 'public-surface workflow invariants',
  command: metadataInvariantCommand,
  args: Object.freeze([metadataInvariantFlag, ...WORKFLOW_TEST_FILES]),
});

function lines(output) {
  return String(output ?? '')
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function nulPaths(output) {
  return String(output ?? '')
    .split('\0')
    .filter((value) => value.length > 0);
}

function runGit(args, { cwd, spawnSyncImpl, nulSeparated = false }) {
  const result = spawnSyncImpl('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    shell: false,
    // Resolve the repository from cwd only (isolate-fixture-git-env).
    env: cleanGitEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return null;
  return nulSeparated ? nulPaths(result.stdout) : lines(result.stdout);
}

/**
 * Resolve the complete committed range (when available) plus every local
 * non-ignored OpenSpec change. This deliberately does not guess from a single
 * commit.
 * Pre-push and CI pass a base SHA; ordinary local runs use the branch upstream
 * when one exists. All file-producing Git commands use NUL records so valid
 * paths are never trimmed or split on whitespace.
 */
export function collectMetadataDiffPaths({
  cwd = REPO_ROOT,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  const paths = new Set();
  const addPaths = (values) => {
    for (const value of values ?? []) {
      if (value.startsWith(`${OPENSPEC_CHANGE_PATHSPEC}/`)) paths.add(value);
    }
  };
  const addRequiredGitPaths = (args, description) => {
    const values = runGit(args, {
      cwd,
      spawnSyncImpl,
      nulSeparated: true,
    });
    if (values === null) {
      throw new Error(`Unable to collect ${description}.`);
    }
    addPaths(values);
  };

  addRequiredGitPaths(
    [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMRD',
      '-z',
      '--',
      OPENSPEC_CHANGE_PATHSPEC,
    ],
    'staged OpenSpec paths',
  );
  addRequiredGitPaths(
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMRD',
      '-z',
      '--',
      OPENSPEC_CHANGE_PATHSPEC,
    ],
    'unstaged OpenSpec paths',
  );
  addRequiredGitPaths(
    [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      OPENSPEC_CHANGE_PATHSPEC,
    ],
    'non-ignored untracked OpenSpec paths',
  );

  let base = env.CAP_PUBLIC_SURFACE_BASE_SHA?.trim();
  if (!base && env.GITHUB_BASE_REF?.trim()) {
    base = `origin/${env.GITHUB_BASE_REF.trim()}`;
  }
  if (!base) {
    const upstream = runGit(
      ['rev-parse', '--verify', '@{upstream}'],
      { cwd, spawnSyncImpl },
    );
    base = upstream?.[0];
  }

  if (base) {
    const committed = runGit(
      [
        'diff',
        '--name-only',
        '--diff-filter=ACMRD',
        '-z',
        `${base}...HEAD`,
        '--',
        OPENSPEC_CHANGE_PATHSPEC,
      ],
      { cwd, spawnSyncImpl, nulSeparated: true },
    );
    if (committed === null) {
      throw new Error(`Unable to resolve public-surface base ${base}.`);
    }
    addPaths(committed);
  }

  return Object.freeze([...paths].sort());
}

export function metadataStep(paths) {
  return Object.freeze({
    name: 'OpenSpec public-surface metadata',
    command: process.execPath,
    args: Object.freeze([
      'scripts/openspec-metadata.mjs',
      'validate-diff',
      '--phase',
      'verify',
      '--',
      ...paths,
    ]),
  });
}

export function runStep(
  step,
  {
    cwd = REPO_ROOT,
    env = process.env,
    spawnSyncImpl = spawnSync,
  } = {},
) {
  process.stdout.write(`\n[public-surface] ${step.name}\n`);
  const result = spawnSyncImpl(step.command, [...step.args], {
    cwd,
    // Defense in depth: suite children (and their spawned git) never inherit
    // hook-exported GIT_* locator variables (isolate-fixture-git-env).
    env: cleanGitEnv(env),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${step.name} failed with exit status ${result.status ?? 'unknown'}`,
    );
  }
}

export function runFast(options = {}) {
  runStep(WORKFLOW_TEST_STEP, options);
  runStep(FAST_STEP, options);
}

export function runFull(options = {}) {
  for (const step of FULL_PREREQUISITE_STEPS) runStep(step, options);
  // Diff validation intentionally ignores untouched legacy changes. The
  // invariant suite is therefore always required to catch workflow/mirror
  // drift even when no active OpenSpec change is selected by the diff.
  runStep(WORKFLOW_TEST_STEP, options);
  const paths = collectMetadataDiffPaths(options);
  runStep(metadataStep(paths), options);
  // Both root modes reuse these exact package-owned tests without recursively
  // invoking the root fast command (which would repeat the workflow suite).
  runStep(FAST_STEP, options);
}

export function main(argv = process.argv.slice(2)) {
  const [mode = 'fast'] = argv;
  if (argv.length > 1 || !['fast', 'full', 'watch'].includes(mode)) {
    throw new Error('Usage: public-surface-tests.mjs [fast|full|watch]');
  }
  if (mode === 'fast') runFast();
  else if (mode === 'full') runFull();
  else runStep(WATCH_STEP);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
