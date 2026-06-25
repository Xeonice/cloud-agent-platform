import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const envName = 'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES';

function findRepoRoot(start) {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not locate repo root from ${start}`);
}

function findFile(root, fileName) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return full;
    }
  }
  return null;
}

function compileConfig() {
  const apiDir = join(repoRoot, 'apps', 'api');
  const cacheDir = join(apiDir, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outDir = mkdtempSync(join(cacheDir, 'cap-sandbox-provider-config-'));
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
      'src/sandbox/sandbox-provider-config.ts',
    ],
    { cwd: apiDir, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'sandbox-provider-config.js');
  assert(compiled && existsSync(compiled), 'compiled sandbox-provider-config.js exists');
  return { outDir, compiled };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function withEnv(value, fn) {
  const previous = process.env[envName];
  if (value === undefined) delete process.env[envName];
  else process.env[envName] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
}

const { outDir, compiled } = compileConfig();

try {
  const mod = await import(pathToFileURL(compiled).href);

  await test('cloud HTTP capabilities default to interactive-only until explicitly declared', () => {
    withEnv(undefined, () => {
      assert.deepEqual(
        mod.readSandboxProviderCapabilitiesEnv(
          envName,
          mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        ['terminal.websocket'],
      );
    });
  });

  await test('cloud HTTP capabilities accept an explicit comma-separated subset', () => {
    withEnv(' terminal.websocket, workspace.git.deliver, terminal.websocket ', () => {
      assert.deepEqual(
        mod.readSandboxProviderCapabilitiesEnv(
          envName,
          mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        ['terminal.websocket', 'workspace.git.deliver'],
      );
    });
  });

  await test('cloud HTTP capabilities accept all as an explicit full-capability opt-in', () => {
    withEnv('all', () => {
      assert.deepEqual(
        mod.readSandboxProviderCapabilitiesEnv(
          envName,
          mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        [
          'terminal.websocket',
          'workspace.git.materialize',
          'workspace.git.deliver',
          'transcript.retained-read',
          'lifecycle.readopt',
        ],
      );
    });
  });

  await test('cloud HTTP capabilities fail closed on unknown entries', () => {
    withEnv('terminal.websocket,unknown.capability', () => {
      assert.throws(
        () =>
          mod.readSandboxProviderCapabilitiesEnv(
            envName,
            mod.DEFAULT_CLOUD_HTTP_CAPABILITIES,
          ),
        /unknown sandbox provider capabilities: unknown\.capability/,
      );
    });
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
