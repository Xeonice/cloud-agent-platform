import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OPENSPEC_METADATA_INVARIANT_STEP,
  affectedTypecheckFilters,
  planPublicSurfaceHook,
  readStagedFiles,
  runHookPlan,
} from './public-surface-hook.mjs';

const ROOT = '/workspace/cap';

test('contracts edits typecheck all downstream consumers and run fast once', () => {
  const plan = planPublicSurfaceHook(
    ['packages/contracts/src/public-v1-operations.ts'],
    { root: ROOT },
  );
  assert.deepEqual(affectedTypecheckFilters(plan.classification), [
    '@cap/contracts',
    '@cap/api',
    '@cap/web',
  ]);
  assert.equal(
    plan.steps.filter((step) => step.args.includes('test:public-surface')).length,
    1,
  );
});

test('removing an API or Web package focused script still triggers the shared gate', () => {
  for (const packageJson of [
    'apps/api/package.json',
    'apps/web/package.json',
  ]) {
    const plan = planPublicSurfaceHook([packageJson], { root: ROOT });
    assert.equal(plan.classification.publicSurface, true, packageJson);
    assert.deepEqual(
      affectedTypecheckFilters(plan.classification),
      ['@cap/contracts', '@cap/api', '@cap/web'],
      packageJson,
    );
    assert.equal(
      plan.steps.filter((step) => step.args.includes('test:public-surface'))
        .length,
      1,
      packageJson,
    );
  }
});

test('OpenSpec edits validate metadata without paying for the public suite', () => {
  const plan = planPublicSurfaceHook(
    ['openspec/changes/example/tasks.md'],
    { root: ROOT },
  );
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps[0], OPENSPEC_METADATA_INVARIANT_STEP);
  assert.deepEqual(plan.steps[0].args, [
    '--test',
    'scripts/openspec-metadata.test.mjs',
  ]);
  assert.ok(plan.steps[1].args.includes('validate-diff'));
  assert.ok(plan.steps[1].args.includes('openspec/changes/example/tasks.md'));
});

test('a skill-only diff runs invariants and fails closed on mirror drift', () => {
  const plan = planPublicSurfaceHook(
    ['.codex/skills/openspec-apply-change/SKILL.md'],
    { root: ROOT },
  );
  assert.equal(plan.classification.publicSurface, false);
  assert.equal(plan.classification.openspecMetadata, true);
  assert.deepEqual(plan.steps[0], OPENSPEC_METADATA_INVARIANT_STEP);

  const calls = [];
  assert.throws(
    () =>
      runHookPlan(plan, {
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options });
          return { status: 9 };
        },
      }),
    /OpenSpec metadata invariants failed/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
});

test('overlapping API categories still produce one typecheck and one focused run', () => {
  const plan = planPublicSurfaceHook(
    [
      'apps/api/src/v1/v1-tasks.controller.ts',
      'apps/api/src/mcp/mcp-tools.ts',
      'apps/api/src/openapi/openapi.registry.ts',
    ],
    { root: ROOT },
  );
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(
    plan.steps[0].args.filter((arg) => arg.startsWith('--filter=')),
    ['--filter=@cap/api'],
  );
  assert.deepEqual(plan.steps[1].args, ['test:public-surface']);
});

test('unrelated files keep the existing hook behavior and add no parity command', () => {
  const plan = planPublicSurfaceHook(['README.md'], { root: ROOT });
  assert.deepEqual(plan.steps, []);
});

test('staged reader preserves spaces and uses NUL-safe git output', () => {
  const calls = [];
  const files = readStagedFiles({
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: 'packages/contracts/src/a.ts\0docs/with space.md\0',
      };
    },
  });
  assert.deepEqual(files, [
    'packages/contracts/src/a.ts',
    'docs/with space.md',
  ]);
  assert.ok(calls[0].args.includes('-z'));
  assert.equal(calls[0].options.shell, false);
});

test('hook execution never evaluates file-derived shell text', () => {
  const calls = [];
  const plan = planPublicSurfaceHook(
    ['packages/contracts/src/public-v1-operations.ts'],
    { root: ROOT },
  );
  runHookPlan(plan, {
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.shell === false));
});
