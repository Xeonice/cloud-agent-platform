#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPublicSurfaceFiles } from './public-surface-files.mjs';
import { VERIFIER_ALLOWLIST } from './openspec-metadata.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

function freezeStep(name, command, args) {
  return Object.freeze({ name, command, args: Object.freeze([...args]) });
}

const [metadataInvariantCommand, ...metadataInvariantArgs] =
  VERIFIER_ALLOWLIST['openspec-metadata'].argv[0];

export const OPENSPEC_METADATA_INVARIANT_STEP = freezeStep(
  'OpenSpec metadata invariants',
  metadataInvariantCommand,
  metadataInvariantArgs,
);

export function affectedTypecheckFilters(classification) {
  const categories = new Set(classification.categories);
  const filters = new Set();
  if (categories.has('contracts') || categories.has('developerWorkflow')) {
    filters.add('@cap/contracts');
    filters.add('@cap/api');
    filters.add('@cap/web');
  }
  if (
    categories.has('publicV1') ||
    categories.has('mcp') ||
    categories.has('openapi') ||
    categories.has('publicErrors')
  ) {
    filters.add('@cap/api');
  }
  if (categories.has('playground')) filters.add('@cap/web');
  return Object.freeze([...filters]);
}

export function planPublicSurfaceHook(files, { root = REPO_ROOT } = {}) {
  const classification = classifyPublicSurfaceFiles(files, root);
  const steps = [];

  if (classification.openspecMetadata) {
    steps.push(OPENSPEC_METADATA_INVARIANT_STEP);
    steps.push(
      freezeStep('OpenSpec metadata', process.execPath, [
        'scripts/openspec-metadata.mjs',
        'validate-diff',
        '--phase',
        'apply',
        '--',
        ...classification.files,
      ]),
    );
  }

  if (classification.publicSurface) {
    const filters = affectedTypecheckFilters(classification);
    if (filters.length > 0) {
      steps.push(
        freezeStep('affected public-surface typechecks', 'pnpm', [
          'exec',
          'turbo',
          'run',
          'typecheck',
          ...filters.map((filter) => `--filter=${filter}`),
        ]),
      );
    }
    steps.push(
      freezeStep('focused public-surface parity', 'pnpm', [
        'test:public-surface',
      ]),
    );
  }

  return Object.freeze({ classification, steps: Object.freeze(steps) });
}

export function readStagedFiles({ cwd = REPO_ROOT, spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMRD', '-z'],
    { cwd, encoding: 'utf8', shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Unable to read staged files.');
  }
  return Object.freeze(
    String(result.stdout ?? '')
      .split('\0')
      .filter(Boolean),
  );
}

export function runHookPlan(
  plan,
  { cwd = REPO_ROOT, env = process.env, spawnSyncImpl = spawnSync } = {},
) {
  for (const step of plan.steps) {
    process.stdout.write(`\n[public-surface hook] ${step.name}\n`);
    const result = spawnSyncImpl(step.command, [...step.args], {
      cwd,
      env,
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
}

export function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  let files;
  if (mode === 'file' && rest.length === 1) files = rest;
  else if (mode === 'staged' && rest.length === 0) files = readStagedFiles();
  else throw new Error('Usage: public-surface-hook.mjs file <path> | staged');

  const plan = planPublicSurfaceHook(files);
  runHookPlan(plan);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
