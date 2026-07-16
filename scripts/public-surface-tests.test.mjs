import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FAST_STEP,
  FULL_PREREQUISITE_STEPS,
  REPO_ROOT,
  WATCH_STEP,
  WORKFLOW_TEST_FILES,
  WORKFLOW_TEST_STEP,
  collectMetadataDiffPaths,
  metadataStep,
  runFast,
  runFull,
  runStep,
} from './public-surface-tests.mjs';

const FOCUSED_TEST_SCRIPTS = Object.freeze({
  'packages/contracts/package.json': 'test:public-surface',
  'apps/api/package.json': 'test:public-surface',
  'apps/web/package.json': 'test:public-surface',
});

test('focused inventory is package-owned and excludes infrastructure suites', () => {
  const forbidden =
    /(?:e2e|integration|playwright|docker|postgres|credential|mcp-bearer-sdk|v1-request-validation|v1-runtime-models\.controller)/iu;

  for (const [relative, scriptName] of Object.entries(FOCUSED_TEST_SCRIPTS)) {
    const packageJson = JSON.parse(
      readFileSync(path.join(REPO_ROOT, relative), 'utf8'),
    );
    const script = packageJson.scripts?.[scriptName];
    assert.equal(typeof script, 'string', `${relative} owns ${scriptName}`);
    assert.doesNotMatch(script, forbidden, `${relative} focused inventory`);
    if (relative === 'packages/contracts/package.json') {
      assert.match(
        script,
        /scripts\/public-surface-\*\.test\.mjs/u,
        'the package-owned focused inventory includes every workflow contract and adversarial mutation test',
      );
    }
  }

  assert.deepEqual(FAST_STEP.args.slice(0, 4), [
    'exec',
    'turbo',
    'run',
    'test:public-surface',
  ]);
  assert.deepEqual(WATCH_STEP.args.slice(0, 4), [
    'exec',
    'turbo',
    'watch',
    'test:public-surface',
  ]);
  assert.deepEqual(WATCH_STEP.args.slice(4), FAST_STEP.args.slice(4));
  const turbo = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'turbo.json'), 'utf8'),
  );
  assert.ok(
    turbo.globalPassThroughEnv?.includes(
      'CAP_PUBLIC_SURFACE_EVIDENCE_PATH',
    ),
    'Turbo must pass the random focused-evidence artifact path to the API collector',
  );
});

test('full gate declares build/codegen and downstream typecheck before fast reuse', () => {
  assert.deepEqual(
    FULL_PREREQUISITE_STEPS.map((step) => step.args[3]),
    ['build', 'typecheck'],
  );
  assert.ok(FULL_PREREQUISITE_STEPS[0].args.includes('--force'));
  assert.deepEqual(WORKFLOW_TEST_FILES, [
    'scripts/openspec-metadata.test.mjs',
    'scripts/task-admission-migration-workflow.test.mjs',
    'scripts/release-image-gates.test.mjs',
    'scripts/release-tail.test.mjs',
    'scripts/public-surface-adversarial.test.mjs',
    'scripts/public-surface-files.test.mjs',
    'scripts/public-surface-hook.test.mjs',
    'scripts/public-surface-pre-push.test.mjs',
    'scripts/public-surface-tests.test.mjs',
  ]);
  assert.equal(WORKFLOW_TEST_STEP.command, process.execPath);
  assert.deepEqual(WORKFLOW_TEST_STEP.args, [
    '--test',
    ...WORKFLOW_TEST_FILES,
  ]);
  assert.deepEqual(metadataStep(['openspec/changes/example/tasks.md']).args, [
    'scripts/openspec-metadata.mjs',
    'validate-diff',
    '--phase',
    'verify',
    '--',
    'openspec/changes/example/tasks.md',
  ]);
});

