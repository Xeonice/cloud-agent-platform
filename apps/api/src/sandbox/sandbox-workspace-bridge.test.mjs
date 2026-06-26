import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const src = join(__dirname, 'sandbox-workspace-bridge.ts');

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`ok - ${label}`);
    passed++;
  } else {
    console.error(`not ok - ${label}`);
    failed++;
  }
}

function findFile(dir, filename) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, filename);
      if (found) return found;
    }
  }
  return null;
}

const outDir = mkdtempSync(join(apiRoot, '.sandbox-workspace-bridge-test-'));

function compile() {
  execFileSync(
    tscBin,
    [
      src,
      join(__dirname, 'aio-workspace.ts'),
      join(__dirname, 'sandbox-command-executor.ts'),
      join(__dirname, 'provision-lookup.port.ts'),
      join(__dirname, 'sandbox-provider.port.ts'),
      join(__dirname, 'transcript-source.ts'),
      join(__dirname, '..', 'agent-runtime', 'agent-runtime.port.ts'),
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--moduleResolution',
      'node',
      '--target',
      'ES2021',
      '--esModuleInterop',
      '--skipLibCheck',
    ],
    { cwd: apiRoot, stdio: 'pipe' },
  );
  const flat = join(outDir, 'sandbox-workspace-bridge.js');
  if (existsSync(flat)) return flat;
  const found = findFile(outDir, 'sandbox-workspace-bridge.js');
  if (!found) throw new Error('compiled sandbox-workspace-bridge.js not found');
  return found;
}

function fakeExecutor(results = []) {
  const calls = [];
  return {
    calls,
    executor: {
      async exec(request) {
        calls.push(request);
        return results.shift() ?? {
          exitCode: 0,
          output: '',
          stdout: '',
          stderr: '',
          timedOut: false,
        };
      },
    },
  };
}

try {
  const mod = await import(pathToFileURL(compile()).href);
  const { buildSandboxWorkspaceBridge, resolveSandboxWorkspaceDescriptor } = mod;
  const connection = {
    taskId: 'task-1',
    baseUrl: 'http://aio',
    wsUrl: 'ws://aio/v1/shell/ws',
  };

  const fallback = resolveSandboxWorkspaceDescriptor({ connection });
  assert(fallback.mode === 'git', 'fallback workspace descriptor is git');
  assert(fallback.path === '/home/gem/workspace', 'fallback workspace path is AIO workspace');
  assert(fallback.git?.deliverable === true, 'fallback workspace is deliverable');

  const selectedRun = {
    workspace: {
      mode: 'git',
      path: '/work/custom',
      git: { materialized: true, deliverable: true },
    },
  };
  const selected = resolveSandboxWorkspaceDescriptor({ connection, selectedRun });
  assert(selected.path === '/work/custom', 'selected-run workspace descriptor takes precedence');

  const materialize = fakeExecutor();
  await buildSandboxWorkspaceBridge({
    executor: materialize.executor,
    descriptor: selected,
  }).materializeGit({
    taskId: 'task-1',
    spec: { url: 'https://github.com/acme/repo.git' },
  });
  assert(
    materialize.calls[0].command.includes("'https://github.com/acme/repo.git' '/work/custom'"),
    'git materialization uses descriptor workspace path',
  );

  const deliver = fakeExecutor([
    { exitCode: 0, output: ' M file.txt\n', stdout: '', stderr: '', timedOut: false },
    { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
    { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
    { exitCode: 0, output: 'abc123\n', stdout: '', stderr: '', timedOut: false },
    { exitCode: 0, output: '', stdout: '', stderr: '', timedOut: false },
  ]);
  const delivered = await buildSandboxWorkspaceBridge({
    executor: deliver.executor,
    descriptor: selected,
  }).deliverGit({
    taskId: 'task-1',
    timeoutMs: 10_000,
    deliver: {
      authHeader: 'Authorization: Basic push',
      branch: 'cap/task-1',
      commitMessage: 'cap: task',
    },
  });
  assert(delivered.commitSha === 'abc123', 'git delivery returns commit sha through bridge');
  assert(
    deliver.calls.every((call) => call.timeoutMs === 10_000),
    'git delivery forwards timeout to executor calls',
  );
  assert(
    deliver.calls.some((call) => call.command.includes("git -C '/work/custom'")),
    'git delivery uses descriptor workspace path',
  );

  const archiveBridge = buildSandboxWorkspaceBridge({
    executor: fakeExecutor().executor,
    descriptor: {
      mode: 'archive',
      path: '/archive/workspace',
      archive: { upload: true, download: true },
    },
  });
  let materializeUnsupported = false;
  try {
    await archiveBridge.materializeGit({
      taskId: 'task-archive',
      spec: { url: 'https://github.com/acme/repo.git' },
    });
  } catch (err) {
    materializeUnsupported = /does not support git materialization/.test(
      String(err?.message ?? err),
    );
  }
  assert(materializeUnsupported, 'archive descriptor does not pretend to support git materialization');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
