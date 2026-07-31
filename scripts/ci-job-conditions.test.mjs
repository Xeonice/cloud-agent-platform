import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT } from './public-surface-tests.mjs';

/**
 * Guards which CI jobs may be skipped, and which may never be.
 *
 * Conditioning a job is the kind of edit that removes coverage without failing:
 * a filter that never matches turns the job into a no-op reporting success, and
 * "did not run" is indistinguishable from "passed" on the checks list.
 *
 * The opposite mistake is worse and less obvious. `typecheck + lint + test` and
 * `public-surface-parity` are REQUIRED status checks on `main`. A required check
 * that is skipped rather than reported leaves the merge permanently pending, so
 * those two must stay unconditional no matter how appealing the saved minutes
 * look.
 *
 * Run: node --test scripts/ci-job-conditions.test.mjs
 */

// Conditioned jobs, grouped by the filter output they gate on. Each family
// must use the IDENTICAL expression — a per-job variant is how they drift.
const CONDITIONED_FAMILIES = {
  backend: [
    'task-model-n-minus-one-compat',
    'task-admission-migration-compatibility',
    'boot-smoke',
    'boot-smoke-stateful',
  ],
  web: ['web-visual', 'web-terminal-stories'],
};
const CONDITIONED = Object.values(CONDITIONED_FAMILIES).flat();

/** Required status checks on `main`. Skipping one of these blocks every merge. */
const MUST_ALWAYS_RUN = ['public-surface-parity', 'typecheck-lint'];

function workflowJob(source, key) {
  const marker = `\n  ${key}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job ${key}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-z0-9-]+:\s*$/mu);
  return next === -1
    ? source.slice(start)
    : source.slice(start, start + marker.length + next);
}

const workflow = readFileSync(
  path.join(REPO_ROOT, '.github/workflows/ci.yml'),
  'utf8',
);

test('a required status check is never conditioned', () => {
  for (const key of MUST_ALWAYS_RUN) {
    const job = workflowJob(workflow, key);
    assert.doesNotMatch(
      job,
      /^    if:/mu,
      `${key} is a required status check on main; a skipped required check never reports and blocks the merge permanently`,
    );
    assert.doesNotMatch(
      job,
      /^    needs: changes$/mu,
      `${key} must not depend on the path filter — depending on it is how it becomes skippable`,
    );
  }
});

test('every conditioned job gates on the shared path filter', () => {
  for (const [output, keys] of Object.entries(CONDITIONED_FAMILIES)) {
    const expression = new RegExp(
      `^    if: needs\\.changes\\.outputs\\.${output} == 'true'$`,
      'mu',
    );
    for (const key of keys) {
      const job = workflowJob(workflow, key);
      assert.match(job, /^    needs: changes$/mu, `${key} must depend on the filter job`);
      assert.match(
        job,
        expression,
        `${key} must gate on the same '${output}' expression as its family siblings; a per-job variant is how they drift`,
      );
    }
  }
});

test('the filter job publishes the outputs its consumers read', () => {
  const job = workflowJob(workflow, 'changes');
  assert.match(job, /^      backend: \$\{\{ steps\.filter\.outputs\.backend \}\}$/mu);
  assert.match(job, /^      web: \$\{\{ steps\.filter\.outputs\.web \}\}$/mu);
  assert.match(
    job,
    /^          fetch-depth: 0$/mu,
    'a shallow checkout cannot diff against the base ref',
  );
});

test('an unusable base ref fails open rather than skipping every gate', () => {
  const job = workflowJob(workflow, 'changes');
  assert.match(
    job,
    /0000000000000000000000000000000000000000/u,
    'the null SHA (a new branch push) must be handled explicitly',
  );
  const fallback = job.slice(job.indexOf('no usable base ref'));
  assert.match(
    fallback.slice(0, 200),
    /backend=true/u,
    'with no base to diff against the filter must run the gates, not skip them',
  );
  assert.match(
    fallback.slice(0, 200),
    /web=true/u,
    'the web output must fail open on an unusable base ref exactly like backend',
  );
});

test('the match itself fails open: only a definite no-match lowers the flag', () => {
  const job = workflowJob(workflow, 'changes');

  assert.match(
    job,
    /^          BACKEND=true$/mu,
    'the flag must start true so any unexpected path leaves the gates running',
  );
  assert.match(
    job,
    /^          if \[\[ "\$\{MATCH_STATUS\}" -eq 1 \]\]; then$/mu,
    'only grep exit 1 (definite no-match) may lower the flag; exit >1 is an error and must not skip gates',
  );
  assert.doesNotMatch(
    job,
    /if grep -qE .* <<<|if echo "\$\{CHANGED\}" \| grep/u,
    'branching directly on grep is what inverted this filter once: `grep -q` closes its input on first match, and under pipefail a successful match reported failure',
  );
  assert.doesNotMatch(
    job,
    /\| grep/u,
    'no pipe into grep — the writer can take SIGPIPE and pipefail turns that into a false negative',
  );
});

function filterMatchers(job) {
  const patterns = [...job.matchAll(/grep -qE '\^\((.+?)\)'/gu)].map(
    (match) => new RegExp(`^(${match[1].replaceAll('\\\\', '\\')})`, 'u'),
  );
  assert.equal(
    patterns.length,
    2,
    'the filter must carry exactly two readable alternations: backend first, web second',
  );
  return { backend: patterns[0], web: patterns[1] };
}

test('the path filter treats package and tooling edits as backend-affecting', () => {
  const job = workflowJob(workflow, 'changes');
  const matcher = filterMatchers(job).backend;

  for (const affecting of [
    'apps/api/src/main.ts',
    'apps/api/prisma/schema.prisma',
    'packages/contracts/src/task.ts',
    'packages/sandbox-core/src/index.ts',
    'scripts/boot-smoke.sh',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'package.json',
  ]) {
    assert.match(affecting, matcher, `${affecting} can reach the api and must run the gates`);
  }

  for (const inert of [
    'docs/product-layout.md',
    'README.md',
    'apps/web/src/routes/index.tsx',
    'apps/www/src/page.tsx',
    'openspec/specs/guardrails/spec.md',
  ]) {
    assert.doesNotMatch(
      inert,
      matcher,
      `${inert} cannot reach the api; running the api gates for it is the waste this filter removes`,
    );
  }
});

test('the web filter treats console, package, and tooling edits as web-affecting', () => {
  const job = workflowJob(workflow, 'changes');
  const matcher = filterMatchers(job).web;

  for (const affecting of [
    'apps/web/src/routes/index.tsx',
    'apps/web/e2e/visual/manifest.ts',
    'apps/web/playwright.terminal-stories.config.ts',
    'packages/ui/src/terminal.tsx',
    'packages/contracts/src/task.ts',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
    'package.json',
  ]) {
    assert.match(
      affecting,
      matcher,
      `${affecting} can reach the console and must run the web lanes`,
    );
  }

  for (const inert of [
    'docs/product-layout.md',
    'README.md',
    'apps/api/src/main.ts',
    'apps/www/src/page.tsx',
    'scripts/boot-smoke.sh',
    'openspec/specs/guardrails/spec.md',
  ]) {
    assert.doesNotMatch(
      inert,
      matcher,
      `${inert} cannot reach the console; running the web lanes for it is the waste this filter removes`,
    );
  }
});
