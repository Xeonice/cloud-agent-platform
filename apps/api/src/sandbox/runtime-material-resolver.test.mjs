import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(__dirname);
const apiRoot = join(repoRoot, 'apps', 'api');
const outDir = mkdtempSync(join(apiRoot, '.runtime-material-resolver-test-'));

function findRepoRoot(start) {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not locate repo root from ${start}`);
}

function findFile(root, fileName) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
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

function compile() {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsc',
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--skipLibCheck',
      '--esModuleInterop',
      '--types',
      'node',
      '--outDir',
      outDir,
      'src/sandbox/runtime-material-resolver.ts',
      'src/sandbox/codex-auth-source.port.ts',
      'src/sandbox/claude-auth-source.port.ts',
      'src/agent-runtime/agent-runtime.port.ts',
      'src/settings/assert-safe-provider-url.ts',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const compiled = findFile(outDir, 'runtime-material-resolver.js');
  assert(compiled && existsSync(compiled), 'compiled runtime-material-resolver.js exists');
  return compiled;
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

try {
  const mod = await import(pathToFileURL(compile()).href);

  await test('registry resolves by runtime id and fails closed for unknown runtimes', async () => {
    const registry = new mod.RuntimeMaterialResolverRegistry([
      {
        runtimeId: 'custom-runtime',
        resolve: async ({ taskId }) => ({ authJson: `auth-for-${taskId}` }),
      },
    ]);
    assert.deepEqual(registry.ids(), ['custom-runtime']);
    assert.deepEqual(await registry.resolve({ id: 'custom-runtime' }, {
      taskId: 'task-1',
      ownerUserId: 'owner-1',
    }), {
      authJson: 'auth-for-task-1',
    });
    assert.equal(await registry.resolve({ id: 'missing-runtime' }, {
      taskId: 'task-1',
      ownerUserId: 'owner-1',
    }), null);
    assert.throws(
      () =>
        registry.register({
          runtimeId: 'custom-runtime',
          resolve: async () => null,
        }),
      /already registered/,
    );
  });

  await test('default registry maps owner-scoped codex official material', async () => {
    const received = [];
    const registry = mod.createDefaultRuntimeMaterialResolverRegistry({
      codexAuthSource: {
        async getCodexAuth(taskId) {
          received.push(taskId);
          return { kind: 'official', authJson: '{"auth":true}' };
        },
      },
    });
    assert.deepEqual(await registry.resolve({ id: 'codex' }, {
      taskId: 'task-owner',
      ownerUserId: 'owner-1',
    }), {
      authJson: '{"auth":true}',
    });
    assert.deepEqual(received, ['task-owner']);
  });

  await test('default registry validates compatible-provider URLs before returning material', async () => {
    const warnings = [];
    const source = {
      async getCodexAuth(taskId) {
        return taskId === 'safe'
          ? {
              kind: 'compatible',
              baseUrl: 'https://93.184.216.34/v1',
              apiKey: 'key',
              model: 'model',
            }
          : {
              kind: 'compatible',
              baseUrl: 'http://127.0.0.1:11434/v1',
              apiKey: 'key',
              model: 'model',
            };
      },
    };
    const registry = mod.createDefaultRuntimeMaterialResolverRegistry({
      codexAuthSource: source,
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(await registry.resolve({ id: 'codex' }, {
      taskId: 'safe',
      ownerUserId: 'owner-1',
    }), {
      codexCompatible: {
        baseUrl: 'https://93.184.216.34/v1',
        apiKey: 'key',
        model: 'model',
      },
    });
    assert.equal(await registry.resolve({ id: 'codex' }, {
      taskId: 'unsafe',
      ownerUserId: 'owner-1',
    }), null);
    assert(warnings.some((message) => message.includes('failed host-safety validation')));
  });

  await test('default registry maps claude material and degrades when source is absent', async () => {
    const owners = [];
    const registry = mod.createDefaultRuntimeMaterialResolverRegistry({
      codexAuthSource: { async getCodexAuth() { return null; } },
      claudeAuthSource: {
        async getClaudeAuth(ownerUserId) {
          owners.push(ownerUserId);
          return { oauthToken: 'claude-token' };
        },
      },
    });
    assert.deepEqual(await registry.resolve({ id: 'claude-code' }, {
      taskId: 'task-1',
      ownerUserId: 'owner-1',
    }), {
      oauthToken: 'claude-token',
    });
    assert.deepEqual(owners, ['owner-1']);
    assert.equal(await registry.resolve({ id: 'claude-code' }, {
      taskId: 'task-no-owner',
      ownerUserId: null,
    }), null);
    assert.deepEqual(owners, ['owner-1'], 'missing owner fails before credential lookup');
    const absent = mod.createDefaultRuntimeMaterialResolverRegistry({
      codexAuthSource: { async getCodexAuth() { return null; } },
    });
    assert.equal(await absent.resolve({ id: 'claude-code' }, {
      taskId: 'task-1',
      ownerUserId: 'owner-1',
    }), null);
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