test('command execution always uses fixed argv with shell false', () => {
  const calls = [];
  runStep(
    { name: 'fixture', command: 'fixture-command', args: ['one', 'two'] },
    {
      spawnSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['one', 'two']);
  assert.equal(calls[0].options.shell, false);
});

test('fast and full modes each run the fixed workflow and package inventories once', () => {
  const fastCalls = [];
  runFast({
    spawnSyncImpl(command, args, options) {
      fastCalls.push({ command, args, options });
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(
    fastCalls.map(({ command, args }) => [command, ...args]),
    [
      [WORKFLOW_TEST_STEP.command, ...WORKFLOW_TEST_STEP.args],
      [FAST_STEP.command, ...FAST_STEP.args],
    ],
  );

  const fullCalls = [];
  runFull({
    env: {},
    spawnSyncImpl(command, args, options) {
      fullCalls.push({ command, args, options });
      if (command === 'git' && args[0] === 'rev-parse') {
        return { status: 128, stdout: '' };
      }
      return { status: 0, stdout: '' };
    },
  });
  const fullGateCalls = fullCalls.filter(({ command }) => command !== 'git');
  assert.equal(
    fullGateCalls.filter(
      ({ command, args }) =>
        command === WORKFLOW_TEST_STEP.command &&
        args[0] === WORKFLOW_TEST_STEP.args[0],
    ).length,
    1,
  );
  assert.equal(
    fullGateCalls.filter(
      ({ command, args }) =>
        command === FAST_STEP.command && args.includes('test:public-surface'),
    ).length,
    1,
  );
  assert.ok(fullCalls.every(({ options }) => options.shell === false));
});

test('metadata diff combines committed, staged, unstaged, and non-ignored untracked paths', () => {
  const calls = [];
  const paths = collectMetadataDiffPaths({
    env: { CAP_PUBLIC_SURFACE_BASE_SHA: 'base-sha' },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes('--cached')) {
        return { status: 0, stdout: 'openspec/changes/a/tasks.md\0' };
      }
      if (args[0] === 'ls-files') {
        return {
          status: 0,
          stdout: 'openspec/changes/a/with space.md\0',
        };
      }
      if (!args.includes('base-sha...HEAD')) {
        return {
          status: 0,
          stdout: 'openspec/changes/a/surface-impact.json\0',
        };
      }
      return {
        status: 0,
        stdout:
          'packages/contracts/src/public-v1-operations.ts\0' +
          'openspec/changes/a/tasks.md\0',
      };
    },
  });
  assert.deepEqual(paths, [
    'openspec/changes/a/surface-impact.json',
    'openspec/changes/a/tasks.md',
    'openspec/changes/a/with space.md',
  ]);
  assert.ok(
    calls.some(({ args }) => args.includes('base-sha...HEAD')),
    'uses the complete base range rather than HEAD^',
  );
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === 'diff' &&
        !args.includes('--cached') &&
        !args.includes('base-sha...HEAD'),
    ),
    'includes unstaged tracked paths',
  );
  assert.ok(
    calls.some(
      ({ args }) =>
        args[0] === 'ls-files' &&
        args.includes('--others') &&
        args.includes('--exclude-standard'),
    ),
    'includes only non-ignored untracked paths',
  );
  assert.ok(
    calls
      .filter(({ args }) => args[0] === 'diff' || args[0] === 'ls-files')
      .every(({ args }) => args.includes('-z')),
    'uses NUL records for every path-producing Git command',
  );
  assert.ok(
    calls
      .filter(({ args }) => args[0] === 'diff' || args[0] === 'ls-files')
      .every(
        ({ args }) =>
          args.includes('--') && args.includes('openspec/changes'),
      ),
    'limits the potentially large untracked inventory to OpenSpec changes',
  );
  assert.ok(
    calls.every(({ options }) => options.maxBuffer >= 16 * 1024 * 1024),
    'large non-ignored worktrees do not overflow the synchronous Git reader',
  );
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('an ordinary local run includes an untracked OpenSpec change without an upstream', () => {
  const paths = collectMetadataDiffPaths({
    env: {},
    spawnSyncImpl(_command, args) {
      if (args[0] === 'ls-files') {
        // Git --exclude-standard omits the ignored fixture from this output.
        return {
          status: 0,
          stdout: 'openspec/changes/new feature/tasks.md\0',
        };
      }
      if (args[0] === 'rev-parse') return { status: 128, stdout: '' };
      return { status: 0, stdout: '' };
    },
  });
  assert.deepEqual(paths, ['openspec/changes/new feature/tasks.md']);
});

test('real Git discovery preserves spaced paths and never returns ignored changes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cap-public-surface-git-'));
  try {
    const init = spawnSync('git', ['init', '--quiet'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
    });
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(
      path.join(root, '.gitignore'),
      'openspec/changes/ignored-change/\n',
    );
    const visibleDirectory = path.join(
      root,
      'openspec',
      'changes',
      'new feature',
    );
    const ignoredDirectory = path.join(
      root,
      'openspec',
      'changes',
      'ignored-change',
    );
    mkdirSync(visibleDirectory, { recursive: true });
    mkdirSync(ignoredDirectory, { recursive: true });
    writeFileSync(path.join(visibleDirectory, 'tasks.md'), 'visible\n');
    writeFileSync(path.join(ignoredDirectory, 'tasks.md'), 'ignored\n');

    assert.deepEqual(collectMetadataDiffPaths({ cwd: root, env: {} }), [
      'openspec/changes/new feature/tasks.md',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit but unresolved pre-push/CI base fails closed', () => {
  assert.throws(
    () =>
      collectMetadataDiffPaths({
        env: { CAP_PUBLIC_SURFACE_BASE_SHA: 'missing-base' },
        spawnSyncImpl(_command, args) {
          if (args.includes('missing-base...HEAD')) {
            return { status: 128, stderr: 'bad revision' };
          }
          return { status: 0, stdout: '' };
        },
      }),
    /Unable to resolve public-surface base/u,
  );
});

test('a failed local path query cannot silently omit an OpenSpec change', () => {
  assert.throws(
    () =>
      collectMetadataDiffPaths({
        env: {},
        spawnSyncImpl(_command, args) {
          if (args[0] === 'ls-files') return { status: 128, stdout: '' };
          return { status: 0, stdout: '' };
        },
      }),
    /Unable to collect non-ignored untracked OpenSpec paths/u,
  );
});

test('Husky and CI reuse the stable root commands without copied inventories', () => {
  const preCommit = readFileSync(path.join(REPO_ROOT, '.husky/pre-commit'), 'utf8');
  const prePush = readFileSync(path.join(REPO_ROOT, '.husky/pre-push'), 'utf8');
  const workflow = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );

  assert.equal(
    preCommit.match(/public-surface-hook\.mjs staged/gu)?.length,
    1,
  );
  assert.match(
    preCommit,
    /^pnpm exec lint-staged && node scripts\/public-surface-hook\.mjs staged\s*$/u,
    'a lint-staged failure must short-circuit before the parity hook can mask it',
  );
  assert.match(prePush, /public-surface-pre-push\.mjs/u);
  assert.match(workflow, /^  public-surface-parity:$/mu);
  assert.match(workflow, /^    name: public-surface-parity$/mu);
  assert.match(workflow, /^        run: pnpm verify:public-surface$/mu);
  assert.match(workflow, /fetch-depth: 0/u);
});

test('focused source inventory cannot open ports, reach services, or use credentials', () => {
  const workflowSources = readdirSync(path.join(REPO_ROOT, 'scripts'))
    .filter(
      (file) =>
        /^public-surface-.*\.mjs$/u.test(file) &&
        file !== 'public-surface-tests.test.mjs',
    )
    .map((file) => `scripts/${file}`);
  const publicSurfaceSpecs = readdirSync(
    path.join(REPO_ROOT, 'apps/api/src/public-surface'),
  )
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `apps/api/src/public-surface/${file}`);
  const sources = [
    'scripts/openspec-metadata.mjs',
    'scripts/public-surface-adversarial.mjs',
    'scripts/public-surface-files.mjs',
    'scripts/public-surface-hook.mjs',
    'scripts/public-surface-pre-push.mjs',
    'scripts/public-surface-tests.mjs',
    ...WORKFLOW_TEST_FILES.filter(
      (file) => file !== 'scripts/public-surface-tests.test.mjs',
    ),
    'packages/contracts/src/public-v1-operations.test.mjs',
    'apps/api/src/v1/v1-operation-manifest.spec.ts',
    'apps/api/src/mcp/mcp.spec.ts',
    'apps/api/src/openapi/openapi.registry.spec.ts',
    ...publicSurfaceSpecs,
    'apps/web/src/components/api/api.test.ts',
    'apps/web/src/components/api/catalog-and-columns.test.ts',
    ...workflowSources,
  ];
  const forbidden =
    /(?:node:http|http\.createServer|net\.createServer|\.listen\s*\(|new\s+PrismaClient|DATABASE_URL|testcontainers|dockerode|playwright|\bfetch\s*\()/u;

  for (const relative of sources) {
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    assert.doesNotMatch(source, forbidden, relative);
  }
});
