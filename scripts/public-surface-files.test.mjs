import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  classifyPublicSurfaceFiles,
  toRepoRelativePath,
} from './public-surface-files.mjs';

const ROOT = path.resolve('/workspace/cap');

test('normalizes absolute and relative paths inside the repository', () => {
  assert.equal(
    toRepoRelativePath('/workspace/cap/packages/contracts/src/v1.ts', ROOT),
    'packages/contracts/src/v1.ts',
  );
  assert.equal(
    toRepoRelativePath('apps/api/src/mcp/mcp-tools.ts', ROOT),
    'apps/api/src/mcp/mcp-tools.ts',
  );
  assert.equal(toRepoRelativePath('/workspace/other/file.ts', ROOT), null);
  assert.equal(toRepoRelativePath('', ROOT), null);
});

test('classifies all public programmatic projections once', () => {
  const result = classifyPublicSurfaceFiles(
    [
      'packages/contracts/src/public-v1-operations.ts',
      'apps/api/src/v1/v1-tasks.controller.ts',
      'apps/api/src/mcp/mcp-tools.ts',
      'apps/api/src/openapi/openapi.registry.ts',
      'apps/api/src/public-surface/public-error.ts',
      'apps/web/src/components/api/catalog.ts',
      'apps/web/src/components/api/catalog.ts',
    ],
    ROOT,
  );

  assert.equal(result.publicSurface, true);
  assert.equal(result.hasTypeScript, true);
  assert.deepEqual(result.categories, [
    'contracts',
    'mcp',
    'openapi',
    'playground',
    'publicErrors',
    'publicV1',
  ]);
  assert.equal(result.files.length, 6);
});

test('classifies every local and CI enforcement entrypoint', () => {
  for (const file of [
    'package.json',
    'apps/api/package.json',
    'apps/web/package.json',
    'turbo.json',
    'lint-staged.config.mjs',
    '.husky/pre-commit',
    '.husky/pre-push',
    '.claude/hooks/typecheck-lint-edited.sh',
    '.github/workflows/ci.yml',
    'scripts/public-surface-adversarial.mjs',
    'scripts/public-surface-adversarial.test.mjs',
    'scripts/public-surface-files.mjs',
    'scripts/public-surface-tests.mjs',
  ]) {
    const result = classifyPublicSurfaceFiles([file], ROOT);
    assert.equal(result.publicSurface, true, file);
    assert.deepEqual(result.categories, ['developerWorkflow'], file);
  }
});

test('classifies change artifacts and workflow sources as OpenSpec metadata', () => {
  for (const file of [
    'openspec/changes/example/proposal.md',
    'openspec/changes/example/design.md',
    'openspec/changes/example/tasks.md',
    'openspec/changes/example/surface-impact.json',
    'openspec/changes/example/specs/mcp-server/spec.md',
    '.codex/skills/openspec-apply-change/SKILL.md',
    '.claude/skills/openspec-propose/SKILL.md',
    '.claude/workflows/opsx-verify.js',
  ]) {
    const result = classifyPublicSurfaceFiles([file], ROOT);
    assert.equal(result.openspecMetadata, true, file);
  }
});

test('unrelated documentation does not trigger public or OpenSpec gates', () => {
  const result = classifyPublicSurfaceFiles(
    ['README.md', 'docs/architecture.md', 'apps/web/src/routes/index.tsx'],
    ROOT,
  );
  assert.equal(result.publicSurface, false);
  assert.equal(result.openspecMetadata, false);
  assert.equal(result.hasTypeScript, true);
  assert.deepEqual(result.categories, []);
});
