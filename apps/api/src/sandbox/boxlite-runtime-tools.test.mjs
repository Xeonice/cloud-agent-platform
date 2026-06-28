import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);

function findRepoRoot(start) {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not locate repo root from ${start}`);
}

function compileRuntimeTools() {
  const apiDir = join(repoRoot, 'apps', 'api');
  const cacheDir = join(apiDir, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outDir = mkdtempSync(join(cacheDir, 'cap-boxlite-runtime-tools-'));
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      '--types',
      'node',
      '--outDir',
      outDir,
      'src/sandbox/boxlite-runtime-tools.ts',
    ],
    { cwd: apiDir, stdio: 'pipe' },
  );
  return { outDir, compiled: join(outDir, 'boxlite-runtime-tools.js') };
}

const { outDir, compiled } = compileRuntimeTools();

try {
  const mod = await import(pathToFileURL(compiled).href);

  assert.deepEqual(mod.readBoxLiteRuntimeRequiredTools({}), [
    'bash',
    'claude',
    'codex',
    'git',
    'gzip',
    'node',
    'openspec',
    'sh',
    'tar',
    'tmux',
  ]);
  assert.deepEqual(
    mod.readBoxLiteRuntimeRequiredTools({
      BOXLITE_RUNTIME_REQUIRED_TOOLS: 'sh, git  bash git',
    }),
    ['sh', 'git', 'bash'],
  );
  assert.throws(
    () =>
      mod.readBoxLiteRuntimeRequiredTools({
        BOXLITE_RUNTIME_REQUIRED_TOOLS: 'git;rm',
      }),
    /invalid tool name/,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
