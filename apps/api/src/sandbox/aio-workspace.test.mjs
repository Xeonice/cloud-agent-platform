import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(apiRoot, '..', '..');
const tscBin = join(repoRoot, 'node_modules', '.bin', 'tsc');
const outDir = mkdtempSync(join(apiRoot, '.aio-workspace-test-'));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function compileWorkspaceHelper() {
  execFileSync(
    tscBin,
    [
      join(__dirname, 'aio-workspace.ts'),
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
  const flat = join(outDir, 'aio-workspace.js');
  if (existsSync(flat)) return flat;
  const found = findFile(outDir, 'aio-workspace.js');
  if (!found) throw new Error('compiled aio-workspace.js not found under ' + outDir);
  return found;
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

function installFetchSequence(results) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const command = JSON.parse(init.body).command;
    calls.push({ url: String(url), command, init });
    const next = results.shift() ?? { exitCode: 0, output: '' };
    if (next.throw) throw next.throw;
    if (next.ok === false) {
      return { ok: false, status: next.status ?? 500, async json() { return {}; } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          data: {
            status: 'completed',
            exit_code: next.exitCode ?? 0,
            output: next.output ?? '',
          },
        };
      },
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

async function main() {
  console.log('\n=== AIO workspace bridge ===\n');
  const mod = await import(pathToFileURL(compileWorkspaceHelper()).href);
  const {
    buildGitCloneCommand,
    deliverGitWorkspaceChanges,
    materializeGitWorkspace,
    parseAioExecResult,
    scrubAioExecSecrets,
  } = mod;

  assert(
    buildGitCloneCommand({ url: 'https://github.com/acme/repo.git' }, '/workspace') ===
      "git clone -- 'https://github.com/acme/repo.git' '/workspace'",
    'clone command without auth shell-quotes dynamic args',
  );
  assert(
    buildGitCloneCommand(
      {
        url: 'https://github.com/acme/private.git',
        authHeader: 'Authorization: Basic abc',
      },
      '/workspace',
    ) ===
      "git -c 'http.extraHeader=Authorization: Basic abc' clone -- 'https://github.com/acme/private.git' '/workspace'",
    'clone command with auth uses http.extraHeader, not URL userinfo',
  );
  assert(
    buildGitCloneCommand(
      { url: "https://github.com/acme/repo.git; touch /tmp/pwn'$(whoami)" },
      "/workspace path/with spaces'; rm -rf /",
    ) ===
      "git clone -- 'https://github.com/acme/repo.git; touch /tmp/pwn'\\''$(whoami)' '/workspace path/with spaces'\\''; rm -rf /'",
    'clone command quotes adversarial URL and workspace inputs',
  );

  const nested = parseAioExecResult({
    data: { exit_code: '7', stderr: 'boom' },
  });
  assert(nested.exitCode === 7 && nested.output === 'boom', 'nested AIO exec result parses exit code + stderr');
  assert(
    Number.isNaN(parseAioExecResult({ data: { output: 'missing code' } }).exitCode),
    'missing AIO exit code stays NaN (fail-closed)',
  );
  assert(
    scrubAioExecSecrets('https://u:p@example.com/x Authorization: Basic secret') ===
      'https://***:***@example.com/x Authorization: Basic ***',
    'AIO exec output scrubber redacts URL userinfo and Basic auth',
  );

  const cloneOk = installFetchSequence([{ exitCode: 0 }]);
  try {
    await materializeGitWorkspace({
      baseUrl: 'http://sandbox',
      taskId: 'task-clone',
      spec: { url: 'https://github.com/acme/repo.git' },
      workspaceDir: '/home/gem/workspace',
    });
    assert(
      cloneOk.calls[0].command ===
        "git clone -- 'https://github.com/acme/repo.git' '/home/gem/workspace'",
      'materializeGitWorkspace issues the expected clone command',
    );
  } finally {
    cloneOk.restore();
  }

  const cloneFail = installFetchSequence([
    { exitCode: 1, output: 'fatal https://u:p@example.com/repo.git Authorization: Basic secret' },
  ]);
  let cloneError = '';
  try {
    await materializeGitWorkspace({
      baseUrl: 'http://sandbox',
      taskId: 'task-fail',
      spec: { url: 'https://github.com/acme/repo.git' },
      workspaceDir: '/home/gem/workspace',
    });
  } catch (err) {
    cloneError = err instanceof Error ? err.message : String(err);
  } finally {
    cloneFail.restore();
  }
  assert(
    cloneError.includes('task-fail') &&
      cloneError.includes('exit_code 1') &&
      cloneError.includes('https://***:***@') &&
      cloneError.includes('Authorization: Basic ***'),
    'materializeGitWorkspace fail-closed error carries task context and scrubbed output',
  );

  const noChanges = installFetchSequence([{ exitCode: 0, output: '' }]);
  try {
    const result = await deliverGitWorkspaceChanges({
      baseUrl: 'http://sandbox',
      taskId: 'task-deliver-clean',
      workspaceDir: '/home/gem/workspace',
      timeoutMs: 10_000,
      deliver: {
        authHeader: 'Authorization: Basic push',
        branch: 'cap/task-clean',
        commitMessage: 'cap: clean',
      },
    });
    assert(result.hadChanges === false && result.error === null, 'delivery returns no_changes for clean porcelain');
    assert(noChanges.calls.length === 1, 'clean delivery stops after git status');
  } finally {
    noChanges.restore();
  }

  const push = installFetchSequence([
    { exitCode: 0, output: ' M file.txt\n' },
    { exitCode: 0 },
    { exitCode: 0 },
    { exitCode: 0, output: 'abc123\n' },
    { exitCode: 0 },
  ]);
  try {
    const result = await deliverGitWorkspaceChanges({
      baseUrl: 'http://sandbox',
      taskId: 'task-deliver',
      workspaceDir: '/home/gem/workspace',
      timeoutMs: 10_000,
      deliver: {
        authHeader: 'Authorization: Basic push',
        branch: 'cap/task-deliver',
        commitMessage: 'cap: deliver',
      },
    });
    assert(result.hadChanges === true && result.commitSha === 'abc123' && result.error === null, 'delivery returns pushed commit sha');
    assert(
      push.calls.some((c) => c.command.includes("commit -F '/tmp/cap-commit-msg'")),
      'delivery writes commit message to a file and commits with -F',
    );
    assert(
      push.calls.some((c) => c.command.includes("-c 'http.extraHeader=Authorization: Basic push' push --force-with-lease")),
      'delivery pushes with http.extraHeader auth',
    );
  } finally {
    push.restore();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    failed++;
  })
  .finally(() => {
    rmSync(outDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  });
