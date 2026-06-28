import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

function compileProviderFamily() {
  const apiDir = join(repoRoot, 'apps', 'api');
  const cacheDir = join(apiDir, 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outDir = mkdtempSync(join(cacheDir, 'cap-sandbox-provider-family-'));
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
      'src/sandbox/sandbox-provider-family.ts',
    ],
    { cwd: apiDir, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'sandbox-provider-family.js');
  assert(compiled && existsSync(compiled), 'compiled sandbox-provider-family.js exists');
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

const { outDir, compiled } = compileProviderFamily();

try {
  const mod = await import(pathToFileURL(compiled).href);

  await test('normalizes configured provider family and aliases', () => {
    assert.equal(mod.normalizeConfiguredSandboxProviderFamily(undefined), 'auto');
    assert.equal(mod.normalizeConfiguredSandboxProviderFamily(''), 'auto');
    assert.equal(mod.normalizeConfiguredSandboxProviderFamily('aio'), 'aio');
    assert.equal(mod.normalizeConfiguredSandboxProviderFamily('boxlite'), 'boxlite');
    assert.equal(
      mod.normalizeConfiguredSandboxProviderFamily('control-plane-only'),
      'control-plane',
    );
    assert.throws(
      () => mod.normalizeConfiguredSandboxProviderFamily('docker'),
      /invalid CAP_SANDBOX_PROVIDER/,
    );
  });

  await test('explicit provider families constrain eligible providers', () => {
    assert.equal(mod.providerFamilyAllowsAio('aio'), true);
    assert.equal(mod.providerFamilyAllowsBoxLite('aio'), false);
    assert.equal(mod.providerFamilyAllowsAio('boxlite'), false);
    assert.equal(mod.providerFamilyAllowsBoxLite('boxlite'), true);
    assert.equal(mod.providerFamilyAllowsCloudHttp('boxlite'), false);
    assert.equal(mod.providerFamilyAllowsAio('control-plane'), false);
    assert.equal(mod.providerFamilyAllowsBoxLite('control-plane'), false);
    assert.equal(mod.explicitProviderFamilyLabel('boxlite'), 'boxlite');
    assert.equal(mod.explicitProviderFamilyLabel('auto'), undefined);
  });

  await test('auto keeps capability selection family open', () => {
    assert.equal(mod.providerFamilyAllowsAio('auto'), true);
    assert.equal(mod.providerFamilyAllowsBoxLite('auto'), true);
    assert.equal(mod.providerFamilyAllowsCloudHttp('auto'), true);
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
