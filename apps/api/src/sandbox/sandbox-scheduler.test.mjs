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
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
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

function compileScheduler() {
  const cacheDir = join(repoRoot, 'apps', 'api', 'node_modules', '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const outDir = mkdtempSync(join(cacheDir, 'cap-sandbox-scheduler-'));
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
      '--outDir',
      outDir,
      'apps/api/src/sandbox/sandbox-scheduler.ts',
      'apps/api/src/sandbox/sandbox-provider.port.ts',
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'sandbox-scheduler.js');
  assert(compiled && existsSync(compiled), 'compiled sandbox-scheduler.js exists');
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

const { outDir, compiled } = compileScheduler();

try {
  const mod = await import(pathToFileURL(compiled).href);

  await test('selectSandboxProvider rejects a missing provider', () => {
    assert.throws(
      () => mod.selectSandboxProvider(undefined, ['terminal.websocket']),
      /No sandbox provider is configured/,
    );
  });

  await test('selectSandboxProvider accepts declared providers with required capabilities', () => {
    const provider = {
      getSandboxMode: () => 'workspace-write',
      getProviderCapabilities: () => ['terminal.websocket', 'workspace.git.materialize'],
    };
    const selected = mod.selectSandboxProvider(provider, ['terminal.websocket']);
    assert.equal(selected.provider, provider);
    assert.equal(selected.compatibility, 'declared');
    assert.deepEqual(selected.capabilities, ['terminal.websocket', 'workspace.git.materialize']);
  });

  await test('delivery required capabilities are explicit and operation-scoped', () => {
    assert.deepEqual(mod.DELIVERY_SANDBOX_REQUIRED_CAPABILITIES, ['workspace.git.deliver']);
  });

  await test('operation selectors bind callers to the right capability set', () => {
    const provider = {
      getSandboxMode: () => 'aio',
      getProviderCapabilities: () => [
        'workspace.git.deliver',
        'lifecycle.readopt',
        'transcript.retained-read',
      ],
    };
    assert.equal(mod.selectDeliverySandboxProvider(provider).provider, provider);
    assert.equal(mod.selectReadoptionSandboxProvider(provider).provider, provider);
    assert.equal(mod.selectRetainedTranscriptSandboxProvider(provider).provider, provider);

    const missingDelivery = {
      getSandboxMode: () => 'no-delivery',
      getProviderCapabilities: () => ['lifecycle.readopt', 'transcript.retained-read'],
    };
    assert.throws(
      () => mod.selectDeliverySandboxProvider(missingDelivery),
      /missing required capabilities: workspace\.git\.deliver/,
    );
  });

  await test('provision required capabilities include workspace materialize only when needed', () => {
    assert.deepEqual(
      mod.provisionSandboxRequiredCapabilities({ materializeGitWorkspace: false }),
      ['terminal.websocket'],
    );
    assert.deepEqual(
      mod.provisionSandboxRequiredCapabilities({ materializeGitWorkspace: true }),
      ['terminal.websocket', 'workspace.git.materialize'],
    );
  });

  await test('buildSandboxProvisionPlan carries the selected cloneSpec and requirements together', () => {
    const cloneSpec = { url: 'https://example.test/repo.git' };
    const withWorkspace = mod.buildSandboxProvisionPlan({ cloneSpec });
    assert.equal(withWorkspace.cloneSpec, cloneSpec);
    assert.deepEqual(withWorkspace.requiredCapabilities, [
      'terminal.websocket',
      'workspace.git.materialize',
    ]);

    const withoutWorkspace = mod.buildSandboxProvisionPlan({ cloneSpec: null });
    assert.equal(withoutWorkspace.cloneSpec, null);
    assert.deepEqual(withoutWorkspace.requiredCapabilities, ['terminal.websocket']);
  });

  await test('readoption required capabilities are explicit and operation-scoped', () => {
    assert.deepEqual(mod.READOPTION_SANDBOX_REQUIRED_CAPABILITIES, ['lifecycle.readopt']);
  });

  await test('retained transcript required capabilities are explicit and operation-scoped', () => {
    assert.deepEqual(mod.RETAINED_TRANSCRIPT_SANDBOX_REQUIRED_CAPABILITIES, ['transcript.retained-read']);
  });

  await test('selectSandboxProvider fails closed when a declared provider is missing capabilities', () => {
    const provider = {
      getSandboxMode: () => 'read-only',
      getProviderCapabilities: () => ['workspace.git.materialize'],
    };
    assert.throws(
      () => mod.selectSandboxProvider(provider, ['terminal.websocket', 'workspace.git.deliver']),
      /missing required capabilities: terminal\.websocket, workspace\.git\.deliver/,
    );
  });

  await test('selectSandboxProvider keeps legacy providers compatible when no declaration exists', () => {
    const provider = {
      getSandboxMode: () => 'danger-full-access',
    };
    const selected = mod.selectSandboxProvider(provider, ['terminal.websocket']);
    assert.equal(selected.provider, provider);
    assert.equal(selected.compatibility, 'legacy-assumed');
    assert.deepEqual(selected.capabilities, []);
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
